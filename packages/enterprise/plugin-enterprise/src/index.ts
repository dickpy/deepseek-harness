/**
 * dsh 企业插件
 *
 * 把桌面端 dsh 接入企业管理平台：
 *  1. 设备注册：企业账号凭据 → 设备令牌（存入本地凭据库）
 *  2. 模型下发：拉取企业配置，把 模型地址/Key/模型名 写入
 *     `llm-pi-ai`（OpenAI 兼容路由 `enterprise`）与 `agent-default-model`（默认路由热更新）
 *  3. 会话首页目录：把管理台「首页配置」的一级/二级 tab 写进 `dsh-enterprise`
 *     设置节，客户端插件据此渲染首页
 *  4. 技能下发：把管理台「技能广场」按角色下发的技能落到 `$DSH_HOME/skills/<name>/`，
 *     由 dsh 的技能加载器装载；撤销授权/下线时移除本插件先前落盘的目录。
 *     桌面端「技能广场」的启用/关闭开关写进同一个设置节的 `disabledSkills`，
 *     本插件据此把对应技能文件的 `disable-model-invocation` 调成当前状态——
 *     关闭的技能不进模型可见的技能目录，但 `/技能名` 的显式调用仍然可用。
 *  5. 用量遥测：订阅 session/event 折叠每次模型调用的 token 用量（仅元数据），
 *     攒批上报，不含会话内容
 *
 * 依赖的服务（dsh-base 默认提供）：`settings`、`credentials`。
 *
 * schemastery 经 pnpm override 解析到仓库内置的 vendor/schemastery。
 * 本插件不 import 任何 dsh 包——服务在运行时按 key 注入，类型用最小结构面描述，
 * 以便独立构建与安装（对齐 docs/user/develop/basic/publish.md 的外部插件契约）。
 */

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export interface EnterpriseConfig {
  serverUrl: string
  email: string
  /** 明文密码（可经 patch 的 !!js process.env 注入）；与 passwordEnv 二选一 */
  password: string
  /** 从凭据库/env 读取密码的变量名，默认 DSH_ENTERPRISE_PASSWORD */
  passwordEnv: string
  deviceName: string
  /** 云端配置同步间隔（毫秒） */
  syncIntervalMs: number
  telemetryEnabled: boolean
  /** 同步后是否把云端模型设为 Agent 默认路由 */
  applyDefaultModel: boolean
  /** 是否把管理台下发的技能落到本机 `$DSH_HOME/skills` */
  syncSkills: boolean
}

interface ModelAssignment {
  name: string
  baseUrl: string
  model: string
  apiKey: string
}

/** 管理台下发的技能元数据（正文按需另拉） */
interface SkillSummary {
  name: string
  displayName: string
  description: string | null
  version: string
  /** single = 单个 SKILL.md；bundle = 目录/zip（含附属文件） */
  kind?: 'single' | 'bundle'
  fileCount?: number
}

/** 技能包里的一个附属文件 */
interface SkillBundleFile {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
}

/**
 * 一个技能的完整内容。
 * `content` 是 SKILL.md 全文；若它自身也出现在 `files` 里（zip 导入的包会把
 * 目录内文件原样带上），落盘时优先用 `files` 里的那一份与它的路径。
 */
interface SkillBundle {
  name: string
  version: string
  content: string
  files: SkillBundleFile[]
}

interface CloudConfig {
  model: ModelAssignment | null
  agents: { name: string; version: string; description: string | null; config: Record<string, unknown> }[]
  plugins: { name: string; displayName: string; latestVersion: string; minDesktopVersion: string | null }[]
  user?: { email: string; name: string; role: string | null }
  menus?: string[] | null
  /**
   * 会话首页一级/二级 tab。
   * **缺省** = 平台从没配过一级 tab，客户端回退内置默认目录；
   * **空数组** = 管理员把 tab 都删了，客户端要清空——两者语义不同，必须区分。
   */
  home?: unknown
  /** 配置版本号：管理台「同步到客户端」或内容变化时推进会递增 */
  configRevision?: number
  skills?: SkillSummary[]
  /** 会话首页样例（管理台「首页配置 → 首页样例配置」下发；空数组 = 不显示案例区） */
  examples?: HomeExampleSummary[]
}

/** 管理台下发的一个首页样例（样例图已解析成 data URL） */
interface HomeExampleSummary {
  id: string
  label: string
  summary?: string | null
  prompt: string
  skill?: string | null
  image: string
  artifacts?: { label: string; note?: string }[] | null
  order?: number
}

interface TelemetryEvent {
  type: 'llm_call' | 'tool_run'
  sessionId?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  toolName?: string
  durationMs?: number
  occurredAt?: string
}

