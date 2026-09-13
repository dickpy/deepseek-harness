import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
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
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])

  if (badge.status !== 'ready' || badge.name === '') return null
  const initial = badge.name.slice(0, 1).toUpperCase()

  const leave = (mode: 'logout' | 'switch'): void => {
    setOpen(false)
    void window.dshDesktop?.enterpriseLogout?.(mode)
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
        <span className={css.avatar}>{initial}</span>
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
            <button type="button" className={css.menuItem} role="menuitem" onClick={() => { leave('switch') }}>
              {t('user.switch')}
            </button>
            <button type="button" className={`${css.menuItem} ${css.danger}`} role="menuitem" onClick={() => { leave('logout') }}>
              {t('user.logout')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
