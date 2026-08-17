import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { outdoorConditions } from './outdoors'

/**
 * Waiting for the weather to be worth going out in.
 *
 * "Tell me when it's a good time for a run" is the sort of thing a chat
 * assistant physically cannot do. It has no way to still be thinking about you
 * in ninety minutes. A tray app does, and that — not the quality of the
 * sentence it writes back — is the thing worth building around.
 *
 * Two shapes, because they are the two questions people actually ask:
 *
 *  - **`good`** — go quiet until conditions are decent, then say so once.
 *  - **`rain`** — say something when rain becomes likely, so a bike or a
 *    washing line can be dealt with before it arrives.
 *
 * Kept in its own store rather than folded into the train watcher: they poll
 * different services at different rates and expire on completely different
 * rules, and sharing a record type would mean half its fields were always
 * null.
 */

/** Free, keyless, and polled gently — this is somebody's donated bandwidth. */
const CHECK_EVERY_MS = 10 * 60 * 1000

/** Given up on after this long, so a forgotten watch isn't polled forever. */
const EXPIRE_MS = 12 * 60 * 60 * 1000

/** Rain worth warning about, as a percentage chance. */
const RAIN_THRESHOLD = 60

const MAX_WATCHES = 10

export interface OutdoorWatch {
  id: string
  mode: 'good' | 'rain'
  /** Empty means wherever the user is. */
  place: string
  createdAt: string
  lastCheckedAt: string
  /** Set once it has fired, so it says its piece exactly once. */
  firedAt?: string
}

interface WatchFile {
  version: 1
  watches: OutdoorWatch[]
}

let cache: WatchFile | null = null
let storePath: string | null = null

function path(): string {
  if (!storePath) storePath = join(app.getPath('userData'), 'outdoor-watches.json')
  return storePath
}

function load(): WatchFile {
  if (cache) return cache
  try {
    if (!existsSync(path())) {
      cache = { version: 1, watches: [] }
      return cache
    }
    const parsed = JSON.parse(readFileSync(path(), 'utf8')) as Partial<WatchFile>
    cache = { version: 1, watches: Array.isArray(parsed.watches) ? parsed.watches : [] }
  } catch (err) {
    console.error('[outdoor-watch] could not read store, starting empty:', err)
    cache = { version: 1, watches: [] }
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
    console.error('[outdoor-watch] could not write store:', err)
  }
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function activeOutdoorWatches(): OutdoorWatch[] {
  return load().watches
}

export function cancelOutdoorWatchById(target: string): boolean {
  const store = load()
  const before = store.watches.length
  store.watches = store.watches.filter((watch) => watch.id !== target)
  if (store.watches.length === before) return false
  save()
  return true
}

/**
 * Whether the user wants to be told later rather than now.
 *
 * Deliberately narrower than the transit equivalent: "is it a good time for a
 * run" is a question about *now* and must stay one. Only an explicit future
 * framing — "tell me when", "let me know when" — turns it into a watch.
 */
export function wantsOutdoorWatch(utterance: string): boolean {
  return /\b(tell me when|let me know when|notify me when|when it('s| is) (good|better|dry|clear)|when the rain stops|if it('s| is) going to rain|if it will rain|when it stops raining)\b/i.test(
    utterance
  )
}

/** Rain if they mentioned it, otherwise a window to go out in. */
export function outdoorWatchMode(utterance: string): OutdoorWatch['mode'] {
  return /\brain|shower|wet|umbrella|washing\b/i.test(utterance) ? 'rain' : 'good'
}

export interface OutdoorWatchConfirmation {
  watch: OutdoorWatch
  speech: string
}

export async function watchOutdoors(
  mode: OutdoorWatch['mode'],
  place?: string
): Promise<OutdoorWatchConfirmation> {
  const store = load()
  if (store.watches.length >= MAX_WATCHES) {
    throw new Error("I'm already watching the weather for as much as I can keep track of.")
  }

  // Checked immediately so the confirmation can say what it's like *now* —
  // and so an impossible place fails here rather than silently never firing.
  const now = await outdoorConditions(place)

  const watch: OutdoorWatch = {
    id: id(),
    mode,
    place: place ?? '',
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString()
  }
  store.watches.push(watch)
  save()

  // For a good verdict, how it feels; for a bad one, whatever is worst —
  // which is exactly the reason it isn't good yet.
  const feel = now.factors.find((factor) => factor.kind === 'feel')
  const worst = now.factors[0]

  const speech =
    mode === 'rain'
      ? `Right now there's a ${now.rainChance}% chance of rain in ${now.place}. I'll tell you if that turns into a real risk.`
      : now.verdict === 'great' || now.verdict === 'fine'
        ? `It's already decent in ${now.place} — ${(feel ?? worst)?.text.toLowerCase()}. I'll keep watching in case that changes.`
        : `Not great in ${now.place} right now — ${worst?.text.toLowerCase()}. I'll tell you when it improves.`

  return { watch, speech }
}

export interface OutdoorUpdate {
  watch: OutdoorWatch
  speech: string
}

/**
 * Polls each watch and returns the ones with something to say.
 *
 * Each fires at most once and is then dropped: the point is a single well-timed
 * nudge, and an assistant that says "it's nice out" every ten minutes is one
 * that gets uninstalled.
 */
export async function checkOutdoorWatches(now = Date.now()): Promise<OutdoorUpdate[]> {
  const store = load()
  if (store.watches.length === 0) return []

  const updates: OutdoorUpdate[] = []
  const keep: OutdoorWatch[] = []

  for (const watch of store.watches) {
    if (now - new Date(watch.createdAt).getTime() > EXPIRE_MS) continue
    if (now - new Date(watch.lastCheckedAt).getTime() < CHECK_EVERY_MS) {
      keep.push(watch)
      continue
    }

    let conditions: Awaited<ReturnType<typeof outdoorConditions>>
    try {
      conditions = await outdoorConditions(watch.place || undefined)
    } catch (err) {
      // A failed lookup is not news; keep the watch and try again next tick.
      console.warn('[outdoor-watch] check failed, will retry:', err)
      keep.push(watch)
      continue
    }

    watch.lastCheckedAt = new Date().toISOString()

    if (watch.mode === 'rain') {
      if (conditions.rainChance >= RAIN_THRESHOLD) {
        updates.push({
          watch,
          speech: `Rain looks likely in ${conditions.place} — ${conditions.rainChance}% within the next few hours.`
        })
        continue
      }
    } else if (conditions.verdict === 'great' || conditions.verdict === 'fine') {
      // How it feels, not the worst factor. `factors[0]` is whatever is least
      // good, which on a fine day is something like "air is moderate" — a
      // reason *not* to go, offered as the reason to go.
      const feel = conditions.factors.find((factor) => factor.kind === 'feel')
      updates.push({
        watch,
        speech: feel
          ? `Good window to head out in ${conditions.place} — ${feel.text.toLowerCase()}.`
          : `Good window to head out in ${conditions.place}.`
      })
      continue
    }

    keep.push(watch)
  }

  store.watches = keep
  save()
  return updates
}
