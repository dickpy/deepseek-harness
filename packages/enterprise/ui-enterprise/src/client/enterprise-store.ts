/**
 * 企业会话状态：跟随 host 插件写入的 `dsh-enterprise` 设置命名空间
 * （{ serverUrl, user, menus, agents, plugins, skills, userSkills, connectors,
 * disabledSkills, home, configRevision }），派生成徽标、菜单过滤器与
 * 「技能广场」消费的状态。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { decodeHome, type EnterpriseHome } from './home-catalog.ts'
import { decodeExamples, type HomeExample } from './home-examples.ts'

/** 技能来源：企业管理台下发 / 用户在桌面端自己上传。 */
export type EnterpriseSkillSource = 'enterprise' | 'user'

/** 技能广场里的一个技能（元数据；正文在本机 skills 目录里）。 */
export interface EnterpriseSkill {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly version: string
  /** single = 单个 SKILL.md；bundle = 目录/zip（含附属文件） */
  readonly kind: 'single' | 'bundle'
  readonly fileCount: number
  /** 本机是否已经落盘（host 插件上一轮同步的结果） */
  readonly installed: boolean
  /**
   * 用户是否启用这个技能（桌面端「技能广场」卡片上的开关）。
   *
   * 关闭**不会**卸载技能，也不影响管理台的授权：host 插件把该技能文件的
   * `disable-model-invocation` 置为 true，于是它不进模型可见的技能目录，
   * 但用户手打 `/技能名` 仍然能显式调用。
   */
  readonly enabled: boolean
  /** 来源分组：企业管理台下发 / 用户自己上传。 */
  readonly source: EnterpriseSkillSource
}

/** 用户上传技能包里的一份文件（`path` 是技能目录内的相对路径）。 */
export interface UserSkillFile {
  readonly path: string
  readonly content: string
  readonly encoding: 'utf8' | 'base64'
}

/**
 * 用户在桌面端上传的一个技能：整份正文进设置节 `userSkills`，
 * host 插件监听它落盘到 `$DSH_HOME/skills/<name>/`。
 */
export interface UserSkillUpload {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly version: string
  /** SKILL.md 必须在列（path 为 `SKILL.md` 或技能根目录内的相对路径）。 */
  readonly files: readonly UserSkillFile[]
  /** host 是否已把它写到本机技能目录（上传后由 host 回填）。 */
  readonly installed: boolean
}

/** 连接器传输方式：本地进程（stdio）/ 远程 HTTP（streamable-http）。 */
export type ConnectorTransport = 'stdio' | 'streamable-http'

/**
 * 一个自定义 MCP 连接器（写进 `dsh-enterprise.connectors`，host 按
 * vendor 的 McpClient 契约动态挂载/卸载）。
 */
export interface EnterpriseConnector {
  /** MCP serverName：仅字母数字下划线连字符，最长 32（与 mcp-client 契约一致）。 */
  readonly name: string
  readonly transport: ConnectorTransport
  readonly description: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly enabled: boolean
}

/** host 插件写入的会话节。 */
export interface EnterpriseSection {
  serverUrl?: string
  user?: {
    email?: string
    name?: string
    role?: string | null
  }
  menus?: string[]
  agents?: string[]
  plugins?: string[]
  /** 技能广场里已发布、且对当前用户角色可见的技能清单 */
  skills?: unknown
  /** 用户自己上传的技能（含 SKILL.md 正文），客户端写、host 落盘 */
  userSkills?: unknown
  /** 用户自己添加的 MCP 连接器，客户端写、host 挂载 */
  connectors?: unknown
  /**
   * 用户在桌面端「技能广场」关掉的技能名。
   * 客户端写、host 读（host 据此调整技能文件的模型可见性），空数组 = 全部启用。
   */
  disabledSkills?: unknown
  /**
   * 首页模块目录（EAM/QMS 等大类 + 技能小类）。
   * **缺省** = 平台没有配置过首页目录，客户端用内置默认；
   * **空数组** = 管理员把 tab 都删了，客户端首页不再显示任何快捷入口。
   */
  home?: unknown
  /**
   * 会话首页样例（管理台「首页样例配置」下发）。没有内置默认：
   * 空数组/缺省都表示「不显示案例区」。
   */
  examples?: unknown
  /** 云端配置版本号；管理台点「同步到客户端」时会递增 */
  configRevision?: number
  lastSyncAt?: string
}

