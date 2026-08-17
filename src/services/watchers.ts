import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveStopId, planLegs, type PlannedLeg } from './transit'

/**
 * Standing questions about a train.
 *
 * "I'm taking the 17:30 to Frankfurt — confirm it and tell me if it's
 * delayed." Everything needed is already in the timetable API and costs
 * nothing: each leg carries both `scheduledStartTime` and `startTime`, and the
 * difference between them *is* the delay. So this is a stored trip plus a
 * poll, not a new integration.
 *
 * The train is followed by `tripId` rather than by time, which matters because
 * time is the thing that changes. Re-planning a route and taking "the
 * departure nearest 17:30" would silently follow a *different* train once the
 * one being watched slipped past the next one.
 *
 * Updates are only raised when the delay actually moves. A watcher that
 * announced "still on time" every minute would be turned off within the hour,
 * and then it wouldn't be there for the one delay that mattered.
 */

/**
 * Whether the user asked to be kept informed, rather than just told once.
 *
 * A phrase list rather than a model call: this runs on an utterance that has
 * already been classified and routed, and spending another round trip to
 * decide "did they say keep me posted" would add a second of latency to every
 * transit question for a yes/no.
 */
export function wantsWatching(utterance: string): boolean {
  return /\b(keep me (updated|posted|informed)|let me know|tell me if|notify me|watch (it|this|that|the train)|track (it|this|the train)|any delays?|if it('s| is)? (delayed|late|cancelled))\b/i.test(
    utterance
  )
}

/** Nothing is followed forever: a watch dies once its train has gone. */
const KEEP_AFTER_DEPARTURE_MS = 10 * 60 * 1000

/** Below this, a change isn't worth interrupting anyone for. */
const NOTIFY_THRESHOLD_MIN = 2

/**
 * How far before the scheduled departure to start looking when re-checking.
 *
 * The planner returns departures strictly *after* the time it is given, so
 * asking it for the watched train's own scheduled time returns everything
 * except that train. Without this lead the trip is never found again and the
 * watcher goes silent — which is the one failure mode a delay alert cannot
 * have, because it looks exactly like "no delays".
 */
const SEARCH_LEAD_MS = 20 * 60 * 1000

const MAX_WATCHES = 20

export interface Watch {
  id: string
  /** Station names as the user would say them, for the spoken line. */
  from: string
  to: string
  fromId: string
  toId: string
  /** Identity of the exact train being followed. */
  tripId: string
  line: string
  headsign: string
  /** ISO, as timetabled. This never moves; `startTime` does. */
  scheduledDeparture: string
  /** Minutes late at the last check, so only changes are announced. */
  reportedDelayMin: number
  reportedCancelled: boolean
  createdAt: string
}

interface WatchFile {
  version: 1
  watches: Watch[]
}

let cache: WatchFile | null = null
let storePath: string | null = null

function path(): string {
  if (!storePath) storePath = join(app.getPath('userData'), 'watches.json')
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
    console.error('[watchers] could not read store, starting empty:', err)
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
    console.error('[watchers] could not write store:', err)
  }
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function activeWatches(): Watch[] {
  return load().watches
}

/** Stops following one journey, for the delete button beside it. */
export function cancelWatchById(id: string): boolean {
  const store = load()
  const before = store.watches.length
  store.watches = store.watches.filter((watch) => watch.id !== id)
  if (store.watches.length === before) return false
  save()
  return true
}

export function cancelWatches(): number {
  const store = load()
  const removed = store.watches.length
  store.watches = []
  save()
  return removed
}

/** Minutes late, from the two times the API already returns. */
function delayMinutes(leg: PlannedLeg): number {
  if (!leg.startTime || !leg.scheduledStartTime) return 0
  const actual = new Date(leg.startTime).getTime()
  const scheduled = new Date(leg.scheduledStartTime).getTime()
  if (Number.isNaN(actual) || Number.isNaN(scheduled)) return 0
  return Math.round((actual - scheduled) / 60000)
}

function clock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export interface WatchConfirmation {
  watch: Watch
  /** What to say back straight away, confirming what is now being followed. */
  speech: string
}

/**
 * Confirms a train and starts following it.
 *
 * The requested time is a hint, not a filter — someone saying "around 17:30"
 * means the departure nearest that, which may well be 17:32.
 */
export async function watchJourney(
  from: string | undefined,
  to: string,
  departAfter?: string
): Promise<WatchConfirmation> {
  const store = load()
  if (store.watches.length >= MAX_WATCHES) {
    throw new Error("I'm already watching as many journeys as I can keep track of.")
  }

  const [fromStop, toStop] = await Promise.all([resolveStopId(from), resolveStopId(to)])
  if (!fromStop) throw new Error(`I couldn't find a stop called "${from}".`)
  if (!toStop) throw new Error(`I couldn't find a stop called "${to}".`)

  const legs = await planLegs(fromStop.id, toStop.id, departAfter)
  const leg = legs[0]
  if (!leg?.tripId || !leg.scheduledStartTime) {
    throw new Error("I couldn't find a train to watch on that route.")
  }

  const watch: Watch = {
    id: id(),
    from: fromStop.name,
    to: toStop.name,
    fromId: fromStop.id,
    toId: toStop.id,
    tripId: leg.tripId,
    line: leg.routeShortName ?? '',
    headsign: leg.headsign ?? '',
    scheduledDeparture: leg.scheduledStartTime,
    reportedDelayMin: delayMinutes(leg),
    reportedCancelled: leg.cancelled === true,
    createdAt: new Date().toISOString()
  }

  store.watches.push(watch)
  save()

  const late = watch.reportedDelayMin
  const status =
    late >= NOTIFY_THRESHOLD_MIN
      ? ` It's currently running ${late} minutes late.`
      : ' It’s on time right now.'

  return {
    watch,
    speech:
      `The ${watch.line || 'train'} to ${watch.to} leaves ${watch.from} at ` +
      `${clock(watch.scheduledDeparture)}.${status} I'll tell you if that changes.`
  }
}

export interface WatchUpdate {
  watch: Watch
  /** Already phrased as the line to speak. */
  speech: string
}

/**
 * Re-checks every watch and returns only the ones whose story changed.
 *
 * Called on a timer from the main process. Failures are swallowed per watch:
 * one unreachable lookup must not stop the others from being checked, and a
 * transient network blip is not news.
 */
export async function checkWatches(now = Date.now()): Promise<WatchUpdate[]> {
  const store = load()
  if (store.watches.length === 0) return []

  const updates: WatchUpdate[] = []
  const keep: Watch[] = []

  for (const watch of store.watches) {
    let leg: PlannedLeg | undefined
    try {
      const from = new Date(
        new Date(watch.scheduledDeparture).getTime() - SEARCH_LEAD_MS
      ).toISOString()
      const legs = await planLegs(watch.fromId, watch.toId, from)
      // By identity, not by position — the nearest departure may no longer be
      // the train the user is actually taking.
      leg = legs.find((candidate) => candidate.tripId === watch.tripId)
    } catch (err) {
      console.warn('[watchers] check failed, will retry:', err)
      keep.push(watch)
      continue
    }

    if (!leg) {
      // The trip fell out of the timetable entirely. Nothing useful to say,
      // and re-planning would follow the wrong train, so let it go.
      const departed = new Date(watch.scheduledDeparture).getTime()
      if (now < departed + KEEP_AFTER_DEPARTURE_MS) keep.push(watch)
      continue
    }

    const late = delayMinutes(leg)
    const cancelled = leg.cancelled === true
    const actual = leg.startTime ?? watch.scheduledDeparture

    if (cancelled && !watch.reportedCancelled) {
      updates.push({
        watch,
        speech: `Your ${watch.line || 'train'} to ${watch.to} has been cancelled.`
      })
    } else if (!cancelled && Math.abs(late - watch.reportedDelayMin) >= NOTIFY_THRESHOLD_MIN) {
      updates.push({
        watch,
        speech:
          late < NOTIFY_THRESHOLD_MIN
            ? `Your ${watch.line || 'train'} to ${watch.to} is back on time, leaving at ${clock(actual)}.`
            : `Your ${watch.line || 'train'} to ${watch.to} is now ${late} minutes late, leaving at ${clock(actual)}.`
      })
    }

    watch.reportedDelayMin = late
    watch.reportedCancelled = cancelled

    // Kept a little past departure so a delay announced at the last moment
    // still has somewhere to land.
    const departsAt = new Date(actual).getTime()
    if (Number.isNaN(departsAt) || now < departsAt + KEEP_AFTER_DEPARTURE_MS) keep.push(watch)
  }

  store.watches = keep
  save()
  return updates
}
