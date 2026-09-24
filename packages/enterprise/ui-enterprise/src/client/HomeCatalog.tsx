// Type-only: slot declarations from the conversation owner.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { actionDraft, DEFAULT_HOME, type EnterpriseHome, type HomeAction, type HomeCategory } from './home-catalog.ts'
import { NS } from './locales.ts'
import type { EnterpriseBadgeState } from './enterprise-store.ts'
import css from './HomeCatalog.module.css'

/** Home catalog injection: the renderer binds hooks.home as useHome. */
export interface HomeCatalogInjected {
  hooks: {
    home: ObservableSnapshot<EnterpriseBadgeState>
  }
}

export type HomeCatalogProps =
  & PropsRuntime<'conversation.hero.catalog'>
  & PropsLocale<typeof NS>
  & InjectFace<HomeCatalogInjected>

export type HomeSkillChipsProps =
  & PropsRuntime<'conversation.composer.hero.skills'>
  & PropsLocale<typeof NS>
  & InjectFace<HomeCatalogInjected>

type ActiveCatalogProps = Pick<HomeCatalogProps, 'useHome' | 'activeId' | 'onActive'>

/**
 * Resolve the selected category from the shared owner value. Either surface
 * may be the first to render, so whichever falls back to the first category
 * publishes that id and pulls the other surface into the same selection.
 */
function useActiveCategory({ useHome, activeId, onActive }: ActiveCatalogProps): HomeCategory | undefined {
  const state = useHome(current => current)
  const catalog: EnterpriseHome = state.home ?? DEFAULT_HOME
  const active = catalog.find(category => category.id === activeId) ?? catalog[0]

  useEffect(() => {
    if (active !== undefined && active.id !== activeId) onActive(active.id)
  }, [active, activeId, onActive])

  return active
}

function pickAction(inputActions: HomeCatalogProps['inputActions'], action: HomeAction): void {
  if (inputActions === undefined) return
  inputActions.setDraft(actionDraft(action))
}

/**
 * Hero category tabs above the composer card.
 */
export function HomeCatalog(props: HomeCatalogProps): ReactNode {
  const { t } = props
  const state = props.useHome(current => current)
  const catalog: EnterpriseHome = state.home ?? DEFAULT_HOME
  const active = useActiveCategory(props)

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
            onClick={() => { props.onActive(category.id) }}
          >
            {category.icon !== undefined && (
              <span className={css.tabIcon} aria-hidden="true">{category.icon}</span>
            )}
            {category.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Skill chips for the active category at the card top-left.
 *
 * Clicking fills `/skill prompt` into the draft; the user may continue typing.
 */
export function HomeSkillChips(props: HomeSkillChipsProps): ReactNode {
  const { inputActions, t } = props
  const active = useActiveCategory(props)

  if (active === undefined) return null

  return (
    <div className={`${css.root} ${css.skillsRoot}`} aria-label={t('home.aria')}>
      <div className={css.skills}>
        {active.actions.map(action => (
          <button
            key={action.id}
            type="button"
            className={css.skill}
            data-skill={action.skill ?? ''}
            disabled={inputActions === undefined}
            title={actionDraft(action)}
            onClick={() => { pickAction(inputActions, action) }}
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