/** 徽标 / 首页 / 技能广场 / 连接器的渲染状态。 */
export interface EnterpriseBadgeState {
  status: 'loading' | 'ready' | 'unavailable'
  name: string
  role: string
  menus: string[]
  /** null = 平台没有配置过首页目录（用内置默认）；[] = 配置过但一个不剩 */
  home: EnterpriseHome | null
  /** 首页样例（管理台下发）；空数组 = 不显示案例区 */
  examples: readonly HomeExample[]
  skills: readonly EnterpriseSkill[]
  /** 用户自己添加的 MCP 连接器（含企业管理台下发的预留位） */
  connectors: readonly EnterpriseConnector[]
  /** 最近一次同步到的云端配置版本号 */
  configRevision: number
  lastSyncAt: string
}
/**
 * 宽松解码：节缺失/畸形时读作空对象，徽标保持 loading 而不是卡死在旧值。
 * @param section - 设置节里的原始值。
 * @returns 可安全读取的企业节。
 */
export function decodeEnterpriseSection(section: unknown): EnterpriseSection {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as EnterpriseSection
    : {}
}

/**
 * 宽松解码技能清单：结构不对整表丢弃，单项畸形只剔除该项。
 * @param value - 设置节里的 `skills` 字段。
 * @param disabled - 用户关掉的技能名集合（来自同一节的 `disabledSkills`）。
 * @param source - 这一批技能的来源分组。
 * @returns 技能清单（可能为空），按名字排序。
 */
export function decodeSkills(
  value: unknown,
  disabled: ReadonlySet<string> = new Set(),
  source: EnterpriseSkillSource = 'enterprise',
): readonly EnterpriseSkill[] {
  if (!Array.isArray(value)) return []
  const skills: EnterpriseSkill[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const {
      name, displayName, description, version, kind, fileCount, installed,
    } = entry as {
      name?: unknown
      displayName?: unknown
      description?: unknown
      version?: unknown
      kind?: unknown
      fileCount?: unknown
      installed?: unknown
    }
    if (typeof name !== 'string' || name === '') continue
    skills.push({
      name,
      displayName: typeof displayName === 'string' && displayName !== '' ? displayName : name,
      description: typeof description === 'string' ? description : '',
      version: typeof version === 'string' ? version : '',
      kind: kind === 'bundle' ? 'bundle' : 'single',
      fileCount: typeof fileCount === 'number' && Number.isFinite(fileCount) ? fileCount : 0,
      installed: installed === true,
      enabled: !disabled.has(name),
      source,
    })
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 宽松解码开关清单：只保留合法技能名，去重。
 * @param value - 设置节里的 `disabledSkills` 字段。
 * @returns 关闭的技能名集合。
 */
export function decodeDisabledSkills(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set()
  const names = value.filter((name): name is string => typeof name === 'string' && SKILL_NAME.test(name))
  return new Set(names)
}

/** 技能名语法（与 dsh 的 `isSkillName` 一致：kebab-case） */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** MCP serverName 语法（与 mcp-client 的 serverName 契约一致） */
const CONNECTOR_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** 单个用户技能包内的一份文件路径必须是相对路径（防 `..` 越界写盘）。 */
function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return false
  return path.split(/[\\/]+/).every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * 宽松解码用户上传的技能清单：只保留技能名合法、且带 SKILL.md 正文的条目。
 * @param value - 设置节里的 `userSkills` 字段（上传时的原样结构）。
 * @returns 规范化后的用户技能列表，按名字排序。
 */
export function decodeUserSkills(value: unknown): readonly UserSkillUpload[] {
  if (!Array.isArray(value)) return []
  const uploads: UserSkillUpload[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = record.name
    if (typeof name !== 'string' || !SKILL_NAME.test(name) || seen.has(name)) continue
    if (!Array.isArray(record.files)) continue
    const files: UserSkillFile[] = []
    for (const file of record.files) {
      if (typeof file !== 'object' || file === null) continue
      const record2 = file as Record<string, unknown>
      const path = record2.path
      if (typeof path !== 'string' || !isSafeRelativePath(path)) continue
      if (typeof record2.content !== 'string') continue
      files.push({ path, content: record2.content, encoding: record2.encoding === 'base64' ? 'base64' : 'utf8' })
    }
    if (!files.some(file => file.path.toLowerCase() === 'skill.md')) continue
    seen.add(name)
    uploads.push({
      name,
      displayName: typeof record.displayName === 'string' && record.displayName !== '' ? record.displayName : name,
      description: typeof record.description === 'string' ? record.description : '',
      version: typeof record.version === 'string' ? record.version : '',
      files,
      installed: record.installed === true,
    })
  }
  return uploads.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 把一份上传记录转成技能广场卡片消费的元数据。
 * @param upload - 规范化后的用户技能上传记录。
 * @returns 带 `source: 'user'` 的技能元数据。
 */
export function userSkillToEnterpriseSkill(
  upload: UserSkillUpload,
  disabled: ReadonlySet<string> = new Set(),
): EnterpriseSkill {
  const fileCount = Math.max(0, upload.files.length - 1)
  return {
    name: upload.name,
    displayName: upload.displayName,
    description: upload.description,
    version: upload.version,
    kind: upload.files.length > 1 ? 'bundle' : 'single',
    fileCount,
    installed: upload.installed,
    enabled: !disabled.has(upload.name),
    source: 'user',
  }
}
/** 解码连接器上的字符串字典（env / headers），只保留字符串值。 */
function decodeStringMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const map: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === '' || typeof entry !== 'string') continue
    map[key] = entry
  }
  return map
}

