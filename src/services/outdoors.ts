import { httpFetch } from './http'
import { geocode, homeLocation, type Place } from './maps'
import type { OutdoorCardData, OutdoorFactor } from '../shared/types'

/**
 * "Is it a good time to go outside?"
 *
 * This is the kind of question a chatbot answers badly and a resident desktop
 * app answers well. Nobody wants a paragraph about air quality; they want to
 * know whether to put their shoes on now or wait an hour. So this gathers the
 * five things that actually decide that — rain, air, pollen, UV, daylight —
 * and returns a verdict with the reasons ranked by how much they matter.
 *
 * Everything comes from **Open-Meteo**, which is free, needs no key and no
 * account, and publishes air quality and pollen alongside the forecast. That
 * matters more than it sounds: pollen behind a paid key is why most weather
 * apps don't tell a hay-fever sufferer the one number they care about.
 *
 * Thresholds below are from the published scales — European AQI bands, the
 * WHO UV index, and Open-Meteo's own pollen grain counts — rather than
 * invented. Where a judgement is mine rather than a standard's, the comment
 * says so.
 */

const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

interface AirResponse {
  current?: {
    european_aqi?: number
    pm2_5?: number
    grass_pollen?: number
    birch_pollen?: number
    alder_pollen?: number
    ragweed_pollen?: number
  }
}

interface ForecastResponse {
  current?: {
    temperature_2m?: number
    apparent_temperature?: number
    precipitation?: number
    wind_speed_10m?: number
    uv_index?: number
    is_day?: number
  }
  hourly?: {
    time?: string[]
    precipitation_probability?: number[]
  }
  daily?: {
    sunset?: string[]
    sunrise?: string[]
  }
}

/**
 * European AQI bands. 0-20 good, 20-40 fair, 40-60 moderate, 60-80 poor,
 * 80-100 very poor, 100+ extremely poor.
 */
function airVerdict(aqi: number): { level: OutdoorFactor['level']; text: string } {
  if (aqi <= 20) return { level: 'good', text: 'Air is clean' }
  if (aqi <= 40) return { level: 'good', text: 'Air is fair' }
  if (aqi <= 60) return { level: 'ok', text: 'Air is moderate' }
  if (aqi <= 80) return { level: 'poor', text: 'Air is poor — go easy' }
  return { level: 'bad', text: 'Air is very poor — better indoors' }
}

/**
 * Open-Meteo reports pollen as grains/m³. The bands here follow the common
 * clinical low/moderate/high split; the exact numbers differ a little between
 * sources, so these are deliberately cautious.
 */
function pollenVerdict(peak: number, kind: string): { level: OutdoorFactor['level']; text: string } {
  if (peak < 1) return { level: 'good', text: 'Barely any pollen' }
  if (peak < 20) return { level: 'good', text: `A little ${kind} pollen` }
  if (peak < 50) return { level: 'ok', text: `Moderate ${kind} pollen` }
  if (peak < 100) return { level: 'poor', text: `High ${kind} pollen` }
  return { level: 'bad', text: `Very high ${kind} pollen` }
}

/** WHO UV index bands: 3+ wants sunscreen, 8+ is where skin burns quickly. */
function uvVerdict(uv: number): { level: OutdoorFactor['level']; text: string } {
  if (uv < 3) return { level: 'good', text: 'UV is low' }
  if (uv < 6) return { level: 'ok', text: `UV ${Math.round(uv)} — sunscreen` }
  if (uv < 8) return { level: 'poor', text: `UV ${Math.round(uv)} — cover up` }
  return { level: 'bad', text: `UV ${Math.round(uv)} — avoid midday sun` }
}

/**
 * How pleasant it is to move in. Apparent temperature rather than the raw
 * reading, because wind and humidity are exactly what make 8°C feel fine or
 * miserable — and someone about to run outside feels the difference.
 */
