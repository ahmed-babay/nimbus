import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { IPC } from '../shared/ipc-channels'
import { warmLocalModel } from '../services/local-llm'
import type { OverlayCorner, OverlayLayout, OverlaySqueeze } from '../shared/types'

/**
 * How long after the overlay appears before the model starts loading.
 *
 * Long enough for the entrance animation to land, short enough that it is
 * still loading while the user speaks — which is the whole point of warming
 * up on open rather than on the question.
 */
const WARM_UP_DELAY_MS = 350

const WINDOW_WIDTH = 520
// Tall enough for the largest response card (news hero image + three
// headlines, or an entity photo + extract) plus the follow-up strip and drop
// shadow. The window is transparent, so unused space stays invisible.
const WINDOW_HEIGHT = 720
/** Round orb parked in a corner — roughly a taskbar icon. */
const ICON_SIZE = 48
/** Compact dock: composer + answer, still a corner chip rather than the full card. */
const COMPACT_WIDTH = 372
const COMPACT_HEIGHT = 528
const DOCK_INSET = 10
/** How close the card has to be to a work-area corner before it parks there. */
const SNAP_DISTANCE = 160

interface DockState {
  corner: OverlayCorner | null
  squeeze: OverlaySqueeze
}

const dock: DockState = { corner: null, squeeze: 'full' }

function workAreaNear(window: BrowserWindow): Electron.Rectangle {
  const [x, y] = window.getPosition()
  return screen.getDisplayNearestPoint({ x, y }).workArea
}

function fittedSize(area: Electron.Rectangle): { width: number; height: number } {
  return {
    width: Math.min(WINDOW_WIDTH, area.width),
    height: Math.min(WINDOW_HEIGHT, area.height)
  }
}

function layoutOf(): OverlayLayout {
  return { corner: dock.corner, squeeze: dock.squeeze }
}

function emitLayout(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  window.webContents.send(IPC.OVERLAY_LAYOUT, layoutOf())
}

function clampFullyOnScreen(
  x: number,
  y: number,
  width: number,
  height: number,
  area: Electron.Rectangle
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(y, area.y), area.y + area.height - height)
  }
}

function iconBounds(corner: OverlayCorner, area: Electron.Rectangle): Electron.Rectangle {
  return dockedRect(corner, area, ICON_SIZE, ICON_SIZE)
}

function compactBounds(corner: OverlayCorner, area: Electron.Rectangle): Electron.Rectangle {
  return dockedRect(
    corner,
    area,
    Math.min(COMPACT_WIDTH, area.width - DOCK_INSET * 2),
    Math.min(COMPACT_HEIGHT, area.height - DOCK_INSET * 2)
  )
}

function dockedRect(
  corner: OverlayCorner,
  area: Electron.Rectangle,
  width: number,
  height: number
): Electron.Rectangle {
  const left = area.x + DOCK_INSET
  const top = area.y + DOCK_INSET
  const right = area.x + area.width - width - DOCK_INSET
  const bottom = area.y + area.height - height - DOCK_INSET
  switch (corner) {
    case 'top-left':
      return { x: left, y: top, width, height }
    case 'top-right':
      return { x: right, y: top, width, height }
    case 'bottom-left':
      return { x: left, y: bottom, width, height }
    case 'bottom-right':
      return { x: right, y: bottom, width, height }
  }
}

function expandedBounds(corner: OverlayCorner, area: Electron.Rectangle): Electron.Rectangle {
  const { width, height } = fittedSize(area)
  return dockedRect(corner, area, width, height)
}

function boundsFor(corner: OverlayCorner, squeeze: OverlaySqueeze, area: Electron.Rectangle): Electron.Rectangle {
  if (squeeze === 'icon') return iconBounds(corner, area)
  if (squeeze === 'compact') return compactBounds(corner, area)
  return expandedBounds(corner, area)
}

function applyBounds(window: BrowserWindow, bounds: Electron.Rectangle): void {
  window.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  })
}

function applyDock(window: BrowserWindow, corner: OverlayCorner, squeeze: OverlaySqueeze): void {
  dock.corner = corner
  dock.squeeze = squeeze
  const area = workAreaNear(window)
  applyBounds(window, boundsFor(corner, squeeze, area))
  emitLayout(window)
}

function applyFreePlacement(window: BrowserWindow): void {
  dock.squeeze = 'full'
  const area = workAreaNear(window)
  const { width, height } = fittedSize(area)
  const [x, y] = window.getPosition()
  const next = clampFullyOnScreen(x, y, width, height, area)
  applyBounds(window, { ...next, width, height })
  emitLayout(window)
}

/**
 * Puts the overlay where it currently belongs: a corner peek, a corner-expanded
 * card, or a free-floating card that still fits on a screen that exists.
 *
 * A window remembers where it was dragged, which is the point — but a laptop
 * undocked from a second monitor would otherwise restore it to coordinates
 * nobody can reach, and a tray app that opens off-screen looks broken.
 */
export function ensureOnScreen(window: BrowserWindow): void {
  if (dock.corner) {
    applyDock(window, dock.corner, dock.squeeze)
    return
  }
  applyFreePlacement(window)
}

