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
    city: json.name,
    temp: Math.round(json.main.temp),
    feelsLike: Math.round(json.main.feels_like),
    condition: json.weather?.[0]?.description ?? 'unknown',
    icon: json.weather?.[0]?.icon ?? '01d',
    humidity: json.main.humidity,
    windSpeed: json.wind?.speed ?? 0
  }
}
