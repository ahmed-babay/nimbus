import type { TransitCardData, TransitJourney, TransitLeg } from '../shared/types'
import { httpFetch } from './http'
import config from '../../config.json'

const BASE_URL = 'https://api.transitous.org/api/v1'

// Transitous rejects generic user-agents by policy and asks callers to
// identify themselves: https://transitous.org/
const HEADERS = { 'User-Agent': 'NimbusAssistant/0.1 (personal desktop assistant)' }

interface GeocodeResult {
  type?: string
  name?: string
  id?: string
}

interface MotisLeg {
  mode?: string
  routeShortName?: string
  headsign?: string
  startTime?: string
  endTime?: string
  from?: { name?: string; track?: string }
  to?: { name?: string; track?: string }
  realTime?: boolean
  /**
   * The timetabled time, as opposed to `startTime` which is the live one.
   * The gap between them is the delay, which is what watchers.ts follows.
   */
  scheduledStartTime?: string
  scheduledEndTime?: string
  /** Stable identity for one train, so a watch can follow it across polls. */
  tripId?: string
  cancelled?: boolean
}

/** A single scheduled service, exposed for watchers rather than for display. */
export type PlannedLeg = MotisLeg

interface MotisItinerary {
  startTime?: string
  endTime?: string
  duration?: number
  transfers?: number
  legs?: MotisLeg[]
}

/**
 * Either a place to look up by name, or one whose coordinates are already
 * known. Coordinates are strongly preferred when the caller has them: this
 * router does its own geocoding, and asking two geocoders the same question
 * gets two different answers — "Cologne" resolved to Köln for the map and to
 * a same-named village for the timetable, which turned a 101-minute ICE trip
 * into an eleven-hour bus chain.
 */
export type PlaceRef = string | { lat: number; lon: number; name: string }

function placeLabel(ref: PlaceRef): string {
  return typeof ref === 'string' ? ref : ref.name
}

/** Resolves a place name to a stop the router understands. */
async function findStop(query: string): Promise<GeocodeResult | null> {
  const res = await httpFetch(`${BASE_URL}/geocode?text=${encodeURIComponent(query)}`, {
    headers: HEADERS,
    label: 'Transitous'
  })
  if (!res.ok) return null

  const results = (await res.json()) as GeocodeResult[]
  // Prefer actual stops over streets or addresses with similar names.
  return results.find((r) => r.type === 'STOP' && r.id) ?? results.find((r) => r.id) ?? null
}

// Some legs carry no route name — a replacement bus, an airport transfer —
// leaving only the raw mode code, which reads like an error on a board.
const MODE_LABELS: Record<string, string> = {
  RAIL: 'Train',
  HIGHSPEED_RAIL: 'Train',
  LONG_DISTANCE: 'Train',
  REGIONAL_RAIL: 'Train',
  REGIONAL_FAST_RAIL: 'Train',
  SUBWAY: 'U-Bahn',
  TRAM: 'Tram',
  BUS: 'Bus',
  COACH: 'Coach',
  FERRY: 'Ferry',
  AIR: 'Air'
}

/**
 * MOTIS returns the service number inside the route name — "RB75 (24514)".
 * The line is what you look for on the board; the number is what identifies
 * that specific run, so they're worth keeping apart.
 */
function splitLine(routeName: string): { line: string; number: string | null } {
  const match = routeName.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (!match) return { line: routeName.trim(), number: null }
  return { line: match[1].trim(), number: match[2].trim() }
}

/** MOTIS accepts a "lat,lon" pair anywhere it accepts a stop id. */
async function resolveStop(ref: PlaceRef): Promise<GeocodeResult | null> {
  if (typeof ref !== 'string') {
    return { id: `${ref.lat},${ref.lon}`, name: ref.name, type: 'STOP' }
  }
  return findStop(ref)
}

function clockTime(iso: string | undefined, timeZone: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone
  })
}

/**
 * Public transport departures between two places, via Transitous — a free,
 * key-free routing service built on MOTIS and the national DELFI dataset, so
 * it covers regional trains, S-Bahn, trams and buses rather than only
 * long-distance rail.
 *
 * Chosen over `*.db.transport.rest` (also free and keyless) because that
 * service was returning 503 with an empty body across every attempt while
 * this was building.
 */
/**
 * Resolves a station name to the id the planner needs.
 *
 * Split out of `findJourneys` for watchers, which resolve once at creation and
 * then reuse the id on every poll — re-geocoding "Frankfurt" every thirty
 * seconds would be both wasteful and a way to drift onto a different stop.
 */