/**
 * 宽松解码连接器清单：serverName 不合法、或该传输方式缺关键字段的条目直接剔除。
 * @param value - 设置节里的 `connectors` 字段。
 * @returns 规范化后的连接器列表，按名字排序。
 */
export function decodeConnectors(value: unknown): readonly EnterpriseConnector[] {
  if (!Array.isArray(value)) return []
  const connectors: EnterpriseConnector[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = record.name
    if (typeof name !== 'string' || !CONNECTOR_NAME.test(name) || seen.has(name)) continue
    const transport: ConnectorTransport = record.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    const url = typeof record.url === 'string' ? record.url.trim() : ''
    // 缺关键字段的连接器挂载一定失败，这里直接当作无效条目丢弃。
    if (transport === 'stdio' ? command === '' : url === '') continue
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string')
      : []
    seen.add(name)
    connectors.push({
      name,
      transport,
      description: typeof record.description === 'string' ? record.description : '',
      command,
      args,
      env: decodeStringMap(record.env),
      url,
      headers: decodeStringMap(record.headers),
      enabled: record.enabled !== false,
    })
  }
  return connectors.sort((left, right) => left.name.localeCompare(right.name))
}

/** 跟随设置作用域的徽标状态源（uSES 经 ui-renderer 的 bindSnapshotSelector）。 */
export class EnterpriseSessionStore {
  private readonly scope: SettingsScope<EnterpriseSection>
  readonly store: SnapshotStore<EnterpriseBadgeState> = createSnapshotStore<EnterpriseBadgeState>({
    status: 'loading',
    name: '',
    role: '',
    menus: [],
    home: null,
    examples: [],
    skills: [],
    connectors: [],
    configRevision: 0,
    lastSyncAt: '',
  })
  private following: (() => void) | undefined
  /** 最近一次从设置里读到的关闭清单：开关写入要以它为基线做增删 */
  private disabled: ReadonlySet<string> = new Set()
  /** 最近一次从设置里读到的用户技能：新增/删除要以它为基线做增删 */
  private userSkillUploads: readonly UserSkillUpload[] = []
  /** 最近一次从设置里读到的连接器：增删改要以它为基线做增删 */
  private connectors: readonly EnterpriseConnector[] = []

  /** @param scope - `dsh-enterprise` 设置命名空间的作用域。 */
  constructor(scope: SettingsScope<EnterpriseSection>) {
    this.scope = scope
  }

  /** 开始跟随作用域（幂等）。 */
  load(): Promise<void> {
    this.following ??= this.scope.subscribe(() => { this.derive() })
    this.derive()
    return Promise.resolve()
  }

