import {
  GoogleGenerativeAI,
  SchemaType,
  type GenerationConfig,
  type GenerativeModel
} from '@google/generative-ai'
import type { IntentClassification, NimbusIntent } from '../shared/types'
import { getHistoryAsContents, getHistorySummary } from './conversation'

// NOTE: Web Speech API (renderer) handles STT/TTS for free with no API key.
// If recognition quality is ever a problem, a free-tier Whisper API call
// could replace SpeechRecognition here without touching the rest of the
// pipeline — swap the transcript source, keep everything downstream as-is.

const VALID_INTENTS: NimbusIntent[] = [
  'weather',
  'stocks',
  'crypto',
  'news',
  'github',
  'search',
  'music',
  'chat'
]

let client: GoogleGenerativeAI | null = null

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.')
    }
    client = new GoogleGenerativeAI(apiKey)
  }
  return client
}

function getModel(systemInstruction: string, generationConfig?: GenerationConfig): GenerativeModel {
  // "-latest" aliases auto-update to Google's current model for that tier, so
  // this doesn't go stale the way a pinned version (e.g. "gemini-2.0-flash")
  // eventually does when Google retires it.
  const modelName = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'
  return getClient().getGenerativeModel({ model: modelName, systemInstruction, generationConfig })
}

const CLASSIFY_SYSTEM_PROMPT = `You are the intent router for a voice assistant called Nimbus.
Given a single spoken user utterance, decide which of these intents it matches and extract
the relevant parameter for it, leaving the others empty:

- "weather": asking about weather/temperature/forecast somewhere -> params.city
- "stocks": asking about a public company's stock price/quote -> params.symbol
  (the ticker symbol, e.g. "Apple" -> AAPL, "Tesla" -> TSLA; if unsure, give the company name)
- "crypto": asking about a cryptocurrency's price -> params.coin (name or symbol, e.g. "bitcoin" or "btc")
- "news": asking for news headlines, optionally about a topic -> params.query (omit for top headlines)
- "github": asking about trending GitHub repos, optionally in a language -> params.language (omit for none)
- "music": asking to play music or a video.
  -> params.query (what to search for, e.g. "Bohemian Rhapsody Queen")
  -> params.playback: set to "station" when the user wants background music by
     genre, mood or activity rather than one particular recording — "play some
     jazz", "put on lofi", "play relaxing music", "play something upbeat".
     Set to "track" when they want a *specific* song, artist, or video —
     "play Bohemian Rhapsody", "play the new Adele single", "play a video about
     sourdough". If unsure, use "track".
- "search": anything needing current, real-world, or factual information you
  cannot answer reliably from memory — recent events, who currently holds a
  role, prices or facts that change, specific people/companies/products, "look
  this up", or anything where being out of date would be wrong.
  -> params.query (a concise web search query capturing what to look up)
  Also set params.entity ONLY when the user is asking about a single named
  person, place, organization or thing *itself* — "who is Marie Curie", "what
  is the Eiffel Tower", "tell me about Nvidia". Set it to just that name.
  Leave params.entity EMPTY for relational or event questions where the answer
  is a fact *about* something rather than a description of it — "who is the CEO
  of Nvidia", "who won the final", "when does X release".
- "chat": only for things needing no external information at all — greetings,
  small talk, jokes, opinions, or rephrasing/reasoning about what was already said.

Prefer "search" over "chat" whenever the answer depends on facts about the real
world that may have changed. It is much better to search unnecessarily than to
confidently state something out of date.`

