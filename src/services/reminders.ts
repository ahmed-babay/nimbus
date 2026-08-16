import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Reminder } from '../shared/types'

/**
 * Reminders that survive a restart.
 *
 * Kept in its own file rather than inside `memory.json` because the two have
 * different shapes of risk: memory is append-mostly and can tolerate being a
 * little stale, while a reminder that quietly fails to persist is a broken
 * promise. Separate files also mean a corrupt archive can't take the alarms
 * down with it.
 *
 * Firing lives in `src/main/reminder-scheduler.ts` — this module only owns
 * the list.
 */

const MAX_REMINDERS = 200

interface ReminderFile {
  version: 1
  reminders: Reminder[]
}

let cache: ReminderFile | null = null
let storePath: string | null = null

function path(): string {
  if (!storePath) storePath = join(app.getPath('userData'), 'reminders.json')
  return storePath
}

function load(): ReminderFile {
  if (cache) return cache
  try {
    if (!existsSync(path())) {
      cache = { version: 1, reminders: [] }
      return cache
    }
    const parsed = JSON.parse(readFileSync(path(), 'utf8')) as Partial<ReminderFile>
    cache = { version: 1, reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [] }
  } catch (err) {
    console.error('[reminders] could not read store, starting empty:', err)
    cache = { version: 1, reminders: [] }
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
    console.error('[reminders] could not write store:', err)
  }
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function addReminder(reminder: Omit<Reminder, 'id' | 'fired'>): Reminder {
  const store = load()
  const created: Reminder = { ...reminder, id: id(), fired: false }
  store.reminders.push(created)
  if (store.reminders.length > MAX_REMINDERS) {
    // Oldest fired ones go first; a pending reminder is never dropped to make
    // room for a new one.
    store.reminders = [
      ...store.reminders.filter((item) => !item.fired),
      ...store.reminders.filter((item) => item.fired)
    ].slice(0, MAX_REMINDERS)
  }
  save()
  return created
}

/** Reminders still waiting to fire, soonest first. */
export function pendingReminders(): Reminder[] {
  return load()
    .reminders.filter((reminder) => !reminder.fired)
    .sort((a, b) => a.at.localeCompare(b.at))
}

/** Anything due now, marked fired in the same step so it can't fire twice. */
export function claimDueReminders(now = Date.now()): Reminder[] {
  const store = load()
  const due = store.reminders.filter(
    (reminder) => !reminder.fired && new Date(reminder.at).getTime() <= now
  )
  if (due.length === 0) return []

  for (const reminder of due) reminder.fired = true
  save()
  return due
}

/** Cancels pending reminders matching a phrase. Returns what was cancelled. */
export function cancelReminders(phrase: string): Reminder[] {
  const needle = phrase.trim().toLowerCase()
  const store = load()
  const pending = store.reminders.filter((reminder) => !reminder.fired)
  // An empty phrase means "cancel my reminders" — all of them.
  const matched = needle
    ? pending.filter((reminder) => reminder.text.toLowerCase().includes(needle))
    : pending
  if (matched.length === 0) return []

  store.reminders = store.reminders.filter((reminder) => !matched.includes(reminder))
  save()
  return matched
}
