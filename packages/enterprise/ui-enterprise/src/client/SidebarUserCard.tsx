import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { BrandLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import type { EnterpriseBadgeState } from './enterprise-store.ts'
import css from './SidebarUserCard.module.css'

/** 登录用户卡的注入面：hooks.user 由渲染器绑定为 useUser 选择器 hook。 */
export interface SidebarUserInjected {
  hooks: {
    user: ObservableSnapshot<EnterpriseBadgeState>
  }
}

export type SidebarUserCardProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & InjectFace<SidebarUserInjected>

/** Electron 壳暴露的会话操作（见 apps/desktop/src/preload-app.ts）。 */
declare global {
  interface Window {
    dshDesktop?: {
      enterpriseLogout?: (mode: 'logout' | 'switch') => Promise<void>
      updates?: { open?: () => Promise<void> }
    }
  }
}

/**
 * 侧边栏底部的登录用户卡（设置按钮上方）：展开态是 头像+姓名+角色 的菜单开关，
 * 折叠态只剩头像。菜单向上弹出，提供 切换账号 / 退出登录——两者都经壳 IPC
 * 清掉本机会话并整应用重启回登录窗，区别仅在是否保留邮箱预填。
 */
export function SidebarUserCard(props: SidebarUserCardProps): ReactNode {
  const { wide, useUser, t } = props
  const badge = useUser(state => state)
  const [open, setOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)

  const toggle = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect !== undefined) {
      setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
    }
    setOpen(current => !current)
  }, [])

  useEffect(() => {
    if (!open && !changelogOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        setChangelogOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, changelogOpen])

  if (badge.status !== 'ready' || badge.name === '') return null

  const leave = (mode: 'logout' | 'switch'): void => {
    setOpen(false)
    void window.dshDesktop?.enterpriseLogout?.(mode)
  }

  const checkUpdates = (): void => {
    setOpen(false)
    void window.dshDesktop?.updates?.open?.().catch(() => {})
  }

  const showChangelog = (): void => {
    setOpen(false)
    setChangelogOpen(true)
  }

  return (
    <div className={css.root} data-wide={wide}>
      <button
        ref={buttonRef}
        type="button"
        className={css.trigger}
        aria-label={t('user.menu.aria')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-active={open}
        onClick={toggle}
      >
        <span className={css.avatar}><BrandLogo size={26} /></span>
        {wide && (
          <span className={css.meta}>
            <span className={css.name}>{badge.name}</span>
            {badge.role !== '' && <span className={css.role}>{badge.role}</span>}
          </span>
        )}
      </button>
      {open && anchor !== null && (
        <>
          <div className={css.backdrop} onClick={() => { setOpen(false) }} />
          <div className={css.menu} style={{ left: anchor.left, bottom: anchor.bottom }} role="menu">
            <div className={css.menuHeader}>
              <div className={css.menuName}>{badge.name}</div>
              <div className={css.menuSub}>{badge.role}</div>
            </div>
            {window.dshDesktop?.updates?.open === undefined ? null : (
              <button type="button" className={css.menuItem} role="menuitem" onClick={checkUpdates}>
                {t('user.checkUpdates')}
              </button>
            )}
            <button type="button" className={css.menuItem} role="menuitem" onClick={showChangelog}>
              {t('user.changelog')}
            </button>
            <button type="button" className={css.menuItem} role="menuitem" onClick={() => { leave('switch') }}>
              {t('user.switch')}
            </button>
            <button type="button" className={`${css.menuItem} ${css.danger}`} role="menuitem" onClick={() => { leave('logout') }}>
              {t('user.logout')}
            </button>
          </div>
        </>
      )}
      {changelogOpen && (
        <div className={css.changelogBackdrop} role="presentation" onClick={() => { setChangelogOpen(false) }}>
          <section
            className={css.changelogDialog}
            role="dialog"
            aria-modal="true"
            aria-label={t('user.changelog.title')}
            onClick={(event) => { event.stopPropagation() }}
          >
            <header className={css.changelogHeader}>
              <h2 className={css.changelogTitle}>{t('user.changelog.title')}</h2>
              <button
                type="button"
                className={css.changelogClose}
                aria-label={t('user.changelog.close')}
                onClick={() => { setChangelogOpen(false) }}
              >
                ?
              </button>
            </header>
            <div className={css.changelogBody}>
              {t('user.changelog.body').split('\n\n').map((section) => {
                const [version, ...changes] = section.split('\n')
                return (
                  <section key={version} className={css.changelogSection}>
                    <h3 className={css.changelogVersion}>{version}</h3>
                    <ul className={css.changelogList}>
                      {changes.map(change => <li key={change}>{change}</li>)}
                    </ul>
                  </section>
                )
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
