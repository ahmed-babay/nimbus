import { httpFetch } from './http'
import { fetchImagesAsDataUris } from './images'
import { findJourneys } from './transit'
import type {
  DirectionsCardData,
  MapTile,
  RouteOption,
  TravelMode,
  TransitCardData
} from '../shared/types'
import config from '../../config.json'

/**
 * Distances, travel times and a drawn map — the "how far is that and how long
 * to get there" question — built entirely on keyless services:
 *
 * - **Nominatim** (OpenStreetMap) for turning a place name into coordinates.
 * - **Valhalla** on the FOSSGIS servers for routing. Chosen over the OSRM demo
 *   server because OSRM's public instance only carries the car profile: asking
 *   it for a walking route returns car speeds (it put 4.1 km on foot at nine
 *   minutes), whereas Valhalla answers auto, pedestrian and bicycle separately
 *   and correctly — the same trip came back as 12 min driving, 13 cycling and
 *   40 walking.
 * - **Transitous** for the public-transport option, reusing the same departure
 *   lookup the transit card uses, so "by public transport" gives real services
 *   rather than an estimate.
 * - **OpenStreetMap tiles** for the map itself.
 *
 * All of them ask callers to identify themselves and to keep usage light,
 * which is why every request here carries a descriptive User-Agent and why a
 * lookup fetches a dozen tiles rather than a live pannable map.
 */

const HEADERS = { 'User-Agent': 'NimbusAssistant/0.1 (personal desktop assistant)' }
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const VALHALLA = 'https://valhalla1.openstreetmap.de/route'
const TILE_URL = 'https://tile.openstreetmap.org'

export interface Place {
  name: string
  lat: number
  lon: number
}

interface NominatimResult {
  display_name?: string
  name?: string
  lat?: string
  lon?: string
}

/**
 * Resolves a place name to coordinates, biased towards the user's own area so
 * "the botanical garden" means the local one rather than the most famous one
 * in the world.
 */
