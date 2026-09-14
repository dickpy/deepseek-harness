import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { actionDraft, DEFAULT_HOME, type EnterpriseHome, type HomeAction } from './home-catalog.ts'
import { NS } from './locales.ts'
import type { EnterpriseBadgeState } from './enterprise-store.ts'
import css from './HomeCatalog.module.css'

/** 首页目录的注入面：hooks.home 由渲染器绑定为 useHome 选择器 hook。 */
export interface HomeCatalogInjected {
  hooks: {
    home: ObservableSnapshot<EnterpriseBadgeState>
  }
}

export type HomeCatalogProps =
  & PropsRuntime<'conversation.hero.catalog'>
  & PropsLocale<typeof NS>
  & InjectFace<HomeCatalogInjected>

/**
 * 会话首页的模块目录：标题下一级 tab（模块），输入框上一排二级 tab（快捷操作）。
 *
 * 目录有两个来源，取值规则是「管理台说了算」：
 *  - 平台下发过首页配置 → 用下发的（可能是空的：管理员把 tab 都删了，
 *    此时首页不显示任何快捷入口，而不是回退到内置默认目录）；
 *  - 平台从没配置过（`state.home === null`）→ 用内置默认目录。
 *
 * 绑定技能的二级 tab 点击后把 `/技能名 预设指令` 填进输入框——这是桌面端识别的
 * 显式技能调用手势；用户可以在指令后继续补充内容再发送。
 */
export function HomeCatalog(props: HomeCatalogProps): ReactNode {
  const { useHome, inputActions, t } = props
  const state = useHome(current => current)
  const catalog: EnterpriseHome = state.home ?? DEFAULT_HOME
  const [activeId, setActiveId] = useState<string>(() => catalog[0]?.id ?? '')
  const active = catalog.find(category => category.id === activeId) ?? catalog[0]

  // 管理台改了目录（换 tab、删 tab）后，本地选中的一级 tab 可能已经不存在：
  // 按 id 找不回来就落到第一个，避免停留在已经不显示的分类上。
  if (active !== undefined && active.id !== activeId) setActiveId(active.id)

  const pick = (action: HomeAction): void => {
    if (inputActions === undefined) return
    inputActions.setDraft(actionDraft(action))
  }

  if (active === undefined) return null

  return (
    <div className={css.root} aria-label={t('home.aria')}>
      <div className={css.tabs} role="tablist">
        {catalog.map(category => (
          <button
            key={category.id}
            type="button"
            role="tab"
            aria-selected={category.id === active.id}
            className={css.tab}
            data-active={category.id === active.id}
            onClick={() => { setActiveId(category.id) }}
          >
            {/* 图标由管理台配置（emoji / 单个字形）；没配就只显示文字 */}
            {category.icon !== undefined && (
              <span className={css.tabIcon} aria-hidden="true">{category.icon}</span>
            )}
            {category.label}
          </button>
        ))}
      </div>
      <div className={css.skills}>
        {active.actions.map(action => (
          <button
            key={action.id}
            type="button"
            className={css.skill}
            data-skill={action.skill ?? ''}
            disabled={inputActions === undefined}
            title={actionDraft(action)}
            onClick={() => { pick(action) }}
          >
            {action.icon !== undefined && (
              <span className={css.skillIcon} aria-hidden="true">{action.icon}</span>
            )}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}
