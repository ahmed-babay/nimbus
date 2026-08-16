import { findJourneys } from './transit'
import { geocode, homeLocation } from './maps'
import type { Reminder, TransitJourney } from '../shared/types'

/**
 * "Tell me when I need to leave to catch the last train to Frankfurt."
 *
 * This is the thing a general-purpose assistant structurally cannot do: it
 * needs a live timetable and a door-to-door plan, and it has to subtract one
 * from the other. Both already exist here.
 *
 * The walk is free to account for. Because the journey planner is given
 * coordinates rather than a station name, MOTIS plans door-to-door and puts a
 * walking leg on the front — so the itinerary's own start time is already the
 * moment you have to be out of the door, and the first *transit* leg's
 * departure is when the train actually goes. The difference between them is
 * the walk, with no second routing request.
 */

/** Time to put your coat on, and slack against a slightly optimistic router. */
const BUFFER_MINUTES = 3

/** Ignore departures too close to be actionable — you have already missed them. */
const MIN_NOTICE_MINUTES = 2

function minutesBetween(fromClock: string, toClock: string): number {
  // The legs carry clock strings; the itinerary carries an ISO timestamp. Only
  // the gap matters, so compare the two clock values.
  const parse = (value: string): number | null => {
    const match = value.match(/^(\d{1,2}):(\d{2})/)
    return match ? Number(match[1]) * 60 + Number(match[2]) : null
  }
  const start = parse(fromClock)
  const board = parse(toClock)
  if (start === null || board === null) return 0
  const diff = board >= start ? board - start : board + 24 * 60 - start
  // A gap of hours means the legs weren't what we assumed; don't invent a walk.
  return diff > 180 ? 0 : diff
}

export interface DepartureAlarm {
  at: string
  text: string
  departure: NonNullable<Reminder['departure']>
  journey: TransitJourney
}

export async function planDepartureAlarm(
  to: string,
  from?: string
): Promise<DepartureAlarm> {
  const origin = from ? await geocode(from) : await homeLocation()
  if (!origin) {
    throw new Error("I don't know where you're starting from. Set location.home in config.json.")
  }

  const destination = await geocode(to, origin)
  if (!destination) throw new Error(`I couldn't find "${to}" on the map.`)

  const plan = await findJourneys(origin, destination)
  const now = Date.now()

  // The soonest journey you could still realistically catch.
  const journey = plan.journeys.find((candidate) => {
    const leaveAt = new Date(candidate.departsAt).getTime()
    return Number.isFinite(leaveAt) && leaveAt - now > MIN_NOTICE_MINUTES * 60_000
  })
  if (!journey) throw new Error(`I couldn't find an upcoming connection to ${plan.to}.`)

  const boarding = journey.legs[0]
  const travelMinutes = boarding
    ? minutesBetween(journey.departs, boarding.departs)
    : 0

  const leaveAt = new Date(new Date(journey.departsAt).getTime() - BUFFER_MINUTES * 60_000)
  const line = boarding?.line || 'your connection'
  // Geocoded names come back postal-style — "Frankfurt (Main) Hauptbahnhof,
  // Mannheimer Straße" — which is unbearable read aloud. The leading segment
  // is the part anyone would actually say.
  const destinationName = plan.to.split(',')[0].trim()
  const text = boarding
    ? `Time to leave for the ${line} at ${boarding.departs} to ${destinationName}.`
    : `Time to leave for ${destinationName}.`

  return {
    at: leaveAt.toISOString(),
    text,
    departure: {
      line,
      departs: boarding?.departs || journey.departs,
      from: plan.from.split(',')[0].trim(),
      to: destinationName,
      travelMinutes
    },
    journey
  }
}