  /** 停止跟随作用域。 */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  /**
   * 打开/关闭一个技能。
   *
   * 只写 `disabledSkills` 这一个字段：设置节里其它字段（身份、菜单、技能清单）
   * 由 host 插件在每轮同步时维护，这里一次 `set` 不会碰到它们，也就不需要
   * 先读一份完整 section 再写回去（那会把并发同步的结果覆盖掉）。
   *
   * @param name - 技能名。
   * @param enabled - true = 启用（写回可用状态），false = 关闭。
   * @returns 写入结算。
   */
  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    if (!SKILL_NAME.test(name)) return
    const next = new Set(this.disabled)
    if (enabled) next.delete(name)
    else next.add(name)
    await this.scope.set('disabledSkills', [...next].sort())
  }
  /**
   * 新增/覆盖一个用户自己上传的技能（同名的后一次上传覆盖前一次）。
   *
   * 只写 `userSkills` 一个字段，写完整数组而不是做增量 patch：
   * host 侧监听同一字段，逐条比对落盘；`installed` 由 host 回填。
   *
   * @param upload - 规范化后的技能包（必须含 SKILL.md）。
   * @returns 写入结算。
   */
  async putUserSkill(upload: UserSkillUpload): Promise<void> {
    if (!SKILL_NAME.test(upload.name)) throw new Error(`invalid skill name: ${upload.name}`)
    if (!upload.files.some(file => file.path.toLowerCase() === 'skill.md')) {
      throw new Error(`skill ${upload.name} has no SKILL.md`)
    }
    const next = this.userSkillUploads.filter(skill => skill.name !== upload.name)
    next.push({ ...upload, installed: false })
    next.sort((left, right) => left.name.localeCompare(right.name))
    await this.scope.set('userSkills', next)
  }

  /**
   * 删除一个用户自己上传的技能（host 会连同本机技能目录一起移除）。
   * @param name - 技能名。
   * @returns 写入结算。
   */
  async removeUserSkill(name: string): Promise<void> {
    const next = this.userSkillUploads.filter(skill => skill.name !== name)
    if (next.length === this.userSkillUploads.length) return
    await this.scope.set('userSkills', next)
  }

  /**
   * 新增/覆盖一个连接器（同名的后一次配置覆盖前一次）。
   * @param connector - 连接器配置（含传输方式与连接参数）。
   * @returns 写入结算。
   */
  async putConnector(connector: EnterpriseConnector): Promise<void> {
    if (!CONNECTOR_NAME.test(connector.name)) throw new Error(`invalid connector name: ${connector.name}`)
    const next = this.connectors.filter(item => item.name !== connector.name)
    next.push(connector)
    next.sort((left, right) => left.name.localeCompare(right.name))
    await this.scope.set('connectors', next)
  }

  /**
   * 删除一个连接器（host 会卸载对应的 MCP server）。
   * @param name - MCP serverName。
   * @returns 写入结算。
   */
  /**
   * Replace the complete connector list from one validated JSON config.
   * Keeping this as a single write avoids transient half-applied mounts.
   */
  async putConnectors(connectors: readonly EnterpriseConnector[]): Promise<void> {
    await this.scope.set('connectors', decodeConnectors(connectors))
  }

  async removeConnector(name: string): Promise<void> {
    const next = this.connectors.filter(item => item.name !== name)
    if (next.length === this.connectors.length) return
    await this.scope.set('connectors', next)
  }

  /**
   * 启用/停用一个连接器（host 据此挂载或卸载 MCP server）。
   * @param name - MCP serverName。
   * @param enabled - true = 挂载。
   * @returns 写入结算。
   */
  async setConnectorEnabled(name: string, enabled: boolean): Promise<void> {
    const target = this.connectors.find(item => item.name === name)
    if (target === undefined || target.enabled === enabled) return
    const next = this.connectors.map(item => (item.name === name ? { ...item, enabled } : item))
    await this.scope.set('connectors', next)
  }

  /** 由当前作用域快照重算徽标状态。 */
  private derive(): void {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.mode === 'memory' || snapshot.status === 'loading') {
      this.store.update((state) => { state.status = 'loading' })
      return
    }
    if (snapshot.status === 'unavailable') {
      this.store.update((state) => { state.status = 'unavailable' })
      return
    }
    const value = snapshot.value
    const user = value?.user
    const disabled = decodeDisabledSkills(value?.disabledSkills)
    const uploads = decodeUserSkills(value?.userSkills)
    const connectors = decodeConnectors(value?.connectors)
    this.disabled = disabled
    this.userSkillUploads = uploads
    this.connectors = connectors
    this.store.update((state) => {
      state.status = 'ready'
      state.name = typeof user?.name === 'string' ? user.name : ''
      state.role = typeof user?.role === 'string' ? user.role : ''
      state.menus = Array.isArray(value?.menus) ? value.menus.filter(m => typeof m === 'string') : []
      state.home = value === undefined || value.home === undefined ? null : decodeHome(value.home)
      state.examples = decodeExamples(value?.examples)
      state.skills = [
        ...decodeSkills(value?.skills, disabled, 'enterprise')
          .filter(skill => !uploads.some(upload => upload.name === skill.name)),
        ...uploads.map(upload => userSkillToEnterpriseSkill(upload, disabled)),
      ]
      state.connectors = connectors
      state.configRevision = typeof value?.configRevision === 'number' ? value.configRevision : 0
      state.lastSyncAt = typeof value?.lastSyncAt === 'string' ? value.lastSyncAt : ''
    })
  }
}
