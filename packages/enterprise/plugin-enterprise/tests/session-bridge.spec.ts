/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-base-to-string -- fork test uses structural Host doubles */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../src/index.ts'

/**
 * The enterprise plugin's two client-facing bridges, driven through its real
 * `apply` entry with a fake Cordis context: the `dsh-enterprise` settings
 * section the browser half reads, and the skill bundle it writes to
 * `$DSH_HOME/skills`.
 *
 * `fetch` is the only stubbed boundary; the payloads below are the server
 * contract from `server/src/client/client.module.ts`.
 */

const HOME = [
  {
    id: 'general',
    label: '通用助手',
    icon: '💡',
    actions: [
      { id: 'docs', label: '文档处理', icon: '📄', skill: 'doc-polish', prompt: '帮我整理并润色这份文档：' },
      { id: 'minutes', label: '会议纪要', prompt: '帮我把以下会议记录整理成纪要：' },
    ],
  },
]

const SKILL_BUNDLE = {
  name: 'doc-polish',
  version: '1.2.0',
  content: '---\nname: doc-polish\ndescription: 整理并润色中文文档\n---\n\n正文说明。\n',
  files: [{ path: 'references/style.md', content: '文风约定：简体中文。', encoding: 'utf8' }],
}

/** 第二个技能：带二进制附属文件，验证 zip 导入的技能包按 base64 原样落盘 */
const BUNDLE_SKILL = {
  name: 'meeting-minutes',
  version: '2.0.0',
  content: '---\nname: meeting-minutes\ndescription: 整理会议记录\n---\n\n正文说明。\n',
  files: [
    { path: 'scripts/format.py', content: 'print("format")\n', encoding: 'utf8' },
    { path: 'assets/icon.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), encoding: 'base64' },
  ],
}

const CLOUD_CONFIG = {
  model: null,
  agents: [],
  plugins: [],
  user: { email: 'dev@company.com', name: '开发者', role: 'member' },
  menus: ['workspace.chat'],
  home: HOME,
  configRevision: 7,
  skills: [
    { name: 'doc-polish', displayName: '文档润色', description: '整理并润色', version: '1.2.0' },
    {
      name: 'meeting-minutes',
      displayName: '会议纪要',
      description: '整理会议记录',
      version: '2.0.0',
      kind: 'bundle',
      fileCount: 2,
    },
  ],
  // 首页样例：图片是 data URL（最小 1x1 PNG），桌面端直接塞进 <img src>
  examples: [
    {
      id: 'ex-1',
      label: '年度数据报告',
      summary: '交互式年度数据报告',
      prompt: '请生成一个交互式年度数据报告单页',
      skill: 'doc-polish',
      image: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`,
      artifacts: [{ label: '年度数据报告.html', note: '单文件' }],
      order: 0,
    },
    // 没有图片的样例在下发侧就会被丢掉（卡片点不出任何东西）
    { id: 'ex-broken', label: '缺图', prompt: 'x', image: '' },
  ],
}

/** The published section as the browser half reads it. */
interface PublishedSection {
  user: { email: string; name: string; role: string }
  menus: string[]
  /**
   * 首页目录：字段缺省 = 平台没配置过（客户端用内置默认），
   * 空数组 = 管理员把 tab 删空了，有值 = 按配置渲染。
   */
  home?: {
    id: string
    label: string
    icon: string
    actions: { id: string; label: string; icon: string; skill: string; prompt: string }[]
  }[]
  skills: {
    name: string
    displayName: string
    description: string
    version: string
    kind: string
    fileCount: number
    installed: boolean
  }[]
  /** 用户在桌面端「技能广场」关掉的技能名（客户端写、host 读） */
  disabledSkills: string[]
  /** User-uploaded skill bundles written to local disk by the host. */
  userSkills?: {
    name: string
    version: string
    files: { path: string; content: string; encoding: string }[]
    installed: boolean
  }[]
  /** User-defined MCP connectors mounted dynamically by the host. */
  connectors?: {
    name: string
    transport: string
    command: string
    args: string[]
    env: Record<string, string>
    url: string
    headers: Record<string, string>
    enabled: boolean
  }[]
  /** 首页样例（管理台「首页样例配置」下发；空数组 = 客户端不显示案例区） */
  examples: {
    id: string
    label: string
    summary: string
    prompt: string
    skill: string
    image: string
    artifacts: { label: string; note: string }[]
    order: number
  }[]
  configRevision: number
}

/** One registered settings namespace, as the real settings service hands it back. */
interface RegisteredNamespace {
  schema: (value?: unknown) => unknown
  base: unknown
  section: () => PublishedSection | undefined
  /** 真实 settings 服务把已提交的变更推给注册者；这里用同一条路径驱动技能开关。 */
  update: (patch: object) => Promise<void>
}

function live<T>(value: T | { get(): T }): T {
  return typeof value === 'object' && value !== null && 'get' in value ? value.get() : value
}

function endpointOf(input: unknown): string {
  return new URL(String(input)).pathname
}

function createFakeContext() {
  const stored: Record<string, unknown> = {}
  const credentials = new Map<string, string>()
  const namespaces: Record<string, RegisteredNamespace> = {}
  /** 每个命名空间的观察者：注册者用 watch 订阅（技能开关的即时生效走这条路径）。 */
  const watchers: Record<string, ((next: unknown, prev: unknown) => void | Promise<void>)[]> = {}
  const pluginCalls: { plugin: unknown; config: unknown; dispose: ReturnType<typeof vi.fn> }[] = []
  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let rawConfig: Record<string, unknown> | undefined

  const settings = {
    attachConfig(config: Record<string, unknown>): void { rawConfig = config },
    async update(ns: string, patch: object) {
      const current = { ...(stored[ns] as object ?? {}), ...patch }
      stored[ns] = current
      if (ns === 'dsh-enterprise' && rawConfig !== undefined) Object.assign(rawConfig, patch)
      for (const listener of eventListeners.get('loader/volatile-update') ?? []) listener()
      namespaces[ns] = {
        schema: value => Config(value ?? {}),
        base: undefined,
        section: () => stored[ns] as PublishedSection,
        update: async (next: object) => {
          stored[ns] = { ...(stored[ns] as object ?? {}), ...next }
          if (ns === 'dsh-enterprise' && rawConfig !== undefined) Object.assign(rawConfig, next)
          for (const listener of eventListeners.get('loader/volatile-update') ?? []) listener()
        },
      }
    },
    get(ns: string) {
      return stored[ns]
    },
    register(ns: string, schema: (value?: unknown) => unknown, options?: { base?: unknown }) {
      const commit = (section: object): unknown => {
        const prev = stored[ns]
        const next = schema(section)
        stored[ns] = next
        for (const watcher of watchers[ns] ?? []) void watcher(next, prev)
        return next
      }
      namespaces[ns] = {
        schema,
        base: options?.base,
        section: () => stored[ns] as PublishedSection,
        update: async (patch: object) => { commit({ ...(stored[ns] as object ?? {}), ...patch }) },
      }
      return {
        async replace(section: object) {
          commit(section)
        },
        async update(patch: object) {
          commit({ ...(stored[ns] as object ?? {}), ...patch })
        },
        get: () => stored[ns],
        watch(callback: (next: unknown, prev: unknown) => void | Promise<void>) {
          const list = (watchers[ns] ??= [])
          list.push(callback)
          return () => {
            watchers[ns] = (watchers[ns] ?? []).filter(entry => entry !== callback)
          }
        },
      }
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    settings,
    credentials: {
      async resolve(ref: string) {
        return credentials.has(ref) ? { value: credentials.get(ref) } : undefined
      },
      async set(ref: string, value: string) {
        credentials.set(ref, value)
      },
    },
    inject(_names: string[], callback: (scoped: unknown) => void) {
      callback(ctx)
    },
    async plugin(plugin: unknown, config?: unknown) {
      const dispose = vi.fn(async () => undefined)
      pluginCalls.push({ plugin, config, dispose })
      return { dispose }
    },
    on(name: string, listener: (...args: unknown[]) => void) {
      const listeners = eventListeners.get(name) ?? new Set()
      listeners.add(listener)
      eventListeners.set(name, listeners)
      return () => { listeners.delete(listener) }
    },
    effect() {},
  }

  return { ctx, namespaces, pluginCalls, settings }
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, attempts = 200): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
  throw new Error('timed out waiting for the plugin to publish')
}

async function startPlugin(overrides: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-enterprise-spec-'))
  process.env.DSH_HOME = home
  const runtimeDir = join(home, 'dsh-runtimes', 'dsh-primary-runtime')
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(join(runtimeDir, 'runtime.json'), JSON.stringify({ desktopVersion: '0.0.6' }), 'utf8')
  const fake = createFakeContext()
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const path = endpointOf(input)
    if (path.endsWith('/client/enroll')) {
      return new Response(JSON.stringify({ deviceToken: 'dtk_spec', config: CLOUD_CONFIG }), { status: 201 })
    }
    if (path.endsWith('/client/device-info')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (path.endsWith('/client/config')) {
      return new Response(JSON.stringify(CLOUD_CONFIG), { status: 200 })
    }
    if (path.endsWith('/client/skills/doc-polish')) {
      return new Response(JSON.stringify(SKILL_BUNDLE), { status: 200 })
    }
    if (path.endsWith('/client/skills/meeting-minutes')) {
      return new Response(JSON.stringify(BUNDLE_SKILL), { status: 200 })
    }
    throw new Error(`unexpected request: ${String(input)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const config = {
    serverUrl: 'http://enterprise.test/api/v1',
    email: 'dev@company.com',
    password: 'Passw0rd!123',
    deviceName: 'spec',
    syncIntervalMs: 3600_000,
    telemetryEnabled: false,
    applyDefaultModel: false,
    // Only the skill test opts in: a sync in flight when the stub is removed
    // would reach the real network, so each test drives exactly one bridge.
    syncSkills: false,
    ...overrides,
  }
  fake.settings.attachConfig(config)
  apply(fake.ctx, config)

  // Registration publishes an empty section before the first sync resolves, so
  // wait for the synced identity rather than for the section to merely exist.
  const namespace = await waitFor(() => {
    const section = fake.namespaces['dsh-enterprise']?.section()
    return section?.user?.email === '' ? undefined : section
  })
  return {
    home,
    fetchMock,
    namespace,
    registered: fake.namespaces['dsh-enterprise'] as RegisteredNamespace,
    pluginCalls: fake.pluginCalls,
  }
}

describe('enterprise plugin client bridges', () => {
  const homes: string[] = []

  beforeEach(() => {
    homes.length = 0
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(homes.map(path => rm(path, { recursive: true, force: true })))
  })

  it('normalizes the published home catalog through the registered settings schema', async () => {
    const { home, registered } = await startPlugin()
    homes.push(home)

    // A home action's absent skill/prompt normalize to empty strings; the browser
    // half drops those while decoding, so an action without either stays label-only.
    const resolved = registered.schema({ ...registered.base as object, home: HOME }) as PublishedSection
    expect(live(resolved.home)).toEqual([
      {
        id: 'general',
        label: '通用助手',
        icon: '💡',
        actions: [
          { id: 'docs', label: '文档处理', icon: '📄', skill: 'doc-polish', prompt: '帮我整理并润色这份文档：' },
          // 没配图标的二级 tab 收敛成空串（客户端据此不渲染图标节点）
          { id: 'minutes', label: '会议纪要', icon: '', skill: '', prompt: '帮我把以下会议记录整理成纪要：' },
        ],
      },
    ])

    // 首页目录的三态必须在 schema 层就分得开：字段缺省 ≠ 空数组。
    // 缺省 = 平台没配置过（客户端回退内置默认），空数组 = 管理员删空了。
    // 这条约束靠 `z.array(...).default(undefined)` 保住：schemastery 对数组
    // schema 会默认物化 `[]`，只写 `z.array(...)` 会把两种语义又抹成一种。
    expect(live((registered.schema({ ...registered.base as object, home: [] }) as PublishedSection).home)).toEqual([])
    expect(live((registered.schema(registered.base) as PublishedSection).home)).toBeUndefined()
  })

  it('publishes the section the browser half reads, menus included', async () => {
    const { home, namespace } = await startPlugin()
    homes.push(home)

    expect(namespace.menus).toEqual(['workspace.chat'])
    expect(namespace.home?.[0]?.label).toBe('通用助手')
    expect(namespace.home?.[0]?.actions[0]).toMatchObject({ label: '文档处理', skill: 'doc-polish' })
    // 技能清单进设置节，供桌面端「技能广场」渲染卡片；kind/fileCount 缺省时收敛为单文件技能
    expect(namespace.skills).toEqual([
      {
        name: 'doc-polish',
        displayName: '文档润色',
        description: '整理并润色',
        version: '1.2.0',
        kind: 'single',
        fileCount: 0,
        installed: false,
      },
      {
        name: 'meeting-minutes',
        displayName: '会议纪要',
        description: '整理会议记录',
        version: '2.0.0',
        kind: 'bundle',
        fileCount: 2,
        installed: false,
      },
    ])
    expect(namespace.configRevision).toBe(7)
  })

  it('publishes the home examples with their images and drops unusable entries', async () => {
    const { home, namespace, registered } = await startPlugin()
    homes.push(home)

    // 没有 id/名称/样例图的条目在 host 侧就被过滤掉：卡片点不出任何东西，
    // 下发只会白白占据设置文档的体积（图片是 data URL，体积随图片线性走）。
    expect(namespace.examples.map(example => example.id)).toEqual(['ex-1'])
    const example = namespace.examples[0]
    expect(example?.label).toBe('年度数据报告')
    expect(example?.skill).toBe('doc-polish')
    expect(example?.image.startsWith('data:image/png;base64,')).toBe(true)
    expect(example?.artifacts).toEqual([{ label: '年度数据报告.html', note: '单文件' }])

    // 样例是平台下发的内容，客户端只读：再走一轮同步（replace 整段用户层）时
    // 必须原样保留——被清空的话用户会看到案例区莫名消失。
    await registered.update({ lastSyncAt: new Date().toISOString() })
    expect(namespace.examples.map(entry => entry.id)).toEqual(['ex-1'])
  })

  it('marks skills the sync actually wrote to disk as installed', async () => {
    const { home, namespace } = await startPlugin({ syncSkills: true })
    homes.push(home)

    // 同步是异步的：等两个技能都落盘，再确认客户端读到的清单把 installed 标对了
    await waitFor(() => (existsSync(join(home, 'enterprise-skills.json')) ? true : undefined))
    const installed = await waitFor(() =>
      namespace.skills.every(skill => skill.installed) ? namespace : undefined)
    expect(installed.skills.map(skill => skill.name)).toEqual(['doc-polish', 'meeting-minutes'])
    expect(installed.skills.every(skill => skill.installed)).toBe(true)
  })

  it('leaves skills outside the delivered set unmarked when sync is off', async () => {
    const { home, namespace } = await startPlugin({ syncSkills: false })
    homes.push(home)

    // 不下发技能时清单仍在（桌面端要能列出「没装」的技能），但一个都不该标已安装
    expect(namespace.skills.map(skill => skill.name)).toEqual(['doc-polish', 'meeting-minutes'])
    expect(namespace.skills.some(skill => skill.installed)).toBe(false)
  })

  it('materializes assigned skills under $DSH_HOME/skills and records the manifest', async () => {
    const { home } = await startPlugin({ syncSkills: true })
    homes.push(home)

    // The manifest is written after the skill directory, so its arrival is the
    // completion signal for the whole sync.
    const manifestPath = join(home, 'enterprise-skills.json')
    await waitFor(() => (existsSync(manifestPath) ? true : undefined))
    expect(await readFile(join(home, 'skills', 'doc-polish', 'SKILL.md'), 'utf8')).toContain('name: doc-polish')
    expect(await readFile(join(home, 'skills', 'doc-polish', 'references', 'style.md'), 'utf8'))
      .toContain('简体中文')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { skills: Record<string, string> }
    expect(manifest.skills).toEqual({ 'doc-polish': '1.2.0', 'meeting-minutes': '2.0.0' })
    // 二进制附属文件按 base64 原样落盘（zip 技能包里的图片、字体等）
    expect(await readFile(join(home, 'skills', 'meeting-minutes', 'assets', 'icon.png')))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await readFile(join(home, 'skills', 'meeting-minutes', 'scripts', 'format.py'), 'utf8'))
      .toContain('print("format")')
  })

  it('never requests a skill bundle when skill sync is disabled', async () => {
    const { home, fetchMock } = await startPlugin({ syncSkills: false })
    homes.push(home)

    expect(fetchMock.mock.calls.map(call => endpointOf(call[0])))
      .not.toContain('/api/v1/client/skills/doc-polish')
    const deviceInfo = fetchMock.mock.calls.find(call => endpointOf(call[0]) === '/api/v1/client/device-info')
    expect(deviceInfo).toBeDefined()
    expect(JSON.parse(String(deviceInfo?.[1]?.body))).toMatchObject({
      installationId: expect.any(String),
      clientVersion: '0.0.6',
    })
    expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(existsSync(join(home, 'enterprise-skills.json'))).toBe(false)
  })
})

/**
 * 「技能广场」开关的实际效果：关闭某个技能后，对应技能文件的
 * `disable-model-invocation` 必须被写上（模型不再自动调用它），
 * 而技能目录与正文原样保留（用户手打 `/技能名` 仍要能显式调用）。
 */
describe('enterprise skill activation switch', () => {
  const homes: string[] = []

  beforeEach(() => {
    homes.length = 0
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(homes.map(path => rm(path, { recursive: true, force: true })))
  })

  /**
   * 起一轮带技能下发的同步并等它完成。
   *
   * `DSH_HOME` 由 `startPlugin` 自己开临时目录，所以这里必须读**它**设的那个值——
   * 测试自己 `mkdtemp` 出来的目录跟插件写技能的位置不是同一个。
   *
   * @returns 本轮的 home 目录与已注册的设置命名空间。
   */
  async function startWithSkills(): Promise<{ home: string; registered: RegisteredNamespace }> {
    const { registered } = await startPlugin({ syncSkills: true })
    const home = process.env.DSH_HOME as string
    await waitFor(() => (existsSync(join(home, 'enterprise-skills.json')) ? true : undefined))
    return { home, registered }
  }

  it('writes the model-invocation opt-out when a skill is switched off, and removes it on', async () => {
    const { home, registered } = await startWithSkills()
    homes.push(home)
    const file = join(home, 'skills', 'doc-polish', 'SKILL.md')

    // 初始：技能照常进模型可见目录
    expect(await readFile(file, 'utf8')).not.toContain('disable-model-invocation')

    await registered.update({ disabledSkills: ['doc-polish'] })
    const off = await waitFor(async () => {
      const content = await readFile(file, 'utf8')
      return content.includes('disable-model-invocation: true') ? content : undefined
    })
    // 只加一行键：正文与其它 frontmatter 字段原样保留
    expect(off).toContain('name: doc-polish')
    expect(off).toContain('正文说明。')
    expect(off.split('\n').filter(line => line.includes('disable-model-invocation'))).toHaveLength(1)

    await registered.update({ disabledSkills: [] })
    const on = await waitFor(async () => {
      const content = await readFile(file, 'utf8')
      return content.includes('disable-model-invocation') ? undefined : content
    })
    expect(on).toContain('description: 整理并润色中文文档')
  })

  it('keeps the user switch across a cloud sync that rewrites the section', async () => {
    const { home, registered } = await startWithSkills()
    homes.push(home)

    await registered.update({ disabledSkills: ['meeting-minutes'] })
    await waitFor(async () => {
      const content = await readFile(join(home, 'skills', 'meeting-minutes', 'SKILL.md'), 'utf8')
      return content.includes('disable-model-invocation: true') ? content : undefined
    })

    // 云端每轮同步都会 replace 整个用户层：开关必须被 publishSession 原样带回。
    // 漏掉这一步，用户每关一个技能都会在下一次同步（默认 60s）被悄悄打开。
    await registered.update({ lastSyncAt: new Date().toISOString() })
    expect(registered.section()?.disabledSkills).toEqual(['meeting-minutes'])
    expect(await readFile(join(home, 'skills', 'meeting-minutes', 'SKILL.md'), 'utf8'))
      .toContain('disable-model-invocation: true')
    // 没被关的技能不受影响
    expect(await readFile(join(home, 'skills', 'doc-polish', 'SKILL.md'), 'utf8'))
      .not.toContain('disable-model-invocation')
  })

  it('ignores malformed skill names and missing local skill files', async () => {
    const { home, registered } = await startWithSkills()
    homes.push(home)

    // 不合法技能名 + 本机没有的技能：都不该让开关流程抛错或写出越界路径
    await registered.update({ disabledSkills: ['Bad_Name', 'not-delivered'] })
    expect(registered.section()?.disabledSkills).toEqual(['Bad_Name', 'not-delivered'])
    expect(existsSync(join(home, 'skills', 'Bad_Name'))).toBe(false)
    expect(existsSync(join(home, 'skills', 'not-delivered'))).toBe(false)
    // 已下发的技能不在关闭清单里，保持可被模型调用
    expect(await readFile(join(home, 'skills', 'doc-polish', 'SKILL.md'), 'utf8'))
      .not.toContain('disable-model-invocation')
  })
})


describe('enterprise local user skills and connectors', () => {
  const homes: string[] = []

  beforeEach(() => {
    homes.length = 0
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(homes.map(path => rm(path, { recursive: true, force: true })))
  })

  it('materializes uploaded skills, publishes installed state, and removes them with their manifest', async () => {
    const { home, registered } = await startPlugin()
    homes.push(home)
    const upload = {
      name: 'my-local-skill',
      displayName: 'My local skill',
      description: 'A local test skill',
      version: '1.0.0',
      files: [
        { path: 'SKILL.md', content: '---\nname: my-local-skill\ndescription: local test\n---\n\n# Local\n', encoding: 'utf8' },
        { path: 'references/guide.md', content: 'guide\n', encoding: 'utf8' },
      ],
      installed: false,
    }

    await registered.update({ userSkills: [upload] })
    const published = await waitFor(() => {
      const section = registered.section()
      return section?.userSkills?.[0]?.installed === true ? section : undefined
    })
    expect(published.userSkills?.[0]?.name).toBe('my-local-skill')
    const skillFile = await waitFor(async () => {
      try {
        const content = await readFile(join(home, 'skills', 'my-local-skill', 'SKILL.md'), 'utf8')
        return content.includes('# Local') ? content : undefined
      } catch {
        return undefined
      }
    })
    expect(skillFile).toContain('# Local')
    expect(await readFile(join(home, 'skills', 'my-local-skill', 'references', 'guide.md'), 'utf8')).toBe('guide\n')
    expect(existsSync(join(home, 'enterprise-user-skills.json'))).toBe(true)

    await registered.update({ userSkills: [] })
    await waitFor(() => (existsSync(join(home, 'skills', 'my-local-skill')) ? undefined : true))
  })

  it('mounts enabled MCP connectors and disposes them when disabled', async () => {
    const { home, registered, pluginCalls } = await startPlugin()
    homes.push(home)
    const connector = {
      name: 'local_mcp',
      transport: 'stdio',
      description: 'local test connector',
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'x' },
      url: '',
      headers: {},
      enabled: true,
    }

    await registered.update({ connectors: [connector] })
    const first = await waitFor(() => pluginCalls[0])
    expect(first.plugin).toHaveProperty('name', 'mcp-client')
    expect(first.config).toMatchObject({
      transport: 'stdio',
      serverName: 'local_mcp',
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'x' },
    })

    await registered.update({ connectors: [{ ...connector, enabled: false }] })
    await waitFor(() => (first.dispose.mock.calls.length > 0 ? true : undefined))
  })
})