/** 运行时按 key 注入的最小服务面（真实实现来自 dsh-base） */
interface EnterpriseCtx {
  settings: {
    update(ns: string, patch: object): Promise<void>
    get(ns: string): unknown
    register(
      ns: string,
      schema: unknown,
      options?: { base?: unknown },
    ): SettingsScopeLike
  }
  inject(names: string[], callback: (ctx: EnterpriseCtx) => void): void
  credentials: {
    resolve(ref: string): Promise<{ value?: string } | undefined>
    set(ref: string, value: string): Promise<void>
  }
  on(name: string, listener: (...args: never[]) => void): unknown
  effect(fn: () => unknown, name?: string): unknown
}

/** 一个命名空间 scope 的最小面：设置桥用 get/replace，技能开关监听用 watch */
interface SettingsScopeLike {
  get(): unknown
  replace(section: object): Promise<void>
  /**
   * 观察该命名空间已提交的变更。可选：老版本 settings 服务没有这个方法，
   * 那时「技能广场」的开关退化成「下一轮云端同步时生效」。
   */
  watch?(callback: (next: unknown, prev: unknown) => void | Promise<void>): () => void
}

const DEVICE_TOKEN_REF = 'DSH_ENTERPRISE_DEVICE_TOKEN'
const MODEL_KEY_REF = 'DSH_ENTERPRISE_MODEL_KEY'
const PLUGIN_NS = 'dsh-enterprise'

const PI_AI_NS = 'llm-pi-ai'
const DEFAULT_MODEL_NS = 'agent-default-model'
const ENTERPRISE_ROUTE = 'enterprise'
const log = (...args: unknown[]) => console.log('[dsh-enterprise]', ...args)

// ---------------------------------------------------------------------------
// 客户端数据桥：把企业会话（用户身份 + 菜单权限）写入 dsh 设置文档的
// `dsh-enterprise` 命名空间，客户端插件经 settingsScope 读取并渲染
// （右下角用户名徽标 / 按 menus 显隐设置入口）。
// ---------------------------------------------------------------------------

const SESSION_SETTINGS_NS = 'dsh-enterprise'

/** 会话首页目录里一个二级 tab 的下发形态（与客户端 home-catalog.ts 对应） */
const homeActionSchema = z.object({
  id: z.string().default(''),
  label: z.string().default(''),
  // 图标是一段短文本（emoji / 单个字形）；空串 = 客户端不显示图标
  icon: z.string().default(''),
  skill: z.string().default(''),
  prompt: z.string().default(''),
})

/** 会话首页目录里一个一级 tab 的下发形态 */
const homeCategorySchema = z.object({
  id: z.string().default(''),
  label: z.string().default(''),
  icon: z.string().default(''),
  actions: z.array(homeActionSchema).default([]),
})

interface SessionSettings {
  serverUrl: string
  user: { email: string; name: string; role: string }
  menus: string[]
  agents: string[]
  plugins: string[]
  /**
   * 技能广场里已发布的技能（元数据，正文在桌面端本机 skills 目录）。
   * 客户端「技能广场」页面直接展示这一份清单，不再需要自己扫盘。
   */
  skills: { name: string; displayName: string; description: string; version: string; kind: string; fileCount: number; installed: boolean }[]
  /**
   * 会话首页样例（输入框下方可换一批的案例区）。
   *
   * 是**数组**而不是可选字段：与 `home` 的三态语义不同，样例没有「内置默认」，
   * 平台没配就是空数组，客户端据此整块不渲染。样例图是 data URL，
   * 所以这份清单的体积随图片走（管理台单张卡 400KB）。
   */
  examples: HomeExampleSummary[]
  /**
   * 用户在桌面端「技能广场」关掉的技能名。
   *
   * 这是**用户本机偏好**，不是云端下发的授权：授权决定「能不能用」，
   * 这个列表决定「模型要不要自动看见」。它由客户端写、host 读——
   * 写成 `publishSession` 会覆盖的字段就必须在这里列出来，
   * 否则每轮云端同步都会把用户的开关重置掉。
   */
  disabledSkills: string[]
  /**
   * 会话首页一级/二级 tab（管理台「首页配置」下发）。
   * 缺省 = 平台从没配置过（客户端用内置默认）；空数组 = 管理员把 tab 都删了。
   */
  home?: unknown[]
  /** 云端配置版本号；管理台点「同步到客户端」时递增 */
  configRevision: number
  lastSyncAt: string
}

const skillSummarySchema = z.object({
  name: z.string().default(''),
  displayName: z.string().default(''),
  description: z.string().default(''),
  version: z.string().default(''),
  kind: z.string().default('single'),
  fileCount: z.number().default(0),
  installed: z.boolean().default(false),
})

/** 首页样例里的「相关产物」 */
const homeExampleArtifactSchema = z.object({
  label: z.string().default(''),
  note: z.string().default(''),
})

/** 一个首页样例的下发形态（与客户端 home-examples.ts 的 HomeExample 对应） */
const homeExampleSchema = z.object({
  id: z.string().default(''),
  label: z.string().default(''),
  summary: z.string().default(''),
  prompt: z.string().default(''),
  skill: z.string().default(''),
  // 样例图是 data URL；空串在下发侧就会被过滤掉（没有图就没有卡片）
  image: z.string().default(''),
  artifacts: z.array(homeExampleArtifactSchema).default([]),
  order: z.number().default(0),
})

