import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DshDesktopStartupApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('electron', () => electron)

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

it.each(['dsh-app://app/index.html', 'https://shell/startup.html'])(
  'exposes only the carrier marker, the product version, and sign-out to %s',
  async (url) => {
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as Record<string, unknown>
    // 应用文档拿到的是最小面：没有插件管理、重启或配置重置。
    expect(new Set(Object.keys(api))).toEqual(new Set(['protocolVersion', 'appVersion', 'enterpriseLogout']))
    expect(api).toMatchObject({ protocolVersion: 1 })
    expect(api).not.toHaveProperty('plugins')
    expect(api).not.toHaveProperty('backend')
    expect(api).not.toHaveProperty('restart')
    expect(api).not.toHaveProperty('disablePlugins')
  },
)

it('reads the product version over its own channel from every owned document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
    appVersion: () => Promise<string>
  }
  await api.appVersion()
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.versionGet)
})

it('provides startup controls and a removable state subscription to shell documents', async () => {
  vi.stubGlobal('location', new URL('dsh-app://shell/startup.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopStartupApi
  await api.appVersion()
  await api.locale()
  await api.backend.status()
  await api.disablePlugins()
  await api.resetConfiguration()
  await api.restart()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.versionGet], [DESKTOP_IPC.localeGet], [DESKTOP_IPC.backendStatus],
    [DESKTOP_IPC.pluginsDisableAll], [DESKTOP_IPC.configurationReset], [DESKTOP_IPC.applicationRestart],
  ])
  const listener = vi.fn()
  const dispose = api.backend.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls[0]?.[1] as (event: unknown, state: unknown) => void
  handler({}, { phase: 'error', message: 'startup failed' })
  expect(listener).toHaveBeenCalledWith({ phase: 'error', message: 'startup failed' })
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.backendState, handler)
  expect(api).not.toHaveProperty('plugins')
})
