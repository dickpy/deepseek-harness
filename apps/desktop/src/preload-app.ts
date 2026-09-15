/** Startup controls for shell documents; application documents receive only the carrier marker. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, type DshDesktopAppApi, type DshDesktopStartupApi } from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'

/** 产品版本读取；壳拥有的任何 `dsh-app://` 文档都可以用。 */
const appVersion = (): Promise<string> => ipcRenderer.invoke(DESKTOP_IPC.versionGet) as Promise<string>

const startup: DshDesktopStartupApi = {
  protocolVersion: 1,
  appVersion,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as ReturnType<DshDesktopStartupApi['locale']>,
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as ReturnType<DshDesktopStartupApi['backend']['status']>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  disablePlugins: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

const enterprise = {
  context: () => ipcRenderer.invoke('dsh-desktop:enterprise-login-context'),
  submit: (payload: { serverUrl: string; email: string; password: string }) =>
    ipcRenderer.invoke('dsh-desktop:enterprise-login-submit', payload),
  complete: () => ipcRenderer.invoke('dsh-desktop:enterprise-login-complete') as Promise<void>,
}

/** 应用文档可用的企业会话操作：退出登录（保留邮箱预填）与切换账号（清空预填）。 */
const enterpriseSession = {
  enterpriseLogout: (mode: 'logout' | 'switch') =>
    ipcRenderer.invoke('dsh-desktop:enterprise-logout', { mode }) as Promise<void>,
}

/** 后端提供的应用文档只拿到载体标记、产品版本与退出登录。 */
const application: DshDesktopAppApi = { protocolVersion: 1, appVersion, ...enterpriseSession }

contextBridge.exposeInMainWorld('dshDesktop', location.protocol === 'dsh-app:' && location.hostname === 'shell'
  ? { ...startup, enterprise }
  : application)
