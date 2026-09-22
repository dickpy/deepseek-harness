/** Isolated response-only bridge for shell-owned update dialogs. */
import { contextBridge, ipcRenderer } from 'electron'
import { UPDATE_DIALOG_IPC, type UpdateDialogApi, type UpdateDialogView } from './update-dialog.ts'

const api: UpdateDialogApi = {
  status: () => ipcRenderer.invoke(UPDATE_DIALOG_IPC.status) as Promise<UpdateDialogView>,
  subscribe(listener) {
    const handle = (_event: Electron.IpcRendererEvent, view: UpdateDialogView): void => { listener(view) }
    ipcRenderer.on(UPDATE_DIALOG_IPC.presentation, handle)
    return () => { ipcRenderer.off(UPDATE_DIALOG_IPC.presentation, handle) }
  },
  respond: index => ipcRenderer.invoke(UPDATE_DIALOG_IPC.respond, index) as Promise<void>,
}
if (location.href === 'dsh-app://shell/update-dialog.html') contextBridge.exposeInMainWorld('dshUpdateDialog', api)
