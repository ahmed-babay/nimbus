import { Notification } from 'electron'
import { claimDueReminders, pendingReminders } from '../services/reminders'
import type { Reminder } from '../shared/types'

/**
 * Fires reminders. Deliberately a poll rather than a `setTimeout` per
 * reminder: timers don't survive a restart, they drift while the machine is
 * asleep, and `setTimeout` silently caps out around 24.8 days. Checking a
 * sorted list every half minute costs nothing and behaves correctly when the
 * laptop has been shut since the reminder was set.
 */

const TICK_MS = 30_000

let timer: ReturnType<typeof setInterval> | null = null

export interface SchedulerHooks {
  /** Brings the overlay up and speaks the reminder. */
  onDue: (reminder: Reminder) => void
}

function notify(reminder: Reminder): void {
  // A desktop notification as well as the overlay: if the machine was asleep
  // or the user is in another app full-screen, the overlay alone is missable.
  if (!Notification.isSupported()) return
  new Notification({ title: 'Nimbus', body: reminder.text, urgency: 'critical' }).show()
}

export function startReminderScheduler({ onDue }: SchedulerHooks): void {
  if (timer) return

  const tick = (): void => {
    let due: Reminder[]
    try {
      due = claimDueReminders()
    } catch (err) {
      // Never let a bad store kill the interval — that would silently end all
      // future reminders for the rest of the session.
      console.error('[reminders] tick failed:', err)
      return
    }
    for (const reminder of due) {
      console.log(`[reminders] firing: ${reminder.text}`)
      notify(reminder)
      try {
        onDue(reminder)
      } catch (err) {
        console.error('[reminders] handler failed:', err)
      }
    }
  }

  // Anything that came due while the app was closed fires on startup, rather
  // than being lost or waiting a further half minute.
  tick()
  timer = setInterval(tick, TICK_MS)

  const waiting = pendingReminders().length
  if (waiting > 0) console.log(`[reminders] ${waiting} pending`)
}

export function stopReminderScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
