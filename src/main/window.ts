import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { IPC } from '../shared/ipc-channels'

const WINDOW_WIDTH = 520
// Tall enough for the largest response card (news hero image + three
// headlines, or an entity photo + extract) plus the follow-up strip and drop
// shadow. The window is transparent, so unused space stays invisible.
const WINDOW_HEIGHT = 560

export function createOverlayWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const x = Math.round(primaryDisplay.workArea.x + (primaryDisplay.workArea.width - WINDOW_WIDTH) / 2)
  const y = primaryDisplay.workArea.y + 56

  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Idle: click-through so the overlay never blocks the desktop underneath it.
  window.setIgnoreMouseEvents(true, { forward: true })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Forward renderer console output to the terminal. Without this, errors in
  // the overlay (audio decode failures, IPC problems) are invisible unless
  // DevTools is open, which made diagnosing TTS fallbacks guesswork.
  window.webContents.on(
    'console-message',
    (...args: unknown[]) => {
      // Electron >=36 passes a single event object; older versions pass
      // (event, level, message, ...). Support both.
      const first = args[0] as { message?: string; level?: string | number } | undefined
      const message = typeof first?.message === 'string' ? first.message : (args[2] as string)
      if (message) console.log(`[renderer] ${message}`)
    }
  )

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

export function showOverlay(window: BrowserWindow, extraChannel?: string): void {
  window.setIgnoreMouseEvents(false)
  // show() + focus(), not showInactive(): an unfocused window never receives
  // keyboard events, so Escape (and any future shortcuts) silently did
  // nothing. Taking focus is the expected behaviour anyway — the user just
  // invoked this deliberately, same as Spotlight.
  window.show()
  window.focus()
  window.webContents.send(IPC.WAKE)
  if (extraChannel) window.webContents.send(extraChannel)
}

export function hideOverlay(window: BrowserWindow): void {
  window.setIgnoreMouseEvents(true, { forward: true })
  window.hide()
}