export async function resolveStopId(
  query: string | undefined
): Promise<{ id: string; name: string } | null> {
  const target = query || config.transit?.defaultOrigin
  if (!target) return null
  const stop = await resolveStop(target)
  if (!stop?.id) return null
  return { id: stop.id, name: stop.name ?? target }
}

/**
 * The transit legs of the best itineraries, unformatted.
 *
 * `findJourneys` shapes these into something a card can render, which throws
 * away exactly the fields a watcher needs — the scheduled time and the trip
 * id. This returns them intact.
 */
export async function planLegs(
  fromId: string,
  toId: string,
  departAfter?: string
): Promise<PlannedLeg[]> {
  const requested = departAfter ? new Date(departAfter) : new Date()
  const time = Number.isNaN(requested.getTime()) ? new Date() : requested

  const url =
    `${BASE_URL}/plan?fromPlace=${encodeURIComponent(fromId)}` +
    `&toPlace=${encodeURIComponent(toId)}` +
    `&time=${encodeURIComponent(time.toISOString())}` +
    // Wider than the display query: a watcher searches from before its train's
    // scheduled time, so the one it wants may be several departures down.
    '&numItineraries=8'

  const res = await httpFetch(url, { headers: HEADERS, label: 'Transitous', timeoutMs: 15000 })
  if (!res.ok) throw new Error(`Transit lookup failed (${res.status}).`)

  const json = (await res.json()) as { itineraries?: MotisItinerary[] }
  // Flattened across itineraries: the same train appears in several, and a
  // watcher only cares whether its trip id is in there anywhere.
  return (json.itineraries ?? [])
    .flatMap((it) => it.legs ?? [])
    .filter((leg) => leg.mode !== 'WALK' && leg.tripId)
}

export async function findJourneys(
  from: PlaceRef | undefined,
  to: PlaceRef,
  departAfter?: string
): Promise<TransitCardData> {
  const origin = from || config.transit?.defaultOrigin
  if (!origin) {
    throw new Error(
      "I don't know where you're starting from. Say the station, or set transit.defaultOrigin in config.json."
    )
  }

  const [fromStop, toStop] = await Promise.all([resolveStop(origin), resolveStop(to)])
  if (!fromStop?.id) throw new Error(`I couldn't find a stop called "${placeLabel(origin)}".`)
  if (!toStop?.id) throw new Error(`I couldn't find a stop called "${placeLabel(to)}".`)

  // An unparseable time is better ignored than allowed to throw — "now" is
  // almost always what was meant.
  const requested = departAfter ? new Date(departAfter) : new Date()
  const time = Number.isNaN(requested.getTime()) ? new Date() : requested

  const url =
    `${BASE_URL}/plan?fromPlace=${encodeURIComponent(fromStop.id)}` +
    `&toPlace=${encodeURIComponent(toStop.id)}` +
    `&time=${encodeURIComponent(time.toISOString())}` +
    '&numItineraries=5'

  const res = await httpFetch(url, { headers: HEADERS, label: 'Transitous', timeoutMs: 15000 })
  if (!res.ok) throw new Error(`Transit lookup failed (${res.status}).`)

  const json = (await res.json()) as { itineraries?: MotisItinerary[] }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const journeys: TransitJourney[] = (json.itineraries ?? []).slice(0, 4).map((it) => {
    // Walking legs are noise for "which train do I take" — the transfers
    // count already conveys that there's a change involved.
    const legs: TransitLeg[] = (it.legs ?? [])
      .filter((leg) => leg.mode !== 'WALK' && (leg.routeShortName || leg.headsign))
      .map((leg) => ({
        ...splitLine(
          leg.routeShortName || (leg.mode ? (MODE_LABELS[leg.mode] ?? leg.mode) : '')
        ),
        direction: leg.headsign ?? '',
        from: leg.from?.name ?? '',
        to: leg.to?.name ?? '',
        departs: clockTime(leg.startTime, timeZone),
        arrives: clockTime(leg.endTime, timeZone),
        platform: leg.from?.track ?? null
      }))

    return {
      departs: clockTime(it.startTime, timeZone),
      arrives: clockTime(it.endTime, timeZone),
      departsAt: it.startTime ?? '',
      durationMinutes: Math.round((it.duration ?? 0) / 60),
      changes: Math.max(0, legs.length - 1),
      legs
    }
  })

  const withService = journeys.filter((j) => j.legs.length > 0)

  return {
    from: fromStop.name ?? placeLabel(origin),
    to: toStop.name ?? placeLabel(to),
    journeys: withService.length > 0 ? withService : journeys
  }
}