const sessionSchema = z.object({
  serverUrl: z.string().default(''),
  user: z.object({
    email: z.string().default(''),
    name: z.string().default(''),
    role: z.string().default(''),
  }),
  menus: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
  skills: z.array(skillSummarySchema).default([]),
  // 客户端「技能广场」的开关写入这里；host 据此过滤模型可见的技能目录。
  // 名字列表（而不是对象）是为了让客户端只需要一次 set/unset 就能落一人份的偏好。
  disabledSkills: z.array(z.string()).default([]),
  // 首页样例：数组语义（没有内置默认），空数组 = 客户端不显示案例区
  examples: z.array(homeExampleSchema).default([]),
  // 首页目录要保住三态，「没配过」必须表现为**字段缺省**（客户端据此回退内置默认），
  // 「配成空」表现为空数组。schemastery 对数组 schema 会把缺省值物化成 `[]`
  // （即使不写 default），`.default(undefined)` 又通不过它的类型，所以用联合：
  // 输入 undefined 时两个分支都落空 → 输出里没有 home 这个键。
  home: z.union([z.array(homeCategorySchema), z.const(undefined)]),
  configRevision: z.number().default(0),
  lastSyncAt: z.string().default(''),
})

async function request<T>(serverUrl: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(20_000),
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(serverUrl.replace(/\/$/, '') + path, init)
  const json = (await res.json().catch(() => ({}))) as T & { message?: string }
  if (!res.ok) throw new Error(`[${res.status}] ${json.message ?? res.statusText}`)
  return json
}

export function normalizeConfig(raw: Record<string, unknown> | undefined): EnterpriseConfig {
  const r = raw ?? {}
  return {
    serverUrl: String(r.serverUrl || 'http://localhost:8080/api/v1').replace(/\/$/, ''),
    email: String(r.email || ''),
    password: String(r.password || ''),
    passwordEnv: String(r.passwordEnv || 'DSH_ENTERPRISE_PASSWORD'),
    deviceName: String(r.deviceName || ''),
    // 默认 60s：管理台改了角色的可见菜单/模型下发后，桌面端要尽快拉到；
    // 5 分钟的旧默认会让管理员以为「没生效」。下限仍是 30s 防止把服务端打满。
    syncIntervalMs: Math.max(30_000, Number(r.syncIntervalMs) || 60_000),
    telemetryEnabled: r.telemetryEnabled !== false,
    applyDefaultModel: r.applyDefaultModel !== false,
    syncSkills: r.syncSkills !== false,
  }
}

/** 设备注册：无令牌时用企业凭据换取设备令牌并存入本地凭据库 */
async function ensureDeviceToken(ctx: EnterpriseCtx, config: EnterpriseConfig): Promise<string> {
  const existing = await ctx.credentials.resolve(DEVICE_TOKEN_REF)
  if (existing?.value) return existing.value

  let password = config.password
  if (!password) {
    const fromStore = await ctx.credentials.resolve(config.passwordEnv)
    password = fromStore?.value ?? process.env[config.passwordEnv] ?? ''
  }
  if (!config.email || !password) {
    throw new Error(
      `尚未注册设备且缺少企业凭据：请设置 DSH_ENTERPRISE_EMAIL / ${config.passwordEnv}（或 $DSH_HOME/.env），` +
        `重启后自动注册。serverUrl=${config.serverUrl}`,
    )
  }

  const result = await request<{ deviceToken: string; config: CloudConfig }>(
    config.serverUrl,
    'POST',
    '/client/enroll',
    {
      email: config.email,
      password,
      deviceName: config.deviceName || hostname(),
      platform: process.platform,
    },
  )
  await ctx.credentials.set(DEVICE_TOKEN_REF, result.deviceToken)
  log('设备注册成功，令牌已存入本地凭据库')
  return result.deviceToken
}

/** 把云端下发的模型配置应用到 llm 路由（settings 热更新，无需重启） */
async function applyModelAssignment(ctx: EnterpriseCtx, model: ModelAssignment): Promise<void> {
  // key 进本地凭据库；适配器只持有变量名引用（credential-ref），不落明文
  await ctx.credentials.set(MODEL_KEY_REF, model.apiKey)
  try {
    await ctx.settings.update(PI_AI_NS, {
      providers: {
        [ENTERPRISE_ROUTE]: {
          displayName: model.name || '企业模型',
          api: 'openai-completions',
          baseURL: model.baseUrl,
          apiKeyEnv: MODEL_KEY_REF,
          models: [{ id: model.model }],
        },
      },
    })
  } catch (e) {
    log(`写入 ${PI_AI_NS} 设置失败（llm-pi-ai 适配器未挂载？）：`, e)
    return
  }
  log(`模型下发已应用：${model.name} → ${model.baseUrl} (${model.model})`)
}

