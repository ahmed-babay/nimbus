import { activeWatches, cancelWatchById } from './watchers'
import { upcomingEvents, removeEventById } from './events'
import { pendingReminders, cancelReminderById } from './reminders'
import { activeOutdoorWatches, cancelOutdoorWatchById } from './outdoor-watch'
import { priceAlerts, cancelPriceAlertById } from './watchlist'
import type { StandingItem } from '../shared/types'

/**
 * Everything Nimbus has promised to do, in one list.
 *
 * The three stores were built at different times for different reasons —
 * reminders fire once, events are days in a diary, watches follow a train —
 * and until now the only way to see any of them was to ask a question whose
 * answer happened to include them. That is fine for one reminder and useless
 * for the real question, which is "what is this thing quietly holding for me".
 *
 * Sorted by when each comes up rather than grouped by type, because the
 * ordering that matters is time. A train in twenty minutes belongs above a
 * birthday next week regardless of which store it came from.
 */

/** Day-granularity events have no clock time; noon keeps them inside the day. */
function eventInstant(startDate: string): string {
  return `${startDate}T12:00:00`
}

function clock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function day(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  if (sameDay) return 'today'

  const tomorrow = new Date(today.getTime() + 86400_000)
  if (date.toDateString() === tomorrow.toDateString()) return 'tomorrow'

  return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

export function standingItems(): StandingItem[] {
  const items: StandingItem[] = []

  for (const watch of activeWatches()) {
    const late = watch.reportedDelayMin
    items.push({
      id: watch.id,
      kind: 'watch',
      title: `${watch.line || 'Train'} to ${watch.to}`,
      detail: `${clock(watch.scheduledDeparture)} from ${watch.from} · ${day(watch.scheduledDeparture)}`,
      at: watch.scheduledDeparture,
      // Surfaced as a warning rather than folded into the detail line: the
      // whole reason this watch exists is to notice exactly this.
      warning: watch.reportedCancelled
        ? 'Cancelled'
        : late >= 2
          ? `${late} min late`
          : undefined
    })
  }

  for (const watch of activeOutdoorWatches()) {
    items.push({
      id: watch.id,
      kind: 'outdoor',
      title:
        watch.mode === 'rain'
          ? `Warn me if rain looks likely${watch.place ? ` in ${watch.place}` : ''}`
          : `Tell me when it's good to go out${watch.place ? ` in ${watch.place}` : ''}`,
      // Sorted with everything else by time, so it needs one: checking
      // continues from now, which is what "when" means for these.
      detail: 'checking every 10 min',
      at: watch.createdAt
    })
  }

  for (const alert of priceAlerts()) {
    items.push({
      id: alert.id,
      kind: 'price',
      title: `${alert.symbol} ${alert.direction} ${alert.price}`,
      detail: 'checking every few minutes',
      at: alert.createdAt
    })
  }

  for (const event of upcomingEvents()) {
    const at = eventInstant(event.startDate)
    items.push({
      id: event.id,
      kind: 'event',
      title: event.title,
      detail: [day(at), event.location].filter(Boolean).join(' · '),
      at
    })
  }

  for (const reminder of pendingReminders()) {
    items.push({
      id: reminder.id,
      kind: 'reminder',
      title: reminder.text,
      detail: `${clock(reminder.at)} · ${day(reminder.at)}`,
      at: reminder.at
    })
  }

  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  return items
}

/** Routes a cancellation to whichever store owns that kind of thing. */
export function cancelStandingItem(kind: StandingItem['kind'], id: string): boolean {
  if (kind === 'watch') return cancelWatchById(id)
  if (kind === 'outdoor') return cancelOutdoorWatchById(id)
  if (kind === 'price') return cancelPriceAlertById(id)
  if (kind === 'event') return removeEventById(id)
  return cancelReminderById(id)
}
