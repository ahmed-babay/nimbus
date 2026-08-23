import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { IPC } from '../shared/ipc-channels'
import { warmLocalModel } from '../services/local-llm'

const WINDOW_WIDTH = 520
// Tall enough for the largest response card (news hero image + three
// headlines, or an entity photo + extract) plus the follow-up strip and drop
// shadow. The window is transparent, so unused space stays invisible.
const WINDOW_HEIGHT = 720

/**
 * Keeps the overlay on a screen that still exists.
 *
 * A window remembers where it was dragged, which is the point — but a laptop
 * undocked from a second monitor would otherwise restore it to coordinates
 * nobody can reach, and a tray app that opens off-screen looks broken.
 */
export function ensureOnScreen(window: BrowserWindow): void {
  const [x, y] = window.getPosition()
  const area = screen.getDisplayNearestPoint({ x, y }).workArea
  const clampedX = Math.min(Math.max(x, area.x), area.x + area.width - WINDOW_WIDTH)
  const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - 80)
  if (clampedX !== x || clampedY !== y) window.setPosition(clampedX, clampedY)
}

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
    // Draggable by its header. The window is only 520px wide and exactly wraps
    // the card, so moving it moves what the user sees — there is no invisible
    // region being dragged around.
    movable: true,
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
  // Stay click-through. The window is far larger than the visible card and
  // fully transparent around it, so making the whole thing interactive put an
  // invisible block over the top of the screen — you couldn't select text
  // underneath it. The renderer turns this off only while the pointer is
  // genuinely over the card (see IPC.SET_MOUSE_IGNORE).
  ensureOnScreen(window)
  window.setIgnoreMouseEvents(true, { forward: true })
  // show() + focus(), not showInactive(): an unfocused window never receives
  // keyboard events, so Escape (and any future shortcuts) silently did
  // nothing. Taking focus is the expected behaviour anyway — the user just
  // invoked this deliberately, same as Spotlight.
  window.show()
  window.focus()
  window.webContents.send(IPC.WAKE)
  if (extraChannel) window.webContents.send(extraChannel)

  // Start reading the weights now rather than when the question arrives. The
  // user is about to spend a second or two speaking and another being
  // transcribed, and the load runs underneath that instead of after it — which
  // is the difference between a pause they never notice and twelve seconds of
  // apparently nothing happening. A no-op when the model is already warm or
  // the provider is a cloud one.
  void warmLocalModel()
}

/**
 * Shows the overlay *without* starting a listening turn. `showOverlay` always
 * sends WAKE, which puts Nimbus straight into recording — right when the user
 * summoned it, wrong when Nimbus is the one initiating (a reminder firing
 * shouldn't open a hot microphone).
 */
export function presentOverlay(window: BrowserWindow, channel: string, payload?: unknown): void {
  ensureOnScreen(window)
  window.setIgnoreMouseEvents(true, { forward: true })
  window.show()
  window.focus()
  window.webContents.send(channel, payload)
}

export function hideOverlay(window: BrowserWindow): void {
  window.setIgnoreMouseEvents(true, { forward: true })
  window.hide()
}