async function sync(ctx: EnterpriseCtx, config: EnterpriseConfig, token: string): Promise<void> {
  const cloud = await request<CloudConfig>(config.serverUrl, 'GET', '/client/config', undefined, token)
  // 首页目录要区分「平台没配过」（字段缺省）与「管理员删空了」（空数组）：
  // 服务端未下发的字段不回写，避免把已下发的目录清掉。
  const homeProvided = Object.hasOwn(cloud, 'home') && Array.isArray(cloud.home)
  const installed = config.syncSkills
    ? await syncSkills(config, token, cloud.skills ?? [])
    : []
  // 开关状态与磁盘对齐：刚下发/刚被重写的技能要把当前开关重新写回去，
  // 用户手动改过的技能文件也在这一轮自愈。开关清单从设置文档现读——
  // `sync` 是模块级函数，拿不到 apply 里那份 scope 句柄。
  if (config.syncSkills && installed.length > 0) {
    const section = ctx.settings.get(SESSION_SETTINGS_NS) as Partial<SessionSettings> | undefined
    await reconcileSkillActivation(
      join(resolveDshHome(), 'skills'),
      installed,
      readDisabledSkills(section),
    ).catch((e: unknown) => { log('技能启用状态对齐失败（下个周期重试）：', e) })
  }
  await publishSessionRef?.({
    user: cloud.user
      ? { email: cloud.user.email, name: cloud.user.name, role: cloud.user.role ?? '' }
      : { email: '', name: '', role: '' },
    menus: cloud.menus ?? [],
    agents: cloud.agents.map(a => `${a.name}@${a.version}`),
    plugins: cloud.plugins.map(p2 => `${p2.name}@${p2.latestVersion}`),
    skills: (cloud.skills ?? []).map(skill => ({
      name: skill.name,
      displayName: skill.displayName || skill.name,
      description: skill.description ?? '',
      version: skill.version,
      kind: skill.kind ?? 'single',
      fileCount: skill.fileCount ?? 0,
      installed: installed.includes(skill.name),
    })),
    // 首页样例：只保留结构性可用的条目（没有 id / 名称 / 样例图的卡片点不出任何东西）。
    // 图片是 data URL，未发布或按角色过滤掉的根本不会出现在这里。
    examples: (cloud.examples ?? [])
      .filter(example => example.id !== '' && example.label !== '' && example.image !== '')
      .map(example => ({
        id: example.id,
        label: example.label,
        summary: example.summary ?? '',
        prompt: example.prompt,
        skill: example.skill ?? '',
        image: example.image,
        artifacts: (example.artifacts ?? [])
          .filter(artifact => artifact.label !== '')
          .map(artifact => ({ label: artifact.label, note: artifact.note ?? '' })),
        order: example.order ?? 0,
      })),
    ...(homeProvided ? { home: cloud.home as unknown[] } : {}),
    configRevision: cloud.configRevision ?? 0,
    lastSyncAt: new Date().toISOString(),
  })
  if (cloud.model) {
    await applyModelAssignment(ctx, cloud.model)
    if (config.applyDefaultModel) {
      try {
        await ctx.settings.update(DEFAULT_MODEL_NS, {
          provider: ENTERPRISE_ROUTE,
          model: cloud.model.model,
        })
        log(`默认模型路由已更新：enterprise / ${cloud.model.model}`)
      } catch (e) {
        log(`写入 ${DEFAULT_MODEL_NS} 设置失败：`, e)
      }
    }
  } else {
    log('云端未为本用户分配模型配置，跳过模型路由更新')
  }
  // 记录最近一次同步的企业配置（供诊断/展示）
  await ctx.settings
    .update(PLUGIN_NS, {
      lastSyncAt: new Date().toISOString(),
      lastAgents: cloud.agents.map(a => `${a.name}@${a.version}`),
      lastPlugins: cloud.plugins.map(p => `${p.name}@${p.latestVersion}`),
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// 技能下发：把管理台「技能广场」按角色下发的技能落到 `$DSH_HOME/skills/<name>/`，
// dsh 的 skill-filesystem 会把它当成本机用户技能装载（含热更新的目录监听）。
//
// 只清理本插件自己落盘的目录：落盘清单 `enterprise-skills.json` 记录了下发过的
// 技能名与版本，用户自己安装的技能永远不在清单里，因此不会被误删。
// ---------------------------------------------------------------------------

/** 落盘清单文件名（位于 `$DSH_HOME`） */
const SKILL_MANIFEST = 'enterprise-skills.json'

/** 技能名语法（与 dsh 的 `isSkillName` 一致）；同时用作目录名，必须先校验 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface SkillManifest {
  version: 1
  /** 技能名 → 已落盘的版本 */
  skills: Record<string, string>
}

/** dsh 主目录：`$DSH_HOME` 优先，缺省 `~/.dsh`（与 dsh 的 home-paths 一致） */
function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // 只有「不存在」会走到这里；权限等其它错误同样按不可用处理，下次同步重试。
    return false
  }
}

