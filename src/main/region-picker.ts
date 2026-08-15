import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { IPC } from '../shared/ipc-channels'
import type { CaptureRegion } from './screen'

/**
 * Full-screen region picker, shown over a frozen screenshot.
 *
 * The screen is captured *first* and displayed as a still image, so what the
 * user drags over is exactly what gets cropped — and the picker's own UI can
 * never appear in the result. This is how the OS snipping tools behave, and
 * it also means the screen can keep changing underneath without affecting the
 * capture.
 *
 * Resolves with the selected region, or null if cancelled (Esc) or if the
 * user asked for the whole screen.
 */
/** A region, `'full'` for the whole display, or `null` when cancelled. */
export type RegionChoice = CaptureRegion | 'full' | null

export function pickRegion(
  screenshotDataUri: string,
  bounds: Electron.Rectangle
): Promise<RegionChoice> {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: false,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    picker.setAlwaysOnTop(true, 'screen-saver')

    let settled = false
    const finish = (region: RegionChoice): void => {
      if (settled) return
      settled = true
      picker.removeListener('closed', onClosed)
      if (!picker.isDestroyed()) picker.close()
      resolve(region)
    }

    // The picker reports its result on a channel scoped to this window, so
    // two pickers could never resolve each other's promise.
    const onResult = (
      event: Electron.IpcMainEvent,
      region: RegionChoice
    ): void => {
      if (event.sender !== picker.webContents) return
      finish(region)
    }

    const onClosed = (): void => {
      settled = true
      resolve(null)
    }

    picker.once('closed', onClosed)
    picker.webContents.ipc.on(IPC.REGION_SELECTED, onResult)

    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send(IPC.REGION_IMAGE, screenshotDataUri)
      picker.show()
      picker.focus()
    })

    // Same bundle as the overlay, switched by hash — avoids a second Vite
    // entry point just for this window.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void picker.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#region`)
    } else {
      void picker.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'region' })
    }
  })
}