export function getOverlayLayout(): OverlayLayout {
  return layoutOf()
}

/**
 * Follows the pointer. A parked peek is treated as a drag of the chip itself;
 * dropping away from a corner expands it back into the full card.
 */
export function moveOverlay(window: BrowserWindow, dx: number, dy: number): void {
  dock.corner = null
  const [x, y] = window.getPosition()
  const nextX = Math.round(x + dx)
  const nextY = Math.round(y + dy)
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
    console.warn(`[main] ignoring a bad overlay move (dx=${dx}, dy=${dy})`)
    return
  }
  window.setPosition(nextX, nextY)
}

function nearestCorner(window: BrowserWindow, area: Electron.Rectangle): OverlayCorner | null {
  const [wx, wy] = window.getPosition()
  const [ww] = window.getSize()
  // The visible card sits at the top of the (often taller) window, so the
  // grab point is the header, not the window's geometric centre — that would
  // be empty transparency.
  const cx = wx + ww / 2
  const cy = wy + 36
  const targets: Array<[OverlayCorner, number, number]> = [
    ['top-left', area.x, area.y],
    ['top-right', area.x + area.width, area.y],
    ['bottom-left', area.x, area.y + area.height],
    ['bottom-right', area.x + area.width, area.y + area.height]
  ]
  let best: OverlayCorner | null = null
  let bestDist = SNAP_DISTANCE
  for (const [corner, x, y] of targets) {
    const dist = Math.hypot(cx - x, cy - y)
    if (dist < bestDist) {
      best = corner
      bestDist = dist
    }
  }
  return best
}

/** Parks the overlay in a corner if the drag ended close enough; otherwise expands it. */
export function snapOverlay(window: BrowserWindow): void {
  const area = workAreaNear(window)
  const corner = nearestCorner(window, area)
  if (corner) {
    const squeeze = dock.squeeze === 'full' ? 'compact' : dock.squeeze
    applyDock(window, corner, squeeze)
    return
  }
  dock.corner = null
  dock.squeeze = 'full'
  applyFreePlacement(window)
}

export function setOverlaySqueeze(window: BrowserWindow, squeeze: OverlaySqueeze): void {
  if (!dock.corner && squeeze !== 'full') return
  if (!dock.corner) {
    dock.squeeze = 'full'
    applyFreePlacement(window)
    return
  }
  applyDock(window, dock.corner, squeeze)
}

export function createOverlayWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const area = primaryDisplay.workArea
  const { width, height } = fittedSize(area)
  const x = Math.round(area.x + (area.width - width) / 2)
  const y = area.y + Math.min(56, Math.max(0, area.height - height))

  const window = new BrowserWindow({
    width,
    height,
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
    roundedCorners: false,
    backgroundColor: '#00000000',
    backgroundMaterial: 'none',
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
  window.webContents.on('console-message', (...args: unknown[]) => {
    // Electron >=36 passes a single event object; older versions pass
    // (event, level, message, ...). Support both.
    const first = args[0] as { message?: string; level?: string | number } | undefined
    const message = typeof first?.message === 'string' ? first.message : (args[2] as string)
    if (message) console.log(`[renderer] ${message}`)
  })

  const refit = (): void => {
    if (!window.isDestroyed()) ensureOnScreen(window)
  }
  screen.on('display-metrics-changed', refit)
  screen.on('display-removed', refit)
  window.on('closed', () => {
    screen.off('display-metrics-changed', refit)
    screen.off('display-removed', refit)
  })

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
  //
  // Summoning Nimbus (hotkey, wake word) is a request to talk. If it's parked
  // in a corner, open the compact dock so they can speak or type without the
  // full card covering the screen.
  if (dock.corner) dock.squeeze = 'compact'
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
  emitLayout(window)

  // Start reading the weights now rather than when the question arrives. The
  // user is about to spend a second or two speaking and another being
  // transcribed, and the load runs underneath that instead of after it — which
  // is the difference between a pause they never notice and twelve seconds of
  // apparently nothing happening. A no-op when the model is already warm or
  // the provider is a cloud one.
  //
  // Held back for a beat so the overlay's entrance finishes first. Loading
  // does not block the main thread — measured, the worst stall across a twelve
  // second load is 78ms — but it does hand several gigabytes to the GPU, and
  // starting that in the same frame as the window appearing put the contention
  // exactly where it is most visible: on the animation the user is looking at.
  setTimeout(() => void warmLocalModel(), WARM_UP_DELAY_MS)
}

/**
 * Shows the overlay *without* starting a listening turn. `showOverlay` always
 * sends WAKE, which puts Nimbus straight into recording — right when the user
 * summoned it, wrong when Nimbus is the one initiating (a reminder firing
 * shouldn't open a hot microphone).
 */
export function presentOverlay(window: BrowserWindow, channel: string, payload?: unknown): void {
  if (dock.corner) dock.squeeze = 'compact'
  ensureOnScreen(window)
  window.setIgnoreMouseEvents(true, { forward: true })
  window.show()
  window.focus()
  window.webContents.send(channel, payload)
  emitLayout(window)
}

export function hideOverlay(window: BrowserWindow): void {
  window.setIgnoreMouseEvents(true, { forward: true })
  window.hide()
}