// Structured output: Gemini is constrained to emit exactly this shape, so
// there's no free-text JSON to regex out and no risk of it wrapping the
// answer in prose or markdown fences.
const CLASSIFY_SCHEMA: GenerationConfig = {
  responseMimeType: 'application/json',
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      intent: {
        type: SchemaType.STRING,
        enum: VALID_INTENTS,
        format: 'enum'
      },
      params: {
        type: SchemaType.OBJECT,
        properties: {
          city: { type: SchemaType.STRING },
          symbol: { type: SchemaType.STRING },
          coin: { type: SchemaType.STRING },
          query: { type: SchemaType.STRING },
          entity: { type: SchemaType.STRING },
          playback: { type: SchemaType.STRING, enum: ['station', 'track'], format: 'enum' },
          language: { type: SchemaType.STRING }
        }
      }
    },
    required: ['intent', 'params']
  }
}

export async function classifyIntent(utterance: string): Promise<IntentClassification> {
  // Recent turns are prepended so follow-ups resolve: "what about tomorrow?"
  // or "how about Berlin?" only make sense against what was just discussed.
  const context = getHistorySummary()
  const model = getModel(
    context
      ? `${CLASSIFY_SYSTEM_PROMPT}\n\nRecent conversation (for resolving pronouns and follow-ups):\n${context}`
      : CLASSIFY_SYSTEM_PROMPT,
    CLASSIFY_SCHEMA
  )
  const result = await model.generateContent(utterance)

  try {
    const parsed = JSON.parse(result.response.text())
    const intent: NimbusIntent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'chat'
    const rawParams: Record<string, string> =
      parsed.params && typeof parsed.params === 'object' ? parsed.params : {}
    // Drop empty-string params the model left blank for unused fields.
    const params = Object.fromEntries(
      Object.entries(rawParams).filter(([, value]) => typeof value === 'string' && value.length > 0)
    )
    return { intent, params }
  } catch {
    return { intent: 'chat', params: {} }
  }
}

/** Called with each token chunk as the model generates it. */
export type StreamHandler = (chunk: string) => void

/** Drains a streaming response, forwarding chunks and returning the full text. */
async function collectStream(
  stream: AsyncGenerator<{ text: () => string }>,
  onChunk?: StreamHandler
): Promise<string> {
  let full = ''
  for await (const part of stream) {
    const chunk = part.text()
    if (!chunk) continue
    full += chunk
    onChunk?.(chunk)
  }
  return full.trim()
}

export async function chat(utterance: string, onChunk?: StreamHandler): Promise<string> {
  const model = getModel(
    'You are Nimbus, a concise, friendly voice assistant living in a desktop overlay. ' +
      'Keep responses to 1-3 short sentences since they will be read aloud by text-to-speech. ' +
      'Do not use markdown, bullet points, or emoji. ' +
      'You are mid-conversation — refer back to what was already said when relevant.'
  )
  // Full prior turns (not just a summary) so the model can genuinely follow
  // the thread rather than answering each utterance in isolation.
  const request = {
    contents: [...getHistoryAsContents(), { role: 'user', parts: [{ text: utterance }] }]
  }

  if (!onChunk) {
    const result = await model.generateContent(request)
    return result.response.text().trim()
  }

  const { stream } = await model.generateContentStream(request)
  return collectStream(stream, onChunk)
}

export async function formatResponse(
  intent: NimbusIntent,
  utterance: string,
  data: unknown,
  onChunk?: StreamHandler
): Promise<string> {
  const model = getModel(
    'You turn structured data into a short, natural spoken sentence (1-3 sentences max) ' +
      'for a voice assistant named Nimbus. Do not use markdown, bullet points, or emoji ' +
      'since this will be spoken aloud by text-to-speech.'
  )
  const context = getHistorySummary(4)
  const prompt = [
    context ? `Recent conversation:\n${context}\n` : '',
    `The user asked: "${utterance}"`,
    `Intent: ${intent}`,
    `Data: ${JSON.stringify(data)}`,
    '',
    'Respond with only the spoken sentence(s), nothing else.'
  ]
    .filter(Boolean)
    .join('\n')

  if (!onChunk) {
    const result = await model.generateContent(prompt)
    return result.response.text().trim()
  }

  const { stream } = await model.generateContentStream(prompt)
  return collectStream(stream, onChunk)
}
