import { classifyIntent, chat, formatResponse, type StreamHandler } from './gemini'
import { getWeather } from './weather'
import { getStockQuote } from './stocks'
import { getCryptoPrice } from './crypto'
import { getNews } from './news'
import { getTrendingRepos } from './github'
import { webSearch } from './search'
import { lookupEntity } from './wikipedia'
import { findMusic } from './music'
import { findJourneys } from './transit'
import { findStation } from './radio'
import { recordTurn } from './conversation'
import type { NimbusResponse } from '../shared/types'
import config from '../../config.json'

/**
 * Single entry point used by the main process: classify the utterance's
 * intent, run the matching data-fetching service, then ask Gemini to turn
 * the result into a short spoken sentence. Every branch is isolated so a
 * failure in one integration (missing key, rate limit, bad city name)
 * degrades to a spoken error instead of crashing the pipeline.
 */
// Roughly 45 seconds of speech. The prompts ask for 1-3 sentences, but a
// model can still run away — one turn produced 140 seconds of audio, which is
// unusable in an overlay you're meant to glance at.
const MAX_SPOKEN_CHARS = 700

function capSpokenLength(text: string): string {
  if (text.length <= MAX_SPOKEN_CHARS) return text
  const clipped = text.slice(0, MAX_SPOKEN_CHARS)
  // Prefer ending on a sentence boundary rather than mid-word.
  const lastStop = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? ')
  )
  const trimmed = lastStop > MAX_SPOKEN_CHARS * 0.5 ? clipped.slice(0, lastStop + 1) : clipped
  console.warn(`[nimbus] response capped from ${text.length} to ${trimmed.length} chars`)
  return trimmed
}

export async function handleUtterance(
  utterance: string,
  onChunk?: StreamHandler
): Promise<NimbusResponse> {
  const resolved = await resolveUtterance(utterance, onChunk)
  const spoken = capSpokenLength(resolved.speech)
  const response: NimbusResponse = {
    ...resolved,
    speech: spoken,
    // Only set when shortening actually happened, so the UI can tell whether
    // there's more to read than was said.
    ...(spoken !== resolved.speech ? { fullText: resolved.speech } : {})
  }
  // Recorded only after resolving, so the in-flight utterance isn't already
  // sitting in history when chat() appends it to its own `contents`.
  recordTurn('user', utterance)
  recordTurn('model', response.speech)
  return response
}

async function resolveUtterance(
  utterance: string,
  onChunk?: StreamHandler
): Promise<NimbusResponse> {
  const { intent, params } = await classifyIntent(utterance)

  try {
    switch (intent) {
      case 'weather': {
        if (!config.integrations.weather) {
          throw new Error('The weather integration is disabled in config.json.')
        }
        const city = params.city
        if (!city) throw new Error("I didn't catch which city you meant.")
        const data = await getWeather(city)
        const speech = await formatResponse('weather', utterance, data, onChunk)
        return { speech, card: { type: 'weather', data } }
      }

      case 'stocks': {
        if (!config.integrations.stocks) {
          throw new Error('The stocks integration is disabled in config.json.')
        }
        const symbol = params.symbol
        if (!symbol) throw new Error("I didn't catch which ticker you meant.")
        const data = await getStockQuote(symbol)
        const speech = await formatResponse('stocks', utterance, data, onChunk)
        return { speech, card: { type: 'stock', data } }
      }

      case 'crypto': {
        if (!config.integrations.crypto) {
          throw new Error('The crypto integration is disabled in config.json.')
        }
        const coin = params.coin
        if (!coin) throw new Error("I didn't catch which coin you meant.")
        const data = await getCryptoPrice(coin)
        const speech = await formatResponse('crypto', utterance, data, onChunk)
        return { speech, card: { type: 'crypto', data } }
      }

      case 'news': {
        if (!config.integrations.news) {
          throw new Error('The news integration is disabled in config.json.')
        }
        const data = await getNews(params.query)
        const speech = await formatResponse('news', utterance, data, onChunk)
        return { speech, card: { type: 'news', data } }
      }

      case 'github': {
        if (!config.integrations.github) {
          throw new Error('The GitHub integration is disabled in config.json.')
        }
        const data = await getTrendingRepos(params.language)
        const speech = await formatResponse('github', utterance, data, onChunk)
        return { speech, card: { type: 'github', data } }
      }

      case 'music': {
        if (!config.integrations.music) {
          throw new Error('Music playback is disabled in config.json.')
        }
        const query = params.query || utterance

        // Background music by genre/mood plays *inside* Nimbus via a radio
        // stream. A specific track can't legitimately be streamed in-app —
        // see src/services/radio.ts — so it opens in the browser instead.
        if (params.playback === 'station') {
          try {
            const station = await findStation(query)
            return {
              speech: `Playing ${station.name}.`,
              card: { type: 'radio', data: station }
            }
          } catch {
            // No station matched — fall through to a YouTube result rather
            // than failing outright.
          }
        }

        const data = await findMusic(query)
        // Skip the model round-trip: the useful confirmation is just what's
        // playing, and this keeps "play X" feeling immediate.
        return {
          speech: `Playing ${data.title} by ${data.channel}.`,
          card: { type: 'music', data }
        }
      }

      case 'transit': {
        if (!config.integrations.transit) {
          throw new Error('Transit lookups are disabled in config.json.')
        }
        const destination = params.to
        if (!destination) throw new Error("I didn't catch where you're heading.")
        const data = await findJourneys(params.from, destination, params.when)
        const speech = await formatResponse('transit', utterance, data, onChunk)
        return { speech, card: { type: 'transit', data } }
      }

      case 'search': {
        if (!config.integrations.search) {
          throw new Error('Web search is disabled in config.json.')
        }
        const query = params.query || utterance

        // Wikipedia is the right tool only when the question is *about* a
        // named thing ("who is Marie Curie") — it gives a description and a
        // photo, and needs no API key. For relational questions ("who is the
        // CEO of Nvidia") it returns the tangential company page, so those go
        // to web search instead.
        if (params.entity) {
          const entity = await lookupEntity(params.entity)
          if (entity) {
            const speech = await formatResponse(
              'search',
              utterance,
              {
                title: entity.title,
                description: entity.description,
                extract: entity.extract
              },
              onChunk
            )
            return { speech, card: { type: 'entity', data: entity } }
          }
        }

        // No Tavily key configured? Fall back to Wikipedia rather than just
        // erroring out — a decent answer beats none.
        if (!process.env.TAVILY_API_KEY) {
          const entity = await lookupEntity(query)
          if (entity) {
            const speech = await formatResponse(
              'search',
              utterance,
              {
                title: entity.title,
                description: entity.description,
                extract: entity.extract
              },
              onChunk
            )
            return { speech, card: { type: 'entity', data: entity } }
          }
        }

        const data = await webSearch(query)
        // Tavily often returns its own summary; prefer letting Gemini phrase
        // it conversationally, but fall back to Tavily's if Gemini is rate
        // limited so the user still gets an answer.
        let speech: string
        try {
          speech = await formatResponse(
            'search',
            utterance,
            { answer: data.answer, results: data.results.slice(0, 3) },
            onChunk
          )
        } catch (err) {
          if (!data.answer) throw err
          speech = data.answer
        }
        return { speech, card: { type: 'search', data } }
      }

      default: {
        const speech = await chat(utterance, onChunk)
        return { speech, card: { type: 'text' } }
      }
    }
  } catch (err) {
    const speech = err instanceof Error ? err.message : 'Something went wrong.'
    return { speech, card: { type: 'text' } }
  }
}