function feelVerdict(feels: number): { level: OutdoorFactor['level']; text: string } {
  if (feels < -5) return { level: 'bad', text: `Feels like ${Math.round(feels)}° — bitter` }
  if (feels < 3) return { level: 'poor', text: `Feels like ${Math.round(feels)}° — cold` }
  if (feels < 8) return { level: 'ok', text: `Feels like ${Math.round(feels)}° — chilly` }
  if (feels <= 22) return { level: 'good', text: `Feels like ${Math.round(feels)}°` }
  if (feels <= 28) return { level: 'ok', text: `Feels like ${Math.round(feels)}° — warm` }
  if (feels <= 33) return { level: 'poor', text: `Feels like ${Math.round(feels)}° — hot` }
  return { level: 'bad', text: `Feels like ${Math.round(feels)}° — dangerous to exert` }
}

/** Minutes until sunset, or null after dark. */
function daylightLeft(sunset: string | undefined, now: Date): number | null {
  if (!sunset) return null
  const end = new Date(sunset).getTime()
  if (Number.isNaN(end)) return null
  const minutes = Math.round((end - now.getTime()) / 60000)
  return minutes > 0 ? minutes : null
}

/**
 * The next few hours of rain risk, as the highest probability in that window.
 *
 * A peak rather than an average on purpose: "40% at some point in the next
 * three hours" is the number that decides whether to take a jacket, and
 * averaging it away to 15% would be technically true and practically useless.
 */
function rainAhead(
  hourly: ForecastResponse['hourly'],
  now: Date,
  hours: number
): { peak: number; whenIso: string | null } {
  const times = hourly?.time ?? []
  const chances = hourly?.precipitation_probability ?? []
  let peak = 0
  let whenIso: string | null = null

  for (let i = 0; i < times.length; i++) {
    const at = new Date(times[i]).getTime()
    if (Number.isNaN(at) || at < now.getTime()) continue
    if (at > now.getTime() + hours * 3600_000) break
    const chance = chances[i] ?? 0
    if (chance > peak) {
      peak = chance
      whenIso = times[i]
    }
  }

  return { peak, whenIso }
}

/**
 * Just the place, not its administrative address.
 *
 * The geocoder returns the full hierarchy — "Luisenplatz, Stadtzentrum,
 * Darmstadt, Hesse" — which is precise and unspeakable. Nobody wants to hear
 * their own district read back at them before the answer.
 */
function shortPlace(name: string): string {
  return name.split(',')[0].trim() || name
}

/** Worst level wins — one bad factor is enough to spoil going out. */
const RANK: Record<OutdoorFactor['level'], number> = { good: 0, ok: 1, poor: 2, bad: 3 }

