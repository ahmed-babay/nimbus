import { Notification } from 'electron'
import { activeWatches, checkWatches, type WatchUpdate } from '../services/watchers'

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

let timer: ReturnType<typeof setInterval> | null = null
let checking = false

export interface WatchHooks {
  /** Brings the overlay up and speaks the update. */
  onUpdate: (update: WatchUpdate) => void
}

function notify(update: WatchUpdate): void {
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
      for (const update of await checkWatches()) {
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

  void tick()
  timer = setInterval(() => void tick(), TICK_MS)

  const waiting = activeWatches().length
  if (waiting > 0) console.log(`[watchers] ${waiting} journey(s) being followed`)
}

export function stopWatchScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
