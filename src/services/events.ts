import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CalendarEvent } from '../shared/types'

/**
 * Things happening on particular days that you told Nimbus about — "I'm in
 * Düsseldorf for the Reply Leadvise event from the 24th to the 27th", "my
 * girlfriend's birthday on Saturday".
 *
 * Distinct from both neighbours on purpose. A *fact* (`memory.ts`) is true
 * until you change it; a *reminder* (`reminders.ts`) fires once at a minute
 * and is then finished. An event occupies one or more whole days, is worth
 * mentioning on each of them, and stops existing on its own once the last day
 * has passed — none of which the other two do.
 *
 * Day granularity throughout: dates are stored as YYYY-MM-DD, because "the
 * 24th to the 27th" has no meaningful time of day and pretending otherwise
 * only creates timezone bugs.
 */

const MAX_EVENTS = 200

interface EventFile {
  version: 1
  events: CalendarEvent[]
}

let cache: EventFile | null = null
let storePath: string | null = null

function path(): string {
  if (!storePath) storePath = join(app.getPath('userData'), 'events.json')
  return storePath
}

/** Today as YYYY-MM-DD in local time, which is the user's sense of "today". */
export function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function lastDay(event: CalendarEvent): string {
  return event.endDate || event.startDate
}

function load(): EventFile {
  if (cache) return cache
  try {
    if (!existsSync(path())) {
      cache = { version: 1, events: [] }
      return cache
    }
    const parsed = JSON.parse(readFileSync(path(), 'utf8')) as Partial<EventFile>
    cache = { version: 1, events: Array.isArray(parsed.events) ? parsed.events : [] }
  } catch (err) {
    console.error('[events] could not read store, starting empty:', err)
    cache = { version: 1, events: [] }
  }

  // Expire on read rather than on a schedule: an event whose last day has
  // passed should never be mentioned again, and this is the only place that
  // can guarantee it regardless of how long the app has been shut.
  const stale = cache.events.filter((event) => lastDay(event) < today())
  if (stale.length > 0) {
    cache.events = cache.events.filter((event) => lastDay(event) >= today())
    save()
    console.log(`[events] dropped ${stale.length} finished event(s)`)
  }
  return cache
}

function save(): void {
  if (!cache) return
  try {
    const temp = `${path()}.tmp`
    writeFileSync(temp, JSON.stringify(cache), 'utf8')
    renameSync(temp, path())
  } catch (err) {
    console.error('[events] could not write store:', err)
  }
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function addEvent(input: {
  title: string
  startDate: string
  endDate?: string
  location?: string
}): CalendarEvent {
  const title = input.title.trim()
  if (!title) throw new Error("I didn't catch what the event is.")
  if (!DATE_PATTERN.test(input.startDate)) {
    throw new Error("I didn't catch what day that is.")
  }
  // A range that ends before it starts is a mis-parse, not a real event; keep
  // the start and drop the nonsense end rather than storing something that
  // would expire immediately.
  const endDate =
    input.endDate && DATE_PATTERN.test(input.endDate) && input.endDate >= input.startDate
      ? input.endDate
      : undefined

  const store = load()
  const event: CalendarEvent = {
    id: id(),
    title,
    startDate: input.startDate,
    ...(endDate ? { endDate } : {}),
    ...(input.location?.trim() ? { location: input.location.trim() } : {}),
    createdAt: new Date().toISOString()
  }
  store.events.push(event)
  if (store.events.length > MAX_EVENTS) store.events = store.events.slice(-MAX_EVENTS)
  save()
  return event
}

/** Everything still to come, soonest first. Finished events are already gone. */
export function upcomingEvents(withinDays?: number): CalendarEvent[] {
  const events = load().events.slice().sort((a, b) => a.startDate.localeCompare(b.startDate))
  if (withinDays === undefined) return events

  const limit = new Date()
  limit.setDate(limit.getDate() + withinDays)
  const cutoff = limit.toISOString().slice(0, 10)
  // Includes anything already running, even if it started before the window.
  return events.filter((event) => event.startDate <= cutoff)
}

/** Events covering today — the ones a briefing should lead with. */
export function eventsToday(): CalendarEvent[] {
  const now = today()
  return load().events.filter((event) => event.startDate <= now && lastDay(event) >= now)
}

/**
 * Drops one event by id, for a delete button rather than a spoken phrase.
 * `removeEvents` matches on the title, which would take both of two similarly
 * named days at once.
 */
export function removeEventById(id: string): boolean {
  const store = load()
  const before = store.events.length
  store.events = store.events.filter((event) => event.id !== id)
  if (store.events.length === before) return false
  save()
  return true
}

export function removeEvents(phrase: string): CalendarEvent[] {
  const needle = phrase.trim().toLowerCase()
  const store = load()
  const matched = needle
    ? store.events.filter(
        (event) =>
          event.title.toLowerCase().includes(needle) ||
          (event.location ?? '').toLowerCase().includes(needle)
      )
    : store.events.slice()
  if (matched.length === 0) return []

  store.events = store.events.filter((event) => !matched.includes(event))
  save()
  return matched
}