export async function outdoorConditions(placeName?: string): Promise<OutdoorCardData> {
  const place: Place | null = placeName ? await geocode(placeName) : await homeLocation()
  if (!place) {
    throw new Error(
      placeName
        ? `I couldn't find "${placeName}".`
        : "I don't know where you are. Set location.home in config.json."
    )
  }

  const coords = `latitude=${place.lat}&longitude=${place.lon}`
  const [airRes, forecastRes] = await Promise.all([
    httpFetch(
      `${AIR_URL}?${coords}&current=european_aqi,pm2_5,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen`,
      { label: 'Open-Meteo air', timeoutMs: 10000, retries: 1 }
    ),
    httpFetch(
      `${FORECAST_URL}?${coords}` +
        '&current=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,uv_index,is_day' +
        '&hourly=precipitation_probability&daily=sunset,sunrise&forecast_days=2&timezone=auto',
      { label: 'Open-Meteo forecast', timeoutMs: 10000, retries: 1 }
    )
  ])

  if (!forecastRes.ok) throw new Error(`The forecast lookup failed (${forecastRes.status}).`)

  const forecast = (await forecastRes.json()) as ForecastResponse
  // Air quality is allowed to fail on its own: it has thinner global coverage
  // than the forecast, and "no pollen data" shouldn't lose the whole answer.
  const air: AirResponse = airRes.ok ? ((await airRes.json()) as AirResponse) : {}

  const now = new Date()
  const current = forecast.current ?? {}
  const factors: OutdoorFactor[] = []

  const feels = current.apparent_temperature ?? current.temperature_2m
  if (typeof feels === 'number') factors.push({ kind: 'feel', ...feelVerdict(feels) })

  const rainNow = current.precipitation ?? 0
  const { peak, whenIso } = rainAhead(forecast.hourly, now, 3)
  if (rainNow > 0.1) {
    factors.push({ kind: 'rain', level: 'bad', text: "It's raining right now" })
  } else if (peak >= 60) {
    factors.push({ kind: 'rain', level: 'poor', text: `${peak}% chance of rain within 3h` })
  } else if (peak >= 30) {
    factors.push({ kind: 'rain', level: 'ok', text: `${peak}% chance of rain within 3h` })
  } else {
    factors.push({ kind: 'rain', level: 'good', text: 'Rain unlikely for a few hours' })
  }

  const aqi = air.current?.european_aqi
  if (typeof aqi === 'number') factors.push({ kind: 'air', ...airVerdict(aqi) })

  // Whichever pollen is worst right now; naming the specific plant is what
  // makes this useful to someone who knows what they react to.
  const pollens: Array<[string, number]> = [
    ['grass', air.current?.grass_pollen ?? 0],
    ['birch', air.current?.birch_pollen ?? 0],
    ['alder', air.current?.alder_pollen ?? 0],
    ['ragweed', air.current?.ragweed_pollen ?? 0]
  ]
  const [worstKind, worstCount] = pollens.reduce((a, b) => (b[1] > a[1] ? b : a))
  if (air.current) factors.push({ kind: 'pollen', ...pollenVerdict(worstCount, worstKind) })

  const uv = current.uv_index
  const isDay = current.is_day === 1
  if (typeof uv === 'number' && isDay) factors.push({ kind: 'uv', ...uvVerdict(uv) })

  const minutesOfLight = daylightLeft(forecast.daily?.sunset?.[0], now)
  if (isDay && minutesOfLight !== null) {
    factors.push({
      kind: 'light',
      // Under an hour of light is the point where a long run ends in the dark,
      // which is a safety matter rather than a comfort one.
      level: minutesOfLight < 40 ? 'poor' : minutesOfLight < 75 ? 'ok' : 'good',
      text:
        minutesOfLight < 90
          ? `${minutesOfLight} min of daylight left`
          : `Daylight until ${new Date(forecast.daily!.sunset![0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    })
  } else if (!isDay) {
    factors.push({ kind: 'light', level: 'ok', text: "It's dark — take a light" })
  }

  factors.sort((a, b) => RANK[b.level] - RANK[a.level])
  const worst = factors[0]?.level ?? 'good'

  const verdict: OutdoorCardData['verdict'] =
    worst === 'bad' ? 'no' : worst === 'poor' ? 'caution' : worst === 'ok' ? 'fine' : 'great'

  return {
    place: shortPlace(place.name),
    verdict,
    factors,
    temperature: typeof current.temperature_2m === 'number' ? current.temperature_2m : null,
    windSpeed: typeof current.wind_speed_10m === 'number' ? current.wind_speed_10m : null,
    rainChance: peak,
    rainWhen: whenIso
  }
}

/** One sentence, so the spoken answer doesn't have to be generated. */
export function describeOutdoors(data: OutdoorCardData): string {
  const lead =
    data.verdict === 'great'
      ? 'Good conditions right now'
      : data.verdict === 'fine'
        ? 'Fine to head out'
        : data.verdict === 'caution'
          ? 'Workable, but not ideal'
          : 'Better to wait'

  // The two that matter most, already sorted worst-first. Only the second is
  // lowercased — doing both turned "Air is moderate" into a sentence starting
  // in lower case.
  const [first, second] = data.factors
  const reasons = [first?.text, second?.text.toLowerCase()].filter(Boolean).join(', ')
  return `${lead} in ${data.place}. ${reasons}.`
}