async function readSkillManifest(home: string): Promise<SkillManifest> {
  try {
    const parsed = JSON.parse(await readFile(join(home, SKILL_MANIFEST), 'utf8')) as {
      skills?: unknown
    }
    if (typeof parsed?.skills !== 'object' || parsed.skills === null) return { version: 1, skills: {} }
    const skills: Record<string, string> = {}
    for (const [name, version] of Object.entries(parsed.skills as Record<string, unknown>)) {
      if (typeof version === 'string' && SKILL_NAME.test(name)) skills[name] = version
    }
    return { version: 1, skills }
  } catch {
    // 首次运行没有清单，或文件被写坏：都读作「本机还没有下发过技能」，
    // 下次同步会按云端清单重新落盘并覆盖写出清单。
    return { version: 1, skills: {} }
  }
}

async function writeSkillManifest(home: string, manifest: SkillManifest): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, SKILL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** 附属文件路径必须是技能目录内的相对路径（防 `..` 越界写盘） */
function isSafeSkillPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return false
  return path.split(/[\\/]+/).every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * 用下发的技能包重建技能目录（先删后建，保证不残留上一版的文件）。
 *
 * 技能根目录永远是 `$DSH_HOME/skills/<name>/`，SKILL.md 就写在这一层——
 * 管理台在导入 zip 时已经把「技能包最外层目录」剥掉（见 server 的
 * resolveSkillFiles），所以附属文件里出现的相对路径与 SKILL.md 正文里写的
 * 相对路径一致，dsh 的 skill-filesystem 也能把该目录当成一个技能装载。
 *
 * @param skillsRoot - 本机 `$DSH_HOME/skills` 目录。
 * @param bundle - 云端下发的技能包。
 */
