/**
 * 企业客户端表面（fork 新增包）：浏览器入口。
 *
 *  1. 侧边栏底部用户卡：向 `sidebar.footer.action` 注册（设置按钮上方），
 *     菜单提供 切换账号 / 退出登录（经壳 IPC 清会话并重启回登录窗）。
 *  2. 会话首页模块目录：向 `conversation.hero.catalog` 注册 WorkBuddy 式的
 *     大类（模块）tab + 小类（技能）chips，目录来自 `dsh-enterprise` 设置节
 *     的 home 字段，未下发时用内置默认。
 *  3. 技能广场：向侧边栏 `sidebar.skills` 注册入口（「新会话」与工作区之间），
 *     并向主区域注册 `workspace.skills` 面板；展示管理台按角色下发的技能，
 *     卡片上的「试一试」带着 `/技能名` 开一段新对话。
 *  4. 菜单显隐：按同命名空间的 `menus` 过滤设置壳导航
 *     （ui-settings-general 的 fork 过滤器 setEnterpriseHiddenSections）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the sidebar's slot declarations (sidebar.footer.action, sidebar.skills).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { setEnterpriseHidden } from '@deepseek-ai/dsh-client-ui-slots'
import { HomeCatalog } from './HomeCatalog.tsx'
import { SidebarUserCard } from './SidebarUserCard.tsx'
import { SkillsPlaza, type SkillsPlazaInjected } from './SkillsPlaza.tsx'
import { SkillsSidebarEntry, type SkillsSidebarInjected } from './SkillsSidebarEntry.tsx'
import { composeDraft } from './compose-draft.ts'
import { EnterpriseSessionStore, decodeEnterpriseSection } from './enterprise-store.ts'
import { NS, en, zh, type EnterpriseLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 企业客户端文案。 */
    'ui-enterprise': EnterpriseLocaleKey
  }
}

/**
 * 侧边栏技能广场入口收到的侧边栏折叠状态。
 *
 * 与 ui-sidebar 为 `sidebar.skills` 声明的 owner 同形；该包没有把它列进
 * `./client` 的再导出，所以这里按结构声明自己的那一份。
 */
export interface SidebarSkillsOwnerProps {
  /** 侧边栏是否为展开态（false = 56px 图标栏）。 */
  wide: boolean
}

/** 技能广场主区域面板的 key（侧边栏入口选中它，AppFrame 据此渲染中间区域）。 */
const SKILLS_PANEL = 'skills'

/** 用户卡、首页目录、技能广场与菜单过滤所需的服务。 */
export const inject = [
  'slots',
  'locale',
  'settingsScope',
  'remote',
  'remote.settings',
  'layout',
  'sessions',
  'workspaces',
  'uiWorkspace',
  'conversation',
]

/**
 * 桌面端受菜单权限控制的表面清单（隐藏集以此为准，写入的 id 必须与各消费方一致）：
 *  - `settings.<tab>`：设置壳的导航 tab（消费方 ui-settings-general）；
 *  - `workspace.chat`：会话入口（消费方 ui-sidebar，隐藏「新会话」入口）；
 *  - `workspace.skills`：技能广场入口（消费方本包的侧边栏行）；
 *  - `workspace.tasks`：后台任务入口（消费方 ui-jobs，隐藏会话头部的任务按钮）。
 *
 * 企业语义是**白名单**：角色配了 menus 就只放行列出的 key，其余全部隐藏——
 * 新增的 tab 不会因为忘了登记映射而意外可见。menus 为空 = 全部可见（上游默认）。
 */
const KNOWN_SURFACES = [
  'settings.general',
  'settings.models',
  'settings.plugins',
  'settings.agents',
  'workspace.chat',
  'workspace.skills',
  'workspace.tasks',
]

/**
 * 管理台菜单 key → 桌面端表面 id。
 *
 * 多数 key 与表面 id 同名；只有设置 tab 需要翻译：管理台沿用历史标签
 * `settings.agents`，而设置壳的 tab 注册 id 是 `agent-presets`。
 */
const MENU_TO_SURFACE: Record<string, string> = { 'settings.agents': 'settings.agent-presets' }

/**
 * 注册企业客户端的字典、菜单过滤器与四个表面。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind({ namespace: 'dsh-enterprise', decode: decodeEnterpriseSection })
  const store = new EnterpriseSessionStore(scope)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-enterprise: dictionaries')

  const applyMenuFilter = (): void => {
    const snapshot = store.store.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.menus.length === 0) {
      setEnterpriseHidden([])
      return
    }
    const allowed = new Set(snapshot.menus.map(key => MENU_TO_SURFACE[key] ?? key))
    setEnterpriseHidden(
      KNOWN_SURFACES.map(key => MENU_TO_SURFACE[key] ?? key).filter(id => !allowed.has(id)),
    )
  }
  ctx.effect(() => {
    void store.load()
    applyMenuFilter()
    const off = scope.subscribe(() => { applyMenuFilter() })
    return () => {
      off()
      store.dispose()
      setEnterpriseHidden([])
    }
  }, 'ui-enterprise: menu filter')

  const userInjected = () => ({ hooks: { user: store.store } })
  const homeInjected = () => ({ hooks: { home: store.store } })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'enterprise-user-card',
    order: 100,
    locale: NS,
    inject: userInjected,
  }, SidebarUserCard))
  ctx.slots.inject('conversation.hero.catalog', () => ctx.slots.register({
    name: 'conversation.hero.catalog',
    locale: NS,
    inject: homeInjected,
  }, HomeCatalog))
  const sidebarInjected = (): SkillsSidebarInjected => ({
    hooks: { home: store.store },
    selectPanel: (id) => { ctx.layout.selectPanel(id as MainPanelId | null) },
  })
  const plazaInjected = (): SkillsPlazaInjected => ({
    hooks: { home: store.store },
    useSkill: (skill) => { void composeDraft(ctx, `/${skill}`) },
  })
  ctx.slots.inject('sidebar.skills', () => ctx.slots.register({
    name: 'sidebar.skills',
    locale: NS,
    inject: sidebarInjected,
  }, SkillsSidebarEntry))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SKILLS_PANEL,
    locale: NS,
    inject: plazaInjected,
  }, SkillsPlaza))
}
