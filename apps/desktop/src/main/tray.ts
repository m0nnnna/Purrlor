import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { join } from 'node:path';
import { isWindows } from './paths';
import type { UpdateStatus } from './updater';

export type TrayHandlers = {
  show(): void;
  changeServer(): void;
  setStartOnLogin(on: boolean): void;
  checkForUpdates(): void;
  installUpdate(): void;
  quit(): void;
};

export type TrayModel = { serverName: string | null; unread: number; startOnLogin: boolean; update: UpdateStatus };

export function baseTrayIcon(): NativeImage {
  return nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 32, height: 32, quality: 'best' });
}

/**
 * The tray (Windows' notification area; on Linux the AppIndicator / StatusNotifier area, which
 * Ubuntu shows in the top bar). A click brings the window back on Windows; Linux's indicators only
 * ever open the menu, so "Open Purrlor" is first in it.
 */
export class AppTray {
  private readonly tray: Tray;

  constructor(private readonly handlers: TrayHandlers) {
    this.tray = new Tray(baseTrayIcon());
    this.tray.setToolTip('Purrlor');
    if (isWindows) this.tray.on('click', () => handlers.show());
  }

  setImage(image: NativeImage): void {
    if (!image.isEmpty()) this.tray.setImage(image);
  }

  update(model: TrayModel): void {
    const name = model.serverName ? `Purrlor — ${model.serverName}` : 'Purrlor';
    this.tray.setToolTip(model.unread > 0 ? `${name} (${model.unread} unread)` : name);
    const items: MenuItemConstructorOptions[] = [];
    if (model.update.state === 'ready') {
      items.push({ label: `Restart to update to ${model.update.version}`, click: () => this.handlers.installUpdate() }, { type: 'separator' });
    }
    items.push(
      { label: 'Open Purrlor', click: () => this.handlers.show() },
      { label: 'Change server…', click: () => this.handlers.changeServer() },
      { type: 'separator' },
      {
        label: isWindows ? 'Start with Windows' : 'Start when you log in',
        type: 'checkbox',
        checked: model.startOnLogin,
        click: (item) => this.handlers.setStartOnLogin(item.checked),
      },
      {
        label: model.update.state === 'checking' ? 'Checking for updates…' : model.update.state === 'downloading' ? `Downloading ${model.update.version}…` : 'Check for updates',
        enabled: model.update.state !== 'checking' && model.update.state !== 'downloading' && model.update.state !== 'ready',
        click: () => this.handlers.checkForUpdates(),
      },
      { type: 'separator' },
      { label: 'Quit Purrlor', click: () => this.handlers.quit() }
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  destroy(): void {
    this.tray.destroy();
  }
}
