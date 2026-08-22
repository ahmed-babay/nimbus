import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { quietSettings, setQuietSettings } from '../services/quiet'

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

  /**
   * Rebuilt on every change because a checkbox that does not visibly move is
   * worse than no checkbox: the whole value of this control is being certain
   * Nimbus will stay quiet in the next ten minutes.
   */
  const render = (): void => {
    const quiet = quietSettings()
    tray.setToolTip(quiet.doNotDisturb ? 'Nimbus - do not disturb' : 'Nimbus')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Nimbus', click: callbacks.onShow },
        { label: 'Watching for you', click: callbacks.onStanding },
        { type: 'separator' },
        {
          label: 'Do not disturb',
          type: 'checkbox',
          checked: quiet.doNotDisturb,
          click: () => {
            setQuietSettings({ doNotDisturb: !quietSettings().doNotDisturb })
            render()
          }
        },
        {
          label: `Quiet hours (${quiet.from}-${quiet.until})`,
          type: 'checkbox',
          checked: quiet.enabled,
          click: () => {
            setQuietSettings({ enabled: !quietSettings().enabled })
            render()
          }
        },
        { type: 'separator' },
        { label: 'Settings', click: callbacks.onSettings },
        { label: 'Quit', click: callbacks.onQuit }
      ])
    )
  }

  render()
  tray.on('click', callbacks.onShow)

  return tray
}
