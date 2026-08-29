import type { WeatherCardData, WeatherKind } from '../shared/types'
import { geocode } from './maps'
import { httpFetch } from './http'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    wind_speed_10m?: number
    weather_code?: number
  }
}

/**
 * Weather from Open-Meteo — no key, and already the source behind
 * `outdoors.ts` for air quality, pollen and UV.
 *
 * The forecast is keyed by coordinates rather than by a place name, so a
 * lookup geocodes first through the same Nominatim helper the maps and
 * outdoor answers use. That is one more request than a name-based API needs,
 * but it is what removes the last avoidable API key from the app — and it
 * fixes the naming problem too: the geocoder answers with the place that was
 * asked for instead of the administrative district that contains it.
 */

/**
 * WMO weather codes, which is what every Open-Meteo endpoint speaks.
 *
 * The label is read aloud and printed under the temperature, so it is phrased
 * the way a person would say it rather than as the standard's own wording
 * ("Thunderstorm with slight hail").
 */
const WMO: Record<number, { kind: WeatherKind; label: string }> = {
  0: { kind: 'clear', label: 'clear sky' },
  1: { kind: 'clear', label: 'mainly clear' },
  2: { kind: 'partly', label: 'partly cloudy' },
  3: { kind: 'cloudy', label: 'overcast' },
  45: { kind: 'mist', label: 'fog' },
  48: { kind: 'mist', label: 'freezing fog' },
  51: { kind: 'drizzle', label: 'light drizzle' },
  53: { kind: 'drizzle', label: 'drizzle' },
  55: { kind: 'drizzle', label: 'heavy drizzle' },
  56: { kind: 'drizzle', label: 'freezing drizzle' },
  57: { kind: 'drizzle', label: 'freezing drizzle' },
  61: { kind: 'rain', label: 'light rain' },
  63: { kind: 'rain', label: 'rain' },
  65: { kind: 'rain', label: 'heavy rain' },
  66: { kind: 'rain', label: 'freezing rain' },
  67: { kind: 'rain', label: 'heavy freezing rain' },
  71: { kind: 'snow', label: 'light snow' },
  73: { kind: 'snow', label: 'snow' },
  75: { kind: 'snow', label: 'heavy snow' },
  77: { kind: 'snow', label: 'snow grains' },
  80: { kind: 'rain', label: 'light showers' },
  81: { kind: 'rain', label: 'showers' },
  82: { kind: 'rain', label: 'heavy showers' },
  85: { kind: 'snow', label: 'snow showers' },
  86: { kind: 'snow', label: 'heavy snow showers' },
  95: { kind: 'storm', label: 'thunderstorm' },
  96: { kind: 'storm', label: 'thunderstorm with hail' },
  99: { kind: 'storm', label: 'thunderstorm with hail' }
}

const UNKNOWN = { kind: 'mist' as WeatherKind, label: 'unclear' }

/**
 * Just the place, not its postal address. The geocoder answers with the full
 * hierarchy ("Darmstadt, Hessen"), and only the first part belongs on a card
 * or in a spoken sentence.
 */
function shortPlace(name: string): string {
  return name.split(',')[0].trim() || name
}

export async function getWeather(city: string): Promise<WeatherCardData> {
  const place = await geocode(city)
  if (!place) {
    throw new Error(`I couldn't find a city named "${city}".`)
  }

  const url =
    `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code' +
    // The card says "m/s wind"; Open-Meteo would otherwise answer in km/h.
    '&wind_speed_unit=ms'

  const res = await httpFetch(url, { label: 'Open-Meteo', timeoutMs: 10000, retries: 1 })
  if (!res.ok) {
    throw new Error(`The weather lookup failed (${res.status}).`)
  }

  const json = (await res.json()) as OpenMeteoResponse
  const current = json.current
  if (!current || typeof current.temperature_2m !== 'number') {
    throw new Error(`I couldn't get the weather for "${city}" just now.`)
  }

  const code = WMO[current.weather_code ?? -1] ?? UNKNOWN

  return {
    city: shortPlace(place.name),
    temp: Math.round(current.temperature_2m),
    feelsLike: Math.round(current.apparent_temperature ?? current.temperature_2m),
    condition: code.label,
    kind: code.kind,
    humidity: Math.round(current.relative_humidity_2m ?? 0),
    windSpeed: current.wind_speed_10m ?? 0
  }
}
