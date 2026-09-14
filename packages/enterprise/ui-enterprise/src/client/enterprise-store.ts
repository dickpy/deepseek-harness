/**
 * 企业会话状态：跟随 host 插件写入的 `dsh-enterprise` 设置命名空间
 * （{ serverUrl, user, menus, agents, plugins, skills, disabledSkills, home, configRevision }），
 * 派生成徽标、菜单过滤器与「技能广场」消费的状态。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { decodeHome, type EnterpriseHome } from './home-catalog.ts'
import { decodeExamples, type HomeExample } from './home-examples.ts'

/** 技能广场里的一个技能（元数据；正文在本机 skills 目录里） */
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

/** 徽标 / 首页 / 技能广场的渲染状态。 */
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
 * @returns 技能清单（可能为空），按名字排序。
 */
export function decodeSkills(value: unknown, disabled: ReadonlySet<string> = new Set()): readonly EnterpriseSkill[] {
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
    configRevision: 0,
    lastSyncAt: '',
  })
  private following: (() => void) | undefined
  /** 最近一次从设置里读到的关闭清单：开关写入要以它为基线做增删 */
  private disabled: ReadonlySet<string> = new Set()

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
    this.disabled = disabled
    this.store.update((state) => {
      state.status = 'ready'
      state.name = typeof user?.name === 'string' ? user.name : ''
      state.role = typeof user?.role === 'string' ? user.role : ''
      state.menus = Array.isArray(value?.menus) ? value.menus.filter(m => typeof m === 'string') : []
      state.home = value === undefined || value.home === undefined ? null : decodeHome(value.home)
      state.examples = decodeExamples(value?.examples)
      state.skills = decodeSkills(value?.skills, disabled)
      state.configRevision = typeof value?.configRevision === 'number' ? value.configRevision : 0
      state.lastSyncAt = typeof value?.lastSyncAt === 'string' ? value.lastSyncAt : ''
    })
  }
}
