import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'

export interface TrayCallbacks {
  onShow: () => void
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
      { label: 'Settings', click: callbacks.onSettings },
      { type: 'separator' },
      { label: 'Quit', click: callbacks.onQuit }
    ])
  )
  tray.on('click', callbacks.onShow)

  return tray
}
