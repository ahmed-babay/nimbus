import { Notification } from 'electron'
import { activeWatches, checkWatches, type WatchUpdate } from '../services/watchers'
import {
  activeOutdoorWatches,
  checkOutdoorWatches,
  type OutdoorUpdate
} from '../services/outdoor-watch'
import { checkPriceAlerts, priceAlerts, type PriceUpdate } from '../services/watchlist'

/**
 * Polls watched journeys and reports the ones that changed.
 *
 * Slower than the reminder tick on purpose. A delay is announced by the
 * operator in minutes, not seconds, so checking every thirty seconds would
 * make five times the requests to learn the same thing — and this is a free,
 * community-run API that costs nothing precisely because nobody hammers it.
 *
 * A tick is skipped rather than queued if the previous one is still running,
 * which matters on a slow connection: overlapping checks would multiply
 * requests exactly when the network is least able to serve them.
 */

const TICK_MS = 150_000

/** Long enough for the app to finish appearing before it starts fetching. */
const FIRST_CHECK_DELAY_MS = 8_000

let timer: ReturnType<typeof setInterval> | null = null
let checking = false

export interface WatchHooks {
  /** Brings the overlay up and speaks the update. */
  onUpdate: (update: WatchUpdate | OutdoorUpdate | PriceUpdate) => void
}

function notify(update: WatchUpdate | OutdoorUpdate | PriceUpdate): void {
  // The overlay alone is missable when the user is in a full-screen app,
  // which is exactly where someone is when they're about to miss a train.
  if (!Notification.isSupported()) return
  new Notification({ title: 'Nimbus', body: update.speech, urgency: 'critical' }).show()
}

export function startWatchScheduler({ onUpdate }: WatchHooks): void {
  if (timer) return

  const tick = async (): Promise<void> => {
    if (checking) return
    checking = true
    try {
      // Both kinds on one tick. Outdoor watches rate-limit themselves to ten
      // minutes internally, so sharing the faster transit cadence costs
      // nothing and keeps a single timer in the process.
      const updates: Array<WatchUpdate | OutdoorUpdate | PriceUpdate> = [
        ...(await checkWatches()),
        ...(await checkOutdoorWatches()),
        ...(await checkPriceAlerts())
      ]
      for (const update of updates) {
        console.log(`[watchers] ${update.speech}`)
        notify(update)
        try {
          onUpdate(update)
        } catch (err) {
          console.error('[watchers] handler failed:', err)
        }
      }
    } catch (err) {
      // Never let a failure kill the interval — that would silently end every
      // watch for the rest of the session.
      console.error('[watchers] tick failed:', err)
    } finally {
      checking = false
    }
  }

  // Not immediately. Startup is the busiest moment the app has — Vite is
  // building, Electron is booting, the window is being composited — and a
  // burst of network calls competing with that is felt as lag rather than
  // seen as data. Nothing here is time-critical to the second.
  setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => void tick(), TICK_MS)

  const waiting = activeWatches().length + activeOutdoorWatches().length + priceAlerts().length
  if (waiting > 0) console.log(`[watchers] ${waiting} thing(s) being followed`)
}

export function stopWatchScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
