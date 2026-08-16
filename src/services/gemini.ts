import { SchemaType, type GenerationConfig } from '@google/generative-ai'
import { buildModel, withModelFallback } from './gemini-client'
import type { IntentClassification, NimbusIntent } from '../shared/types'
import { getHistoryAsContents, getHistorySummary } from './conversation'
import { currentTimeContext } from './now'
import { placeContext, replyLanguageContext } from './region'
import { factsContext } from './memory'

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
  'transit',
  'directions',
  'remember',
  'recall',
  'alarm',
  'briefing',
  'chat'
]

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
- "transit": asking when a service leaves — "when is the next train to
  Frankfurt", "are there trains in the next hour", "what time is the last
  S-Bahn". This is about departure times specifically.
  -> params.to (destination place or station — required)
  -> params.from (starting station; omit if the user didn't say one)
  -> params.when (ISO 8601 datetime if they named a time like "at 6pm" or
     "tomorrow morning"; omit for now/next departures)
  Use this rather than "search" for anything about catching a service: a web
  search returns timetable *pages*, this returns actual departures.
- "directions": asking how far away somewhere is, how long it takes to get
  there, or how to get there — "how far is the airport", "how long to Cologne
  by car", "how do I get to the Mathildenhöhe from here", "is it walkable".
  -> params.to (the destination — required)
  -> params.from (starting point; omit for "from here" or when unstated)
  -> params.mode: how they want to travel, whenever they indicate it at all.
     Translate their words into exactly one of these four values:
       "driving"  — by car, driving, drive there, "how long is the drive"
       "cycling"  — by bike, cycling, on a bicycle
       "walking"  — on foot, walking, "is it walkable", "can I walk there"
       "transit"  — by train, by bus, by tram, by S-Bahn, public transport
     Omit ONLY when they gave no hint of how they'd travel.
  The difference from "transit": that one answers "when does it leave", this
  one answers "how far, how long, which way". Anything phrased as "how do I get
  to X" is "directions". When in doubt prefer "directions" — its answer already
  includes the departures, so nothing is lost.
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
- "remember": asking Nimbus to keep something about them for the future —
  "remember that I take the RB68", "my home station is Luisenplatz", "don't
  forget I'm vegetarian", "forget what I said about the gym".
  -> params.fact (the thing to remember, rewritten as a short standalone
     statement in the third person: "Takes the RB68 to work". Do not include
     "remember that".)
  -> params.forget (set instead of params.fact when they want something
     dropped; give the phrase identifying it, e.g. "gym")
  Only use this when they are stating something about themselves or their
  preferences for later. A question is never "remember".
- "recall": asking what was said or looked up before — "what was that station
  you told me", "what did we talk about yesterday", "what do you know about
  me", "what did I ask about the tickets".
  -> params.query (key words to search past answers for; omit to list the most
     recent ones, and omit it for "what do you know about me")
  "Remind me…" is not automatically recall: "remind me what the weather is"
  wants today's weather, not something said before. Use "recall" only when
  they are asking about a past conversation.
- "alarm": asking to be told something later, or asking what reminders exist.
  -> params.task (what to remind them about, phrased as the spoken line:
     "call the landlord". Omit when they're just asking what's pending.)
  -> params.when (ISO 8601 datetime for when it should fire — work it out from
     the current time given below, so "in 20 minutes" and "at 6pm" both become
     a real timestamp)
  -> params.leaveFor (set INSTEAD of params.when when they want to be told when
     to *set off* somewhere rather than at a clock time — "tell me when I need
     to leave for Frankfurt", "let me know when to leave to catch the last
     train to Wiesbaden". Give the destination.)
  -> params.cancel (set when they want a reminder dropped — the phrase
     identifying it, or empty text to cancel all of them)
- "briefing": asking for the overall picture of their day rather than one
  fact — "what does my day look like", "brief me", "catch me up", "what's
  happening today", "good morning" said as a request rather than a greeting.
  No parameters. Use this only for the *combined* rundown; "what's the weather"
  on its own is still "weather".
- "chat": only for things needing no external information at all — greetings,
  small talk, jokes, opinions, or rephrasing/reasoning about what was already said.

Prefer "search" over "chat" whenever the answer depends on facts about the real
world that may have changed. It is much better to search unnecessarily than to
confidently state something out of date.

Separately, for ANY intent, set params.topic when a picture or diagram would
genuinely help the user understand the answer — a physical object, place,
organism, structure, or a process that is normally taught with a diagram.
Write it as the bare encyclopedia-article title, not as the user's phrasing:
"how does a jet engine work" -> "jet engine", "tell me about the Roman
aqueducts" -> "Roman aqueduct", "what's the Krebs cycle" -> "citric acid cycle".
Leave params.topic EMPTY for opinions, small talk, greetings, math, code,
personal questions, prices, schedules, and anything where a picture would be
decoration rather than explanation.`

// Structured output: Gemini is constrained to emit exactly this shape, so
// there's no free-text JSON to regex out and no risk of it wrapping the
// answer in prose or markdown fences.
const CLASSIFY_SCHEMA: GenerationConfig = {
  // Routing is a classification, not a creative task. At the default
  // temperature the same utterance drifted between runs — "how long to
  // Cologne by car" filled the travel mode on one call and left it empty on
  // the next — which is exactly the kind of flakiness that's impossible to
  // debug from the outside.
  temperature: 0,
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
          language: { type: SchemaType.STRING },
          from: { type: SchemaType.STRING },
          to: { type: SchemaType.STRING },
          when: { type: SchemaType.STRING },
          topic: { type: SchemaType.STRING },
          fact: { type: SchemaType.STRING },
          forget: { type: SchemaType.STRING },
          task: { type: SchemaType.STRING },
          leaveFor: { type: SchemaType.STRING },
          cancel: { type: SchemaType.STRING },
          mode: {
            type: SchemaType.STRING,
            enum: ['driving', 'cycling', 'walking', 'transit'],
            format: 'enum'
          }
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
  const systemInstruction = [
    CLASSIFY_SYSTEM_PROMPT,
    '',
    currentTimeContext(),
    placeContext(),
    factsContext(),
    context ? `\nRecent conversation (for resolving pronouns and follow-ups):\n${context}` : ''
  ]
    .filter((part) => part !== '')
    .join('\n')

  const result = await withModelFallback((name) =>
    buildModel(name, systemInstruction, CLASSIFY_SCHEMA).generateContent(utterance)
  )

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
  const systemInstruction =
    'You are Nimbus, a concise, friendly voice assistant living in a desktop overlay. ' +
    'Keep responses to 1-3 short sentences since they will be read aloud by text-to-speech. ' +
    'Do not use markdown, bullet points, or emoji. ' +
    'You are mid-conversation — refer back to what was already said when relevant.\n\n' +
    `${replyLanguageContext()}\n\n` +
    `${factsContext()}\n\n` +
    currentTimeContext()

  // Full prior turns (not just a summary) so the model can genuinely follow
  // the thread rather than answering each utterance in isolation.
  const request = {
    contents: [...getHistoryAsContents(), { role: 'user', parts: [{ text: utterance }] }]
  }

  if (!onChunk) {
    const result = await withModelFallback((name) =>
      buildModel(name, systemInstruction).generateContent(request)
    )
    return result.response.text().trim()
  }

  const { stream } = await withModelFallback((name) =>
    buildModel(name, systemInstruction).generateContentStream(request)
  )
  return collectStream(stream, onChunk)
}

export async function formatResponse(
  intent: NimbusIntent,
  utterance: string,
  data: unknown,
  onChunk?: StreamHandler
): Promise<string> {
  const systemInstruction =
    'You turn structured data into a short, natural spoken sentence (1-3 sentences max) ' +
    'for a voice assistant named Nimbus. Do not use markdown, bullet points, or emoji ' +
    'since this will be spoken aloud by text-to-speech.\n\n' +
    `${replyLanguageContext()}\n\n` +
    currentTimeContext()

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
    const result = await withModelFallback((name) =>
      buildModel(name, systemInstruction).generateContent(prompt)
    )
    return result.response.text().trim()
  }

  // Streaming can't retry mid-flight without replaying tokens the UI already
  // showed, so the fallback applies to opening the stream only.
  const { stream } = await withModelFallback((name) =>
    buildModel(name, systemInstruction).generateContentStream(prompt)
  )
  return collectStream(stream, onChunk)
}
