/**
 * fork 新增：跨插件「企业管理台菜单可见性」注册表。
 *
 * 管理台给角色配置的桌面端可见菜单（`dsh-enterprise` 设置节的 `menus`），
 * 需要同时作用于多个互不相识的插件表面——设置壳的导航 tab（ui-settings-general）
 * 和会话头部动作（ui-jobs）等。这里提供一个**零依赖的单例注册表**作为共享 seam：
 *
 *  - 写入方：企业客户端插件（`@deepseek-ai/dsh-client-ui-enterprise`）按角色
 *    权限把「不可见的表面 id」整体写进来；
 *  - 读取方：任何需要按菜单权限显隐自己的插件，读 {@link isEnterpriseHidden}
 *    并在订阅里重算。
 *
 * 该模块随 `@deepseek-ai/dsh-client-ui-slots` 一起被 shell 静态链接进共享模块表，
 * 所以所有动态插件 bundle 拿到的是同一份实例（不会有双实例导致的静默失效）。
 *
 * 表面 id 约定为 `域.名称`（如 `settings.general`、`workspace.tasks`），
 * 由写入方在「管理台菜单 key → 表面 id」的映射里决定。未写入任何集合 = 全部可见。
 */

/** 当前不可见的表面 id 集合。 */
const hidden = new Set<string>()
/** 可见性变化的订阅者。 */
const listeners = new Set<() => void>()
/** 注册表版本号，每次整体替换递增。 */
let version = 0

/** 设置不可见的表面 id 集合（每次调用整体替换、递增版本并通知订阅者）。 */
export function setEnterpriseHidden(ids: readonly string[]): void {
  hidden.clear()
  for (const id of ids) hidden.add(id)
  version += 1
  for (const listener of [...listeners]) listener()
}

/** 订阅可见性变化（组件/注册逻辑的重算通知）。 */
export function subscribeEnterpriseHidden(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 注册表版本号：给基于快照缓存的消费者做失效判断。 */
export function enterpriseHiddenVersion(): number {
  return version
}

/** 该表面 id 是否被企业菜单配置隐藏。 */
export function isEnterpriseHidden(id: string): boolean {
  return hidden.has(id)
}
