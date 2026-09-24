import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconSearchOutlineRegular, IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ComposerMenuController, filteredComposerRows } from './composer-menu.ts'
import css from './ComposerMenuView.module.css'

export interface ComposerMenuInjected {
  composerMenu: ComposerMenuController
}

export type ComposerMenuViewProps = ComposerMenuInjected & PropsLocale<'command'>

const MAX_HEIGHT = 520
const TOP_MARGIN = 12

export function ComposerMenuView({ composerMenu, t }: ComposerMenuViewProps) {
  const state = useSyncExternalStore(
    listener => composerMenu.state.subscribe(listener),
    () => composerMenu.state.getSnapshot(),
  )
  const cardRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [maxHeight, setMaxHeight] = useState(MAX_HEIGHT)
  const [anchorOffset, setAnchorOffset] = useState(0)

  useLayoutEffect(() => {
    if (!state.open) return
    const menu = cardRef.current
    const card = menu?.closest('[data-composer-card]')
    const trigger = card?.querySelector('button[aria-haspopup="listbox"]')
    if (!(card instanceof HTMLElement) || !(trigger instanceof HTMLElement)) return
    const fit = (): void => {
      const cardRect = card.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const nextMaxHeight = Math.min(MAX_HEIGHT, Math.max(0, cardRect.top - TOP_MARGIN))
      const nextOffset = Math.max(0, triggerRect.top - cardRect.top)
      setMaxHeight(current => current === nextMaxHeight ? current : nextMaxHeight)
      setAnchorOffset(current => current === nextOffset ? current : nextOffset)
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(card)
    observer?.observe(trigger)
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit, true)
    }
  }, [state.open])

  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (cardRef.current !== null && event.target instanceof Node && cardRef.current.contains(event.target)) return
      composerMenu.dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, composerMenu])

  useEffect(() => {
    if (state.open) searchRef.current?.focus()
  }, [state.open])

  if (!state.open) return null
  const rows = filteredComposerRows(state.data, state.search)
  const navActive = state.activeId

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      composerMenu.move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      composerMenu.move(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void composerMenu.selectHighlighted()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      composerMenu.dismiss()
    }
  }

  return (
    <div
      ref={cardRef}
      className={css.card}
      style={{ maxHeight, transform: `translateY(${anchorOffset}px)` }}
      role="dialog"
      aria-label={t('composer.aria')}
      onKeyDown={onKeyDown}
    >
      <nav className={css.nav} aria-label={t('composer.nav.aria')}>
        {state.nav.map(item => (
          <button
            key={item.id}
            type="button"
            className={clsx(css.navItem, navActive === item.id && css.navActive)}
            onClick={() => { composerMenu.selectNav(item.id) }}
          >
            {item.icon !== undefined && <item.icon className={css.navIcon} size={16} />}
            <span className={css.navLabel}>{item.label}</span>
            {item.kind === 'panel' && <IconChevronRightOutlineRegular className={css.navChevron} />}
          </button>
        ))}
      </nav>

      <section className={css.panel} aria-live="polite">
        <div className={css.searchWrap}>
          <IconSearchOutlineRegular className={css.searchIcon} size={16} />
          <input
            ref={searchRef}
            className={css.search}
            type="text"
            value={state.search}
            placeholder={state.data?.searchPlaceholder ?? t('composer.search.placeholder')}
            aria-label={t('composer.search.aria')}
            onChange={(event) => { composerMenu.setSearch(event.currentTarget.value) }}
            disabled={state.status === 'pending' && state.data === null}
          />
        </div>

        <div className={css.body}>
          {state.status === 'pending' && state.data === null && (
            <div className={css.status}>{t('composer.loading')}</div>
          )}
          {state.error !== null && (
            <div className={css.error} role="alert">
              <IconWarningOutlineRegular />
              <span>{state.error}</span>
              <button type="button" className={css.retry} onClick={() => { composerMenu.retry() }}>
                {t('composer.retry')}
              </button>
            </div>
          )}
          {state.status === 'ready' && rows.length === 0 && (
            <div className={css.status}>{state.data?.emptyText ?? t('composer.empty')}</div>
          )}
          {rows.map((row, index) => (
            <div key={row.id}>
              {row.section !== undefined && row.section !== rows[index - 1]?.section && (
                <div className={css.section}>{row.section}</div>
              )}
              <button
                type="button"
                className={clsx(css.row, state.highlightId === row.id && css.rowActive)}
                disabled={row.disabled}
                onMouseMove={() => { composerMenu.highlight(row.id) }}
                onClick={() => { void composerMenu.selectRow(row.id) }}
              >
                <span className={css.rowIcon}>
                  {row.icon !== undefined ? <row.icon size={16} /> : <span className={css.dot} />}
                </span>
                <span className={css.rowText}>
                  <span className={css.rowTitle}>{row.label}</span>
                  {row.description !== undefined && <span className={css.rowDescription}>{row.description}</span>}
                </span>
                {row.active === true && <IconCheckOutlineRegular className={css.check} />}
              </button>
            </div>
          ))}
        </div>

        {state.data?.actions !== undefined && state.data.actions.length > 0 && (
          <div className={css.footer}>
            {state.data.actions.map(action => (
              <button
                key={action.id}
                type="button"
                className={css.footerAction}
                onClick={() => { void composerMenu.runAction(action.id) }}
              >
                {action.icon !== undefined && <action.icon size={16} />}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
