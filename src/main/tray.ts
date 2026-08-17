import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'

export interface TrayCallbacks {
  onShow: () => void
  /** Opens the list of things Nimbus is holding: watches, events, reminders. */
  onStanding: () => void
  onSettings: () => void
  onQuit: () => void
}

export function createTray(callbacks: TrayCallbacks): Tray {
  const iconPath = join(__dirname, '../../resources/tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon)

  tray.setToolTip('Nimbus')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Nimbus', click: callbacks.onShow },
      { label: 'Watching for you', click: callbacks.onStanding },
      { label: 'Settings', click: callbacks.onSettings },
      { type: 'separator' },
      { label: 'Quit', click: callbacks.onQuit }
    ])
  )
  tray.on('click', callbacks.onShow)

  return tray
}
