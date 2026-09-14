/**
 * fork 补丁：企业管理台的桌面端菜单权限过滤（设置壳侧）。
 *
 * 注册表本体在 `@deepseek-ai/dsh-client-ui-slots` 的 `enterprise-visibility.ts`
 * （shell 静态链接的共享单例，ui-enterprise 写入 / ui-jobs 等其它表面同样读取）。
 * 这里只做**设置 tab** 的适配：
 *
 *  - 企业客户端插件按角色权限写入不可见的表面 id 集合；
 *  - 设置壳投影导航行时跳过被隐藏的 tab（表面 id = `settings.<tab id>`）。
 *
 * 未设置任何集合 = 全部可见（上游默认行为不变）。
 */
export {
  enterpriseHiddenVersion, isEnterpriseHidden, subscribeEnterpriseHidden,
} from '@deepseek-ai/dsh-client-ui-slots'

/** 设置 tab 的业务表面 id（写入方与设置壳共用的命名约定）。 */
export function settingsSectionSurface(id: string): string {
  return `settings.${id}`
}