async function materializeSkill(skillsRoot: string, bundle: SkillBundle): Promise<void> {
  if (!SKILL_NAME.test(bundle.name)) throw new Error(`技能名不合法，拒绝落盘：${bundle.name}`)
  const directory = join(skillsRoot, bundle.name)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  let skipped = 0
  for (const file of bundle.files ?? []) {
    if (!isSafeSkillPath(file.path)) {
      skipped += 1
      continue
    }
    // 根目录的 SKILL.md 由 bundle.content 统一写（它才是正文的权威来源）；
    // 包内子目录里的 SKILL.md 属于附属资料，原样落盘。
    if (file.path.toLowerCase() === 'skill.md') {
      skipped += 1
      continue
    }
    const target = join(directory, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
  }
  await writeFile(join(directory, 'SKILL.md'), bundle.content, 'utf8')
  if (skipped > 0) log(`技能 ${bundle.name}：跳过 ${skipped} 个未落盘的文件`)
}

/**
 * 把云端技能清单收敛到本机：新增/版本变化的重建，被撤销授权的移除。
 * @param config - 企业插件配置（取 serverUrl 与凭据）。
 * @param token - 设备令牌。
 * @param summaries - 云端下发、已按当前用户角色过滤的技能清单。
 * @returns 本次同步后确认已落盘（SKILL.md 存在）的技能名，供客户端「技能广场」标注安装状态。
 */
async function syncSkills(
  config: EnterpriseConfig,
  token: string,
  summaries: readonly SkillSummary[],
): Promise<string[]> {
  const home = resolveDshHome()
  const skillsRoot = join(home, 'skills')
  const manifest = await readSkillManifest(home)
  const assigned = new Map(summaries.map(summary => [summary.name, summary.version]))
  // 清单只保留仍然授权、且本轮会重新确认的技能；被撤销授权的条目在下面删目录时
  // 一并从清单里消失（不按键删除，清单顺序与逐键 delete 的结果一致）。
  const next: Record<string, string> = Object.fromEntries(
    Object.entries(manifest.skills).filter(([name]) => assigned.has(name)),
  )
  const ready: string[] = []
  let installed = 0

  for (const [name, version] of assigned) {
    if (!SKILL_NAME.test(name)) {
      log(`云端下发了不合法的技能名，已跳过：${name}`)
      continue
    }
    if (manifest.skills[name] === version && (await fileExists(join(skillsRoot, name, 'SKILL.md')))) {
      ready.push(name)
      continue
    }
    try {
      const bundle = await request<SkillBundle>(
        config.serverUrl,
        'GET',
        `/client/skills/${encodeURIComponent(name)}`,
        undefined,
        token,
      )
      await materializeSkill(skillsRoot, { ...bundle, name })
      next[name] = bundle.version || version
      installed += 1
      ready.push(name)
    } catch (e) {
      // 单个技能下载/落盘失败不该拖垮整轮同步：其余技能照常下发，下个周期重试这一个
      log(`技能 ${name} 落盘失败（下个周期重试）：`, e)
    }
  }

  let removed = 0
  for (const name of Object.keys(manifest.skills)) {
    if (assigned.has(name)) continue
    await rm(join(skillsRoot, name), { recursive: true, force: true })
    removed += 1
  }

  // 清单按需写出：首次同步（本机还没有清单）与任何增删都会落盘，稳定期不重复写文件
  if (JSON.stringify(next) !== JSON.stringify(manifest.skills)) {
    await writeSkillManifest(home, { version: 1, skills: next })
    log(`技能下发完成：更新 ${installed} 个，移除 ${removed} 个（目录 ${skillsRoot}）`)
  }
  return ready
}

/** 设置文档桥的发布函数（apply 内注入）；sync 流程调用它把会话数据推给客户端 */
let publishSessionRef: ((session: Partial<SessionSettings>) => Promise<void>) | null = null

// ---------------------------------------------------------------------------
// 技能启用/关闭：把桌面端「技能广场」的开关落到技能文件的 frontmatter 上
//
// 为什么不是「注册一个过滤 provider」：技能注册表把同层各 provider 的候选**合并**，
// 一个 provider 不列出某个名字，另一个（`skill-filesystem`）照样列得出来；
// provider 之间又读不到彼此的候选，所以「并列注册一个过滤器」在结构上做不到减法。
// 能同时满足两条要求的地方是技能文件自己：dsh 的装载契约里
// `disable-model-invocation: true` 让技能**不进模型可见的技能目录**，
// 而 `/技能名` 的显式调用仍按名字加载正文——正好就是
// 「关闭 = 模型不自动挑它，用户仍可显式调用」。
//
// 开关落在 `$DSH_HOME/skills/<name>/SKILL.md`，也就是插件自己下发的那个目录。
// 目录被 `skill-filesystem` 监听，改完即时生效；云端同步也不会把它冲掉——
// `syncSkills` 只在「版本变了或 SKILL.md 不存在」时重写文件，而我们每轮同步后
// 还会按当前开关把这一行重新对齐一次（见 reconcileSkillActivation）。
// ---------------------------------------------------------------------------

/** 关闭时写进 frontmatter 的键（dsh 装载契约里的标准字段） */
const DISABLE_MODEL_KEY = 'disable-model-invocation'

/**
 * 按当前开关把某个技能的 frontmatter 调成该有的样子。
 *
 * 只碰这一个键：frontmatter 其余内容与正文原样保留（用户可能手改过技能里的其它内容）。
 * frontmatter 结构异常时**不写**——宁可开关不生效，也不能把一份技能改坏到装载不了。
 *
 * @param skillsRoot - 本机 `$DSH_HOME/skills` 目录。
 * @param name - 技能名。
 * @param disabled - true = 关闭（模型不可自动调用）。
 * @returns 是否真的改了文件。
 */
async function applySkillActivation(skillsRoot: string, name: string, disabled: boolean): Promise<boolean> {
  const file = join(skillsRoot, name, 'SKILL.md')
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch {
    return false // 本机没有这个技能（还没下发或已被移除），没有可改的东西
  }
  const next = withModelInvocation(content, disabled)
  if (next === null || next === content) return false
  await writeFile(file, next, 'utf8')
  return true
}

/**
 * 返回把 `disable-model-invocation` 调成指定状态后的 SKILL.md 全文。
 *
 * 关闭时把该键写在 frontmatter 末尾，开启时把它删掉；
 * 其余行（含缩进的嵌套结构）一概不动。
 *
 * @param content - 当前 SKILL.md 全文。
 * @param disabled - true = 需要写入该键；false = 需要删掉该键。
 * @returns 新全文；结构不符（首行不是 `---`、没有闭合行）时返回 null。
 */
function withModelInvocation(content: string, disabled: boolean): string | null {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(newline)
  const first = lines[0]
  if (first === undefined || first.replace(/\r$/, '') !== '---') return null
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.replace(/\r$/, '') === '---') { closing = index; break }
  }
  if (closing < 0) return null

  const kept: string[] = []
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index]
    // `lines` 在这个区间里必定有值（closing 是从同一个数组里找出来的下标）
    if (line === undefined) continue
    // 只按顶层键匹配：缩进过的同名键属于嵌套结构，不动它
    if (/^disable-model-invocation\s*:/i.test(line)) continue
    kept.push(line)
  }
  if (disabled) kept.push(`${DISABLE_MODEL_KEY}: true`)
  return [first, ...kept, ...lines.slice(closing)].join(newline)
}

/**
 * 把设置里的开关状态与磁盘上的技能文件对齐。
 *
 * 两个触发点：客户端写设置后 `watch` 立即回调（开关点下去就生效），
 * 以及每轮云端同步之后（自愈：用户手动改过技能文件、或技能刚被重新下发）。
 *
 * @param skillsRoot - 本机 `$DSH_HOME/skills` 目录。
 * @param assigned - 授权到本机、且已确认落盘的技能名。
 * @param disabled - 用户关掉的技能名。
 * @returns 实际改写的文件数。
 */
