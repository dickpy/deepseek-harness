import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { IconSkillOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSkillsOwnerProps } from './index.ts'
import type { EnterpriseBadgeState } from './enterprise-store.ts'
import { NS } from './locales.ts'
import css from './SkillsSidebarEntry.module.css'

/** 侧边栏技能广场入口的注入面：选中态由面板信息给出，点击切换主区域。 */
export interface SkillsSidebarInjected {
  hooks: {
    home: ObservableSnapshot<EnterpriseBadgeState>
  }
  /** 切换主区域面板；`null` 回到对话。 */
  selectPanel: (id: string | null) => void
}

export type SkillsSidebarEntryProps =
  & PropsRuntime<'sidebar.skills'>
  & SidebarSkillsOwnerProps
  & PropsLocale<typeof NS>
  & InjectFace<SkillsSidebarInjected>

/** 本入口在侧边栏面板列表里的 id，与主区域面板 key 一致 */
const PANEL_ID = 'skills'

/**
 * 侧边栏「技能广场」入口：「新会话」按钮与工作区列表之间的那一行。
 *
 * 与品牌行 / 新会话按钮一起构成侧边栏的固定导航区——工作区与会话列表在它下面。
 * 点击把主区域切成技能广场面板；再点会话或「新会话」回到对话。
 * 管理台的「技能广场」菜单权限把它整行隐藏（消费 `workspace.skills`）。
 */
export function SkillsSidebarEntry(props: SkillsSidebarEntryProps): ReactNode {
  const { wide, usePanelInfo, selectPanel, useHome, t } = props
  const active = usePanelInfo(info => info.activePanelId === PANEL_ID)
  const state = useHome(current => current)
  const label = t('skills.sidebar')

  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={css.row}
        data-wide={wide}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        data-active={active}
        onClick={() => { selectPanel(active ? null : PANEL_ID) }}
      >
        <span className={css.glyph} aria-hidden="true">
          <IconSkillOutline16 size={wide ? 15 : 18} />
        </span>
        {wide && <span className={css.label}>{label}</span>}
        {wide && state.skills.length > 0 && (
          <span className={css.count}>{state.skills.length}</span>
        )}
      </button>
    </Tooltip>
  )
}
