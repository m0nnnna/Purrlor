import { contextBridge, ipcRenderer } from 'electron';
import type { ProbeResult, ShellApi, ShellState } from '../shared/types';

// The shell page is the app's own local file; this is all it can reach in the main process.
const api: ShellApi = {
  onState: (listener) => {
    ipcRenderer.on('shell:state', (_e, state: ShellState) => listener(state));
    ipcRenderer.send('shell:ready');
  },
  onDrawBadge: (listener) => {
    ipcRenderer.on('shell:draw-badge', (_e, request: { id: number; count: number }) => listener(request));
  },
  badgeDrawn: (id, overlay, tray) => ipcRenderer.send('shell:badge-drawn', id, overlay, tray),
  probe: (address) => ipcRenderer.invoke('shell:probe', address) as Promise<ProbeResult>,
  connect: (origin) => ipcRenderer.send('shell:connect', origin),
  cancelModal: () => ipcRenderer.send('shell:cancel-modal'),
  retry: () => ipcRenderer.send('shell:retry'),
  changeServer: () => ipcRenderer.send('shell:change-server'),
  choosePickerSource: (id, audio) => ipcRenderer.send('shell:picker-choose', id, audio),
  installUpdate: () => ipcRenderer.send('shell:install-update'),
  dismissNotice: () => ipcRenderer.send('shell:dismiss-notice'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
};

contextBridge.exposeInMainWorld('purrlor', api);
