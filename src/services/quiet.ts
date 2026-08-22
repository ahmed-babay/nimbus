import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import config from '../../config.json'

/**
 * When Nimbus is allowed to speak first.
 *
 * Everything else in this app is asked for. Watches, reminders and delay
 * alerts are not: they arrive unasked, which is the whole point of them and
 * also the fastest way to get an app deleted. An assistant that says "your
 * train is delayed" at two in the morning, or over a presentation, does not
 * get a second chance to be useful.
 *
 * Two controls, because they answer different questions. Quiet hours are a
 * standing rule about the night. Do not disturb is a switch for right now.
 */

export interface QuietSettings {
  /** 24h "HH:MM". Quiet from this time until `until`, crossing midnight. */
  from: string
  until: string
  enabled: boolean
  /** Manual switch, independent of the clock. */
  doNotDisturb: boolean
}

const DEFAULTS: QuietSettings = {
  // Sensible for someone who has to catch a train in the morning: silent
  // overnight, awake again before any realistic commute.
  from: '22:00',
  until: '07:00',
  enabled: true,
  doNotDisturb: false
}

let cache: QuietSettings | null = null

function file(): string {
  return join(app.getPath('userData'), 'quiet.json')
}

export function quietSettings(): QuietSettings {
  if (cache) return cache
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<QuietSettings>
      const merged: QuietSettings = { ...DEFAULTS, ...config.quietHours, ...parsed }
      cache = merged
      return merged
    }
  } catch {
    // A corrupt settings file should not silence the app for ever.
  }
  const merged: QuietSettings = { ...DEFAULTS, ...config.quietHours }
  cache = merged
  return merged
}

export function setQuietSettings(next: Partial<QuietSettings>): QuietSettings {
  const merged = { ...quietSettings(), ...next }
  cache = merged
  try {
    writeFileSync(file(), JSON.stringify(merged, null, 2))
  } catch {
    // Not fatal — it just won't survive a restart.
  }
  return merged
}

/** Minutes since midnight, or null if the string isn't a time. */
function minutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/**
 * Whether the clock currently falls inside quiet hours.
 *
 * Handles the window crossing midnight, which is the normal case: 22:00 to
 * 07:00 is not "22:00 <= now <= 07:00", and getting that wrong means either
 * silence all day or no silence at all.
 */
export function withinQuietHours(now = new Date()): boolean {
  const settings = quietSettings()
  if (!settings.enabled) return false

  const from = minutes(settings.from)
  const until = minutes(settings.until)
  if (from === null || until === null) return false
  if (from === until) return false

  const current = now.getHours() * 60 + now.getMinutes()
  return from < until
    ? current >= from && current < until
    : current >= from || current < until
}

/** Why Nimbus is staying quiet, or null when it may speak. */
export function silenceReason(now = new Date()): string | null {
  const settings = quietSettings()
  if (settings.doNotDisturb) return 'do not disturb'
  if (withinQuietHours(now)) return `quiet hours (${settings.from}-${settings.until})`
  return null
}

/** The one question the schedulers ask before interrupting anyone. */
export function mayInterrupt(now = new Date()): boolean {
  return silenceReason(now) === null
}