export async function geocode(query: string, near?: Place): Promise<Place | null> {
  const params = new URLSearchParams({ format: 'json', limit: '3', q: query })
  if (near) {
    // A degree is ~111 km, so this is a roughly 55 km box. Unbounded, so a
    // genuinely distant place still resolves — it just loses the tie-break.
    const d = 0.5
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`)
  }

  const res = await httpFetch(`${NOMINATIM}?${params}`, {
    headers: HEADERS,
    label: 'Nominatim',
    timeoutMs: 8000
  })
  if (!res.ok) return null

  const results = (await res.json()) as NominatimResult[]
  const hit = results.find((r) => r.lat && r.lon)
  if (!hit) return null

  return {
    // display_name is the full postal chain ("Mathildenhöhe, Darmstadt-Ost,
    // Darmstadt, Hessen, 64287, Deutschland") — too long for a card, and the
    // first two parts are the recognisable bit.
    name: (hit.display_name ?? query).split(',').slice(0, 2).join(',').trim(),
    lat: Number(hit.lat),
    lon: Number(hit.lon)
  }
}

/** Where the user is, when they say "from here". */
export async function homeLocation(): Promise<Place | null> {
  const configured = config.location?.home || config.transit?.defaultOrigin
  if (configured) {
    const place = await geocode(configured)
    if (place) return place
  }

  // Last resort: IP geolocation. City-level accuracy at best, which is fine
  // for "how far is Cologne" and useless for "how far is the corner shop" —
  // hence the configured address taking precedence.
  try {
    const res = await httpFetch(
      'http://ip-api.com/json/?fields=status,city,regionName,lat,lon',
      { label: 'ip-api', timeoutMs: 5000 }
    )
    if (!res.ok) return null
    const json = (await res.json()) as {
      status?: string
      city?: string
      lat?: number
      lon?: number
    }
    if (json.status !== 'success' || typeof json.lat !== 'number') return null
    return { name: json.city ?? 'your location', lat: json.lat, lon: json.lon as number }
  } catch {
    return null
  }
}

/**
 * The travel mode the wording implies. The classifier fills this in most of
 * the time, but not reliably — "by train" and "is it walkable" were dropped on
 * runs where "by bike" came through — and the fallback costs nothing. It only
 * picks which tab opens first; every mode is costed either way.
 */
const MODE_PATTERNS: Array<[RegExp, TravelMode]> = [
  [/\b(by (car|taxi|cab)|driv\w*|by auto|behind the wheel)\b/i, 'driving'],
  [/\b(by (bike|bicycle|cycle)|cycl\w*|biking)\b/i, 'cycling'],
  [/\b(on foot|walk\w*|by foot|stroll\w*)\b/i, 'walking'],
  [
    /\b(by (train|bus|tram|metro|subway|rail|coach)|public transport\w*|transit|s-?bahn|u-?bahn)\b/i,
    'transit'
  ]
]

export function modeFromUtterance(utterance: string): TravelMode | undefined {
  for (const [pattern, mode] of MODE_PATTERNS) {
    if (pattern.test(utterance)) return mode
  }
  return undefined
}

/** Valhalla's costing model for each mode we offer. */
const COSTING: Record<Exclude<TravelMode, 'transit'>, string> = {
  driving: 'auto',
  cycling: 'bicycle',
  walking: 'pedestrian'
}

/**
 * Valhalla returns the route geometry as an encoded polyline at precision 6
 * (Google's original format is precision 5, so the usual decoders read these
 * as coordinates 10x too large).
 */
function decodePolyline(encoded: string, precision = 6): Array<[number, number]> {
  const factor = 10 ** precision
  const points: Array<[number, number]> = []
  let index = 0
  let lat = 0
  let lon = 0

  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let byte: number
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1

    result = 0
    shift = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lon += result & 1 ? ~(result >> 1) : result >> 1

    points.push([lat / factor, lon / factor])
  }

  return points
}

interface ValhallaResponse {
  trip?: {
    summary?: { length?: number; time?: number }
    legs?: Array<{ shape?: string }>
  }
}

async function routeFor(
  mode: Exclude<TravelMode, 'transit'>,
  from: Place,
  to: Place
): Promise<{ option: RouteOption; shape: Array<[number, number]> } | null> {
  try {
    const res = await httpFetch(VALHALLA, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      label: 'Valhalla',
      timeoutMs: 12000,
      body: JSON.stringify({
        locations: [
          { lat: from.lat, lon: from.lon },
          { lat: to.lat, lon: to.lon }
        ],
        costing: COSTING[mode],
        directions_options: { units: 'kilometers' }
      })
    })
    if (!res.ok) return null

    const json = (await res.json()) as ValhallaResponse
    const summary = json.trip?.summary
    if (!summary?.length) return null

    const shape = (json.trip?.legs ?? []).flatMap((leg) =>
      leg.shape ? decodePolyline(leg.shape) : []
    )

    return {
      option: {
        mode,
        distanceKm: Number(summary.length.toFixed(1)),
        durationMinutes: Math.round((summary.time ?? 0) / 60)
      },
      shape
    }
  } catch {
    // One unroutable mode (an island, a motorway-only destination) shouldn't
    // cost the user the other three.
    return null
  }
}

// ---------------------------------------------------------------------------
// Slippy-map maths. The projection is done here rather than in the renderer so
// the card receives plain pixel coordinates and only has to draw them.
// ---------------------------------------------------------------------------

const TILE_SIZE = 256
// Sized to the overlay's usable content width: the 492px card, less its
// padding, the orb column and the panel's own inset. Fixed rather than fluid
// because the pixel coordinates below are baked in the main process.
const MAP_WIDTH = 352
const MAP_HEIGHT = 210
const MIN_ZOOM = 3
const MAX_ZOOM = 17

function worldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom
}

function worldY(lat: number, zoom: number): number {
  const sin = Math.sin((lat * Math.PI) / 180)
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  return y * TILE_SIZE * 2 ** zoom
}

/** Largest zoom at which everything worth seeing still fits in the viewport. */
function fitZoom(points: Array<[number, number]>): number {
  const lats = points.map((p) => p[0])
  const lons = points.map((p) => p[1])
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)

  for (let zoom = MAX_ZOOM; zoom > MIN_ZOOM; zoom--) {
    // 12% margin so the end markers aren't flush against the edge.
    const width = (worldX(maxLon, zoom) - worldX(minLon, zoom)) * 1.12
    const height = (worldY(minLat, zoom) - worldY(maxLat, zoom)) * 1.12
    if (width <= MAP_WIDTH && height <= MAP_HEIGHT) return zoom
  }
  return MIN_ZOOM
}

interface Viewport {
  zoom: number
  left: number
  top: number
}

function viewportFor(points: Array<[number, number]>): Viewport {
  const zoom = fitZoom(points)
  const lats = points.map((p) => p[0])
  const lons = points.map((p) => p[1])
  const centerX = (worldX(Math.min(...lons), zoom) + worldX(Math.max(...lons), zoom)) / 2
  const centerY = (worldY(Math.min(...lats), zoom) + worldY(Math.max(...lats), zoom)) / 2
  return { zoom, left: centerX - MAP_WIDTH / 2, top: centerY - MAP_HEIGHT / 2 }
}

/** Latitude/longitude to a pixel position inside the rendered map. */
function toPixel(point: [number, number], view: Viewport): [number, number] {
  return [
    Math.round(worldX(point[1], view.zoom) - view.left),
    Math.round(worldY(point[0], view.zoom) - view.top)
  ]
}

/**
 * Downloads exactly the tiles the viewport covers. A dozen small images per
 * lookup keeps this within OpenStreetMap's tile policy for light use — this
 * is a still map, not a pannable one that streams tiles as you drag.
 */
async function fetchTiles(view: Viewport): Promise<MapTile[]> {
  const scale = 2 ** view.zoom
  const firstCol = Math.floor(view.left / TILE_SIZE)
  const lastCol = Math.floor((view.left + MAP_WIDTH) / TILE_SIZE)
  const firstRow = Math.floor(view.top / TILE_SIZE)
  const lastRow = Math.floor((view.top + MAP_HEIGHT) / TILE_SIZE)

  const wanted: Array<{ url: string; x: number; y: number }> = []
  for (let row = firstRow; row <= lastRow; row++) {
    // Above the north edge or below the south edge there is no tile at all.
    if (row < 0 || row >= scale) continue
    for (let col = firstCol; col <= lastCol; col++) {
      // Longitude wraps, so a viewport crossing the date line still resolves.
      const wrapped = ((col % scale) + scale) % scale
      wanted.push({
        url: `${TILE_URL}/${view.zoom}/${wrapped}/${row}.png`,
        x: col * TILE_SIZE - view.left,
        y: row * TILE_SIZE - view.top
      })
    }
  }

  const images = await fetchImagesAsDataUris(wanted.map((tile) => tile.url))
  return wanted
    .map((tile, index) => ({ x: tile.x, y: tile.y, image: images[index] }))
    .filter((tile): tile is MapTile => typeof tile.image === 'string')
}

/** Drops points that land on the same pixel — a route can carry thousands. */
function simplify(shape: Array<[number, number]>, view: Viewport): Array<[number, number]> {
  const pixels: Array<[number, number]> = []
  let last: [number, number] | null = null
  for (const point of shape) {
    const pixel = toPixel(point, view)
    if (last && Math.abs(pixel[0] - last[0]) < 2 && Math.abs(pixel[1] - last[1]) < 2) continue
    pixels.push(pixel)
    last = pixel
  }
  return pixels
}

const ROAD_MODES: Array<Exclude<TravelMode, 'transit'>> = ['driving', 'cycling', 'walking']

/**
 * Everything needed to answer "how far is that and how long does it take" —
 * every mode costed, the public-transport departures, and a drawn map.
 */
export async function getDirections(
  fromQuery: string | undefined,
  toQuery: string,
  preferred?: TravelMode
): Promise<DirectionsCardData> {
  const origin = fromQuery ? await geocode(fromQuery) : await homeLocation()
  if (!origin) {
    throw new Error(
      fromQuery
        ? `I couldn't find "${fromQuery}" on the map.`
        : "I don't know where you are. Set location.home in config.json."
    )
  }

  const destination = await geocode(toQuery, origin)
  if (!destination) throw new Error(`I couldn't find "${toQuery}" on the map.`)

  // Every mode is costed up front so switching tabs on the card is instant
  // and costs no further requests. The transit lookup gets the coordinates
  // already resolved here rather than the raw words, so both halves of the
  // card are talking about the same place.
  const [routes, transit] = await Promise.all([
    Promise.all(ROAD_MODES.map((mode) => routeFor(mode, origin, destination))),
    transitOption(origin, destination)
  ])

  const found = routes.filter((route): route is NonNullable<typeof route> => route !== null)
  if (found.length === 0 && !transit) {
    throw new Error(`I couldn't work out a route to ${destination.name}.`)
  }

  // Framed around the driving route when there is one: it is the longest way
  // round, so a map that fits it fits the walking line too.
  const framing = [
    [origin.lat, origin.lon] as [number, number],
    [destination.lat, destination.lon] as [number, number],
    ...found.flatMap((route) => route.shape)
  ]
  const view = viewportFor(framing)

  const options: RouteOption[] = found.map((route) => route.option)
  if (transit) {
    // The journeys come back in departure order, so the first one is the
    // soonest, not the best — for Cologne that was an eleven-hour regional
    // chain sitting in front of a two-hour connection. The headline figure
    // should be how long the trip takes, so it's the quickest of them.
    const quickest = Math.min(...transit.journeys.map((journey) => journey.durationMinutes))
    options.push({
      mode: 'transit',
      // A road distance means nothing for a train, and the router doesn't
      // report one — the card shows the departures instead.
      distanceKm: null,
      durationMinutes: Number.isFinite(quickest) ? quickest : null
    })
  }

  return {
    from: origin.name,
    to: destination.name,
    selected: preferred && options.some((o) => o.mode === preferred) ? preferred : options[0].mode,
    options,
    transit,
    map: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      tiles: await fetchTiles(view),
      routes: Object.fromEntries(
        found.map((route) => [route.option.mode, simplify(route.shape, view)])
      ),
      start: toPixel([origin.lat, origin.lon], view),
      end: toPixel([destination.lat, destination.lon], view)
    }
  }
}

async function transitOption(from: Place, to: Place): Promise<TransitCardData | null> {
  if (!config.integrations.transit) return null
  try {
    const journeys = await findJourneys(from, to)
    return journeys.journeys.length > 0 ? journeys : null
  } catch {
    // No public transport between these points, or the router is down. The
    // road modes still answer the question.
    return null
  }
}
