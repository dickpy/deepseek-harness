/** Origin-scoped boot, native directory selection, and update presentation with native confirmation actions. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  SCHEME,
  type DshDesktopLoginApi,
  type DshDesktopProductApi,
  type DesktopUpdatePresentation,
} from './ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'

/** 产品版本读取；壳自有的任何 `dsh-app://` 文档都可以用。 */
const appVersion = (): Promise<string> => ipcRenderer.invoke(DESKTOP_IPC.versionGet) as Promise<string>

/** fork: 退出登录/切换账号；主进程清会话后重启应用，门禁落回登录窗。 */
const enterpriseLogout = (mode: 'logout' | 'switch'): Promise<void> =>
  ipcRenderer.invoke('dsh-desktop:enterprise-logout', { mode }) as Promise<void>

const product: DshDesktopProductApi = {
  protocolVersion: 1,
  appVersion,
  enterpriseLogout,
  updates: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
    open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
    },
  },
}

/**
 * fork: 登录窗（`dsh-app://shell/login.html`）的桥面。
 * 企业凭据只经 IPC 交给主进程，页面自身不发起网络请求。
 */
const login: DshDesktopLoginApi = {
  protocolVersion: 1,
  appVersion,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as ReturnType<DshDesktopLoginApi['locale']>,
  enterprise: {
    context: () => ipcRenderer.invoke('dsh-desktop:enterprise-login-context') as Promise<unknown>,
    submit: payload =>
      ipcRenderer.invoke('dsh-desktop:enterprise-login-submit', payload) as ReturnType<DshDesktopLoginApi['enterprise']['submit']>,
    complete: () => ipcRenderer.invoke('dsh-desktop:enterprise-login-complete') as Promise<void>,
  },
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  syncWindowsAppearance()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
}

markDocumentPlatform()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
const ownedDocument = location.protocol === `${SCHEME}:`
// fork: 登录窗是唯一拿到企业登录桥的 shell 文档；其余 dsh-app://shell/* 只留载体标记。
const loginDocument = ownedDocument && location.hostname === 'shell' && location.pathname === '/login.html'
contextBridge.exposeInMainWorld('dshDesktop', ownedDocument && location.hostname === 'app'
  ? product
  : loginDocument ? login : { protocolVersion: 1 })