async function reconcileSkillActivation(
  skillsRoot: string,
  assigned: readonly string[],
  disabled: ReadonlySet<string>,
): Promise<number> {
  let changed = 0
  for (const name of assigned) {
    if (!SKILL_NAME.test(name)) continue
    try {
      if (await applySkillActivation(skillsRoot, name, disabled.has(name))) changed += 1
    } catch (e) {
      log(`技能 ${name} 的启用状态写入失败：`, e)
    }
  }
  if (changed > 0) log(`技能启用状态已同步：更新 ${changed} 个技能文件`)
  return changed
}

/**
 * 观察「技能广场」开关设置，把变化即时落到技能文件上。
 *
 * 设置桥由另一条 inject 回调安装，可能晚于本函数，所以 scope 是现取的。
 * 设置服务没有 `watch` 时静默跳过：开关仍然会在下一轮同步（默认 60s）生效。
 *
 * @param getScope - 现取设置桥 scope。
 */
function watchSkillActivation(getScope: () => SettingsScopeLike | null): void {
  const scope = getScope()
  if (scope?.watch === undefined) {
    log('设置服务未提供 watch，「技能广场」开关将在下一轮云端同步时生效')
    return
  }
  scope.watch((next) => {
    const value = next as Partial<SessionSettings> | undefined
    const assigned = (value?.skills ?? []).filter(skill => skill.installed).map(skill => skill.name)
    return reconcileSkillActivation(
      join(resolveDshHome(), 'skills'),
      assigned,
      readDisabledSkills(value),
    ).then(() => undefined)
  })
}

/**
 * 从设置节里读出用户关掉的技能名。
 * @param value - 设置节（可能尚未就绪）。
 * @returns 合法的 kebab-case 技能名集合。
 */
function readDisabledSkills(value: Partial<SessionSettings> | null | undefined): ReadonlySet<string> {
  const list = value?.disabledSkills
  if (!Array.isArray(list)) return new Set()
  return new Set(list.filter((name): name is string => typeof name === 'string' && SKILL_NAME.test(name)))
}

/** 用量折叠：request/header 记录当前路由，assistant/message 携带 token 账目 */
class UsageFolder {
  private lastModel = new WeakMap<object, string>()

  constructor(private push: (event: TelemetryEvent) => void) {}

  handle(session: object, event: { type?: string; data?: Record<string, unknown> }): void {
    if (event?.type === 'request/header') {
      const header = event.data?.header as { config?: { provider?: string; model?: string } } | undefined
      if (header?.config?.model) this.lastModel.set(session, header.config.model)
      return
    }
    if (event?.type === 'assistant/message') {
      const usage = event.data?.usage as
        | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
        | undefined
      if (!usage) return
      const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      const telemetry: TelemetryEvent = {
        type: 'llm_call',
        inputTokens: input,
        outputTokens: usage.outputTokens ?? 0,
        occurredAt: new Date().toISOString(),
      }
      const sessionId = (session as { id?: string }).id
      if (sessionId !== undefined) telemetry.sessionId = sessionId
      const model = this.lastModel.get(session)
      if (model !== undefined) telemetry.model = model
      this.push(telemetry)
    }
  }
}

class TelemetryBuffer {
  private queue: TelemetryEvent[] = []
  private sending = false

