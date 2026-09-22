// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SidebarUserCard } from '../src/client/SidebarUserCard.tsx'

const labels = {
  'user.menu.aria': 'Account menu',
  'user.checkUpdates': 'Check for updates',
  'user.changelog': 'Changelog',
  'user.changelog.title': 'Changelog',
  'user.changelog.close': 'Close',
  'user.changelog.body': 'v0.0.6 ? Current\nSkill upload supports ZIP\n\nv0.0.5 ? 2026-09-20\nSkills Plaza and connectors',
  'user.switch': 'Switch account',
  'user.logout': 'Sign out',
} as const

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SidebarUserCard', () => {
  it('places Check for updates above Switch account and opens the shell prompt', () => {
    const open = vi.fn(async () => {})
    vi.stubGlobal('dshDesktop', { updates: { open } })
    const view = render(createElement(SidebarUserCard as never, {
      wide: true,
      useUser: ((selector: (state: unknown) => unknown) => selector({ status: 'ready', name: 'User', role: 'admin' })) as never,
      t: ((key: keyof typeof labels) => labels[key]) as never,
    }))
    fireEvent.click(view.getByRole('button', { name: 'Account menu' }))
    expect(view.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Check for updates', 'Changelog', 'Switch account', 'Sign out',
    ])
    fireEvent.click(view.getByText('Check for updates'))
    expect(open).toHaveBeenCalledOnce()
  })

  it('opens the version history with concise release notes', () => {
    const view = render(createElement(SidebarUserCard as never, {
      wide: true,
      useUser: ((selector: (state: unknown) => unknown) => selector({ status: 'ready', name: 'User', role: 'admin' })) as never,
      t: ((key: keyof typeof labels) => labels[key]) as never,
    }))
    fireEvent.click(view.getByRole('button', { name: 'Account menu' }))
    fireEvent.click(view.getByText('Changelog'))
    expect(view.getByRole('dialog', { name: 'Changelog' })).toBeTruthy()
    expect(view.getByText('v0.0.6 ? Current')).toBeTruthy()
    expect(view.getByText('Skill upload supports ZIP')).toBeTruthy()
    expect(view.getByText('v0.0.5 ? 2026-09-20')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    expect(view.queryByRole('dialog')).toBeNull()
  })
})
