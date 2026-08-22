import type { WeatherCardData } from '../shared/types'
import { httpFetch } from './http'

const BASE_URL = 'https://api.openweathermap.org/data/2.5/weather'

interface OpenWeatherResponse {
  name: string
  main: { temp: number; feels_like: number; humidity: number }
  weather: Array<{ description: string; icon: string }>
  wind: { speed: number }
}

/**
 * OpenWeatherMap free tier: https://openweathermap.org/api
 */
/**
 * A place name worth reading aloud.
 *
 * Keeps the user's own wording when it plainly refers to the same place, so
 * "Darmstadt" stays "Darmstadt" rather than becoming the district that
 * contains it.
 */
function prettyPlace(asked: string, returned: string): string {
  const wanted = asked.trim()
  if (!wanted) return returned
  const simple = returned.replace(/^(Regierungsbezirk|Landkreis|Kreis|Bezirk|Provincia di|Province of)\s+/i, '')
  if (simple.toLowerCase() === wanted.toLowerCase()) return simple
  // The API name still contains what was asked for - "Darmstadt" inside
  // "Regierungsbezirk Darmstadt" - so the shorter, asked-for form wins.
  if (simple.toLowerCase().includes(wanted.toLowerCase())) return wanted
  return simple
}

export async function getWeather(city: string): Promise<WeatherCardData> {
  const apiKey = process.env.OPENWEATHER_API_KEY
  if (!apiKey) {
    throw new Error('OPENWEATHER_API_KEY is not set. Add it to your .env file.')
  }

  const url = `${BASE_URL}?q=${encodeURIComponent(city)}&units=metric&appid=${apiKey}`
  const res = await httpFetch(url, { label: 'OpenWeatherMap' })

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`I couldn't find a city named "${city}".`)
    }
    throw new Error(`OpenWeatherMap request failed (${res.status}).`)
  }

  const json = (await res.json()) as OpenWeatherResponse

  return {
    // OpenWeather answers with whatever administrative area contains the
    // coordinates, which for Darmstadt is "Regierungsbezirk Darmstadt" - a
    // government district nobody calls their home town. Prefer what the user
    // actually asked for; fall back to the API's name only when they asked
    // for nothing in particular.
    city: prettyPlace(city, json.name),
    temp: Math.round(json.main.temp),
    feelsLike: Math.round(json.main.feels_like),
    condition: json.weather?.[0]?.description ?? 'unknown',
    icon: json.weather?.[0]?.icon ?? '01d',
    humidity: json.main.humidity,
    windSpeed: json.wind?.speed ?? 0
  }
}