  constructor(
    private readonly serverUrl: string,
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  push(event: TelemetryEvent): void {
    this.queue.push(event)
    if (this.queue.length >= 20) void this.flush()
  }

  async flush(): Promise<void> {
    if (this.sending || this.queue.length === 0) return
    const token = await this.getToken()
    if (!token) return
    this.sending = true
    const batch = this.queue.splice(0, 500)
    try {
      await request(this.serverUrl, 'POST', '/client/telemetry', { events: batch }, token)
    } catch (e) {
      this.queue.unshift(...batch)
      log('遥测上报失败（将随下个周期重试）：', e)
    } finally {
      this.sending = false
    }
  }

  start(): ReturnType<typeof setInterval> {
    const timer = setInterval(() => void this.flush(), 30_000)
    ;(timer as { unref?: () => void }).unref?.()
    return timer
  }
}

/**
 * Cordis 插件入口。
 * 服务 key（settings / credentials）由 Loader 按 inject 解析，dsh-base 默认提供。
 */
export const name = 'dsh-enterprise'
export const inject = ['settings', 'credentials']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any, rawConfig: Record<string, unknown>): void {
  const config = normalizeConfig(rawConfig)
  const enterpriseCtx = ctx as EnterpriseCtx

  let timer: ReturnType<typeof setInterval> | null = null
  let syncTimer: ReturnType<typeof setInterval> | null = null
  // 设置文档桥：客户端从这里读企业身份与菜单
  let sessionScope: { replace(section: object): Promise<void>; get(): unknown } | null = null

  const publishSession = async (session: Partial<SessionSettings>): Promise<void> => {
    if (sessionScope === null) return
    const current = (sessionScope.get() as Partial<SessionSettings>) ?? {}
    // `home` 缺省 = 这次同步没带首页目录（平台没配置过），保留上一份；
    // 带了空数组 = 管理员把 tab 都删了，必须原样写下去。
    const home = Object.hasOwn(session, 'home') ? session.home : current.home
    const section = {
      serverUrl: session.serverUrl ?? current.serverUrl ?? config.serverUrl,
      user: session.user ?? current.user ?? { email: '', name: '', role: '' },
      menus: session.menus ?? current.menus ?? [],
      agents: session.agents ?? current.agents ?? [],
      plugins: session.plugins ?? current.plugins ?? [],
      skills: session.skills ?? current.skills ?? [],
      // `replace` 会整段覆盖用户层，所以客户端写的开关必须原样带回：
      // 漏掉这一行，用户每关一个技能都会在下一次云端同步（默认 60s）被打开。
      disabledSkills: session.disabledSkills ?? current.disabledSkills ?? [],
      // 首页样例是平台下发的内容（客户端只读），本轮回没带就保留上一份
      examples: session.examples ?? current.examples ?? [],
      ...(home === undefined ? {} : { home }),
      configRevision: session.configRevision ?? current.configRevision ?? 0,
      lastSyncAt: session.lastSyncAt ?? new Date().toISOString(),
    } satisfies SessionSettings
    // register 的登记在 settings 服务侧异步生效；首个同步请求可能在生效前返回，
    // 对「not registered」做有界重试而不是丢掉这次会话写入。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await sessionScope.replace(section)
        return
      } catch (e) {
        if (attempt >= 9 || !String(e).includes('not registered')) {
          log('写入客户端会话设置失败：', e)
          return
        }
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
    }
  }

  publishSessionRef = publishSession

  enterpriseCtx.inject(['settings'], (settingsCtx: EnterpriseCtx) => {
    try {
      // register 返回命名空间 scope（get/replace）；installSection 是「可选设置消费者」
      // 专用 API（必填 setSource/onChange hooks、无返回值），不适用于插件自持有命名空间。
      sessionScope = settingsCtx.settings.register(
        SESSION_SETTINGS_NS,
        sessionSchema,
        {
          base: {
            serverUrl: config.serverUrl,
            user: { email: '', name: '', role: '' },
            menus: [],
            agents: [],
            plugins: [],
            skills: [],
            disabledSkills: [],
            examples: [],
            configRevision: 0,
            lastSyncAt: '',
          },
        },
      )
      void publishSession({})
      watchSkillActivation(() => sessionScope)
    } catch (e) {
      log('安装 dsh-enterprise 设置节失败：', e)
    }
  })

  const bootstrap = async (serviceCtx: EnterpriseCtx) => {
    try {
      const token = await ensureDeviceToken(serviceCtx, config)
      await sync(serviceCtx, config, token)

      if (config.telemetryEnabled) {
        // 令牌每次 flush 时现读凭据库（吊销/重注册即时生效）
        const getToken = async () => (await serviceCtx.credentials.resolve(DEVICE_TOKEN_REF))?.value
        const buffer = new TelemetryBuffer(config.serverUrl, getToken)
        const folder = new UsageFolder(event => buffer.push(event))
        serviceCtx.on('session/event', ((session: object, event: { type?: string; data?: Record<string, unknown> }) => {
          folder.handle(session, event)
        }) as never)
        serviceCtx.on('session/flush', (() => void buffer.flush()) as never)
        timer = buffer.start()
        log('用量遥测已启用（仅元数据：token / 模型名 / 工具名，不含会话内容）')
      }

      syncTimer = setInterval(() => {
        void (async () => {
          try {
            const t = await serviceCtx.credentials.resolve(DEVICE_TOKEN_REF)
            if (t?.value) await sync(serviceCtx, config, t.value)
          } catch (e) {
            log('云端同步失败（下个周期重试）：', e)
          }
        })()
      }, config.syncIntervalMs)
      ;(syncTimer as { unref?: () => void }).unref?.()

      log(`企业插件启动完成：serverUrl=${config.serverUrl}，同步间隔 ${Math.round(config.syncIntervalMs / 1000)}s`)
    } catch (e) {
      log('启动失败：', e)
      log('插件保持挂载，将在下次重启或手动重载时重试')
    }
  }

  // bootstrap 必须等注入服务就绪：apply 直接收到的 ctx 在 fiber start 完成前
  // 访问 credentials/settings 会抛「inactive context」，ctx.inject 回调拿到的才是可用服务面。
  enterpriseCtx.inject(['settings', 'credentials'], (serviceCtx: EnterpriseCtx) => {
    void bootstrap(serviceCtx)
  })

  ctx.effect(() => () => {
    if (timer) clearInterval(timer)
    if (syncTimer) clearInterval(syncTimer)
  }, 'dsh-enterprise:cleanup')
}
