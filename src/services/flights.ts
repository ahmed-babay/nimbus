import type { FlightsCardData, OverheadFlight } from '../shared/types'
import { geocode, homeLocation, type Place } from './maps'
import { httpFetch } from './http'

const STATES_URL = 'https://opensky-network.org/api/states/all'

/** Roughly 50 km each way at this latitude — near enough to be "overhead". */
const BOX_LAT = 0.45
const BOX_LON = 0.7

/** How many make it onto the card. Beyond a few it stops being an answer. */
const MAX_FLIGHTS = 5

/**
 * Live aircraft positions from the OpenSky Network — no key, no signup.
 *
 * This answers "what is that plane overhead", and deliberately nothing more.
 * OpenSky publishes ADS-B *positions*, not schedules: there is no callsign
 * lookup and no departure or arrival time in it, so "is my flight on time" is
 * a question this data genuinely cannot answer. Promising that and returning a
 * position would be worse than not offering it.
 *
 * Anonymous access is rate-limited by area, which is the other reason the
 * query is a small box around one place rather than a wider sweep.
 */

/**
 * One row of `states/all`, which OpenSky sends as a positional array rather
 * than an object. Indexes are from its state-vector documentation.
 */
type StateVector = Array<string | number | boolean | null>

interface StatesResponse {
  states?: StateVector[] | null
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

function compassOf(bearingDeg: number): string {
  const index = Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8
  return COMPASS[index]
}

const toRad = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in kilometres. */
function distanceKm(from: Place, lat: number, lon: number): number {
  const R = 6371
  const dLat = toRad(lat - from.lat)
  const dLon = toRad(lon - from.lon)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Initial bearing from the viewer to the aircraft, in degrees from north. */
function bearingDeg(from: Place, lat: number, lon: number): number {
  const dLon = toRad(lon - from.lon)
  const y = Math.sin(dLon) * Math.cos(toRad(lat))
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(lat)) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180) / Math.PI
}

function toFlight(state: StateVector, from: Place): OverheadFlight | null {
  const callsign = typeof state[1] === 'string' ? state[1].trim() : ''
  const lon = state[5]
  const lat = state[6]
  const onGround = state[8] === true
  const altitude = state[7] ?? state[13]
  const velocity = state[9]
  const track = state[10]

  // A position is the one thing this cannot do without.
  if (typeof lat !== 'number' || typeof lon !== 'number') return null
  // Aircraft sitting at Frankfurt are inside the box but are not overhead.
  if (onGround) return null

  return {
    callsign: callsign || null,
    country: typeof state[2] === 'string' ? state[2] : null,
    distanceKm: Math.round(distanceKm(from, lat, lon)),
    direction: compassOf(bearingDeg(from, lat, lon)),
    altitudeM: typeof altitude === 'number' ? Math.round(altitude) : null,
    // OpenSky reports speed over ground in m/s.
    speedKmh: typeof velocity === 'number' ? Math.round(velocity * 3.6) : null,
    heading: typeof track === 'number' ? compassOf(track) : null
  }
}

export async function overheadFlights(placeName?: string): Promise<FlightsCardData> {
  const place: Place | null = placeName ? await geocode(placeName) : await homeLocation()
  if (!place) {
    throw new Error(
      placeName
        ? `I couldn't find "${placeName}".`
        : "I don't know where you are. Set location.home in config.json."
    )
  }

  const url =
    `${STATES_URL}?lamin=${(place.lat - BOX_LAT).toFixed(4)}` +
    `&lomin=${(place.lon - BOX_LON).toFixed(4)}` +
    `&lamax=${(place.lat + BOX_LAT).toFixed(4)}` +
    `&lomax=${(place.lon + BOX_LON).toFixed(4)}`

  const res = await httpFetch(url, { label: 'OpenSky', timeoutMs: 15000, retries: 1 })

  if (res.status === 429) {
    throw new Error("OpenSky's free limit is used up for now. Try again in a while.")
  }
  if (!res.ok) {
    throw new Error(`The flight lookup failed (${res.status}).`)
  }

  const json = (await res.json()) as StatesResponse
  const flights = (json.states ?? [])
    .map((state) => toFlight(state, place))
    .filter((flight): flight is OverheadFlight => flight !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm)

  return {
    place: place.name.split(',')[0].trim() || place.name,
    // The count is of everything in the sky here, not just what fits on the card.
    total: flights.length,
    flights: flights.slice(0, MAX_FLIGHTS)
  }
}

/**
 * Written out rather than handed to the model: a callsign is a licence plate,
 * and a model that smooths "WZZ9XL" into something pronounceable has changed
 * the answer.
 */
export function describeFlights(data: FlightsCardData): string {
  if (data.total === 0) {
    return `Nothing in the air over ${data.place} right now.`
  }

  const nearest = data.flights[0]
  const what = nearest.callsign ? `${nearest.callsign}` : 'an unidentified aircraft'
  const where = `${nearest.distanceKm} kilometres ${nearest.direction}`
  const height = nearest.altitudeM ? ` at ${nearest.altitudeM.toLocaleString('en-GB')} metres` : ''

  const plural = data.total === 1 ? 'One aircraft' : `${data.total} aircraft`
  return `${plural} over ${data.place}. The closest is ${what}, ${where}${height}.`
}
