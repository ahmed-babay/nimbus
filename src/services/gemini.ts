import { SchemaType, type GenerationConfig } from '@google/generative-ai'
import { activeProvider, complete, streamComplete } from './llm'
import type { IntentClassification, NimbusIntent } from '../shared/types'
import { getHistoryAsContents, getHistorySummary } from './conversation'
import { currentTimeContext } from './now'
import { placeContext, replyLanguageContext } from './region'
import { factsContext } from './memory'

// NOTE: Web Speech API (renderer) handles STT/TTS for free with no API key.
// If recognition quality is ever a problem, a free-tier Whisper API call
// could replace SpeechRecognition here without touching the rest of the
// pipeline — swap the transcript source, keep everything downstream as-is.

/**
 * Providers without constrained decoding sometimes wrap JSON in a code fence
 * despite being told not to. Gemini never does, but the same parse path now
 * serves all three.
 */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

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
  'outdoors',
  'convert',
  'holidays',
  'episode',
  'flights',
  'define',
  'remember',
  'recall',
  'alarm',
  'event',
  'briefing',
  'location',
  'chat'
]

const CLASSIFY_SYSTEM_PROMPT = `You are the intent router for a voice assistant called Nimbus.
Given a single spoken user utterance, decide which of these intents it matches and extract
the relevant parameter for it, leaving the others empty:

- "weather": asking about weather/temperature/forecast somewhere -> params.city
- "stocks": asking about a public company's stock price/quote, about a saved
  list of stocks, or asking to be told when a price moves.
  -> params.symbol (the ticker, e.g. "Apple" -> AAPL, "Tesla" -> TSLA; if
     unsure give the company name. Omit only for params.stockAction "list".
     When they name SEVERAL companies -- "show me Tesla and Google", "how are
     Apple, Nvidia and AMD doing" -- put ALL of them here separated by commas:
     "TSLA,GOOGL". Order them as the user said them.)
  -> params.stockAction: what they want done, one of:
       "quote"  — just the price now. The default; omit for this.
       "list"   — show their saved stocks: "my stocks", "my watchlist",
                  "how are my stocks doing", "show me my portfolio".
       "add"    — start following one: "add Tesla to my stocks",
                  "follow Nvidia", "watch Apple for me".
       "remove" — stop following: "remove Tesla from my stocks".
       "alert"  — tell me when it crosses a price: "tell me when Tesla drops
                  below 300", "let me know if Nvidia goes above 200",
                  "alert me when Apple hits 150".
  -> params.alertPrice (the number, for "alert" — just digits, e.g. "300")
  -> params.alertDirection ("below" or "above", for "alert". "drops/falls/goes
     under/hits" a lower number is "below"; "rises/goes above/tops" is "above".
     If they say "hits", compare with the current price and pick the side it
     would have to move to reach.)
- "crypto": asking about a cryptocurrency's price -> params.coin (name or symbol, e.g. "bitcoin" or "btc")
- "news": asking for news headlines, optionally about a topic -> params.query (omit for top headlines)
- "github": asking about trending GitHub repos, optionally in a language -> params.language (omit for none)
- "music": asking to play music or a video.
  NEVER use this for "stop the music", "stop the radio", "turn the music off",
  "pause the song", or any request to halt playback — those are not a search
  for a track titled "Stop the Music".
  -> params.query (what to search for, e.g. "Bohemian Rhapsody Queen")
  -> params.playback: set to "station" when the user wants background music by
     genre, mood or activity rather than one particular recording — "play some
     jazz", "put on lofi", "play relaxing music", "play something upbeat".
     Set to "track" when they want a *specific* song, artist, or video —
     "play Bohemian Rhapsody", "play the new Adele single", "play a video about
     sourdough". If unsure, use "track".
  -> params.playIn: where they want it played, one of:
       "here"    — in Nimbus. THE DEFAULT, and the right answer for almost
                   everything: "play some lofi", "play Bohemian Rhapsody",
                   "put on something relaxing", "play the new Adele single".
       "youtube" — ONLY when they actually named YouTube or a browser: "play
                   it on YouTube", "open it in YouTube", "find me the YouTube
                   video", "open the video in my browser".
     If YouTube and the browser were not mentioned, it is "here". Do not pick
     "youtube" because the thing is a video, because it is a specific track,
     or because YouTube is where it would be found — only because they said so.
- "transit": asking when a service leaves — "when is the next train to
  Frankfurt", "are there trains in the next hour", "what time is the last
  S-Bahn". This is about departure times specifically.
  -> params.to (destination place or station — required)
  -> params.from (starting station. Omit it unless the user NAMED a station in
     this sentence. Never fill it in from earlier messages, from where you
     think they live, or from a station mentioned in a previous question -
     Nimbus knows where the device actually is and uses that when this is
     empty, which is always better than a guess.)
  -> params.fromHere ("yes" when the journey starts wherever the user
     currently is, "no" when they named a starting place.
     "yes" for: "from here", "from my place", "from where I am", "from my
     location", "from my side", "from my house", "starting where I am now",
     and for any phrasing that means their current position however they
     word it. Also "yes" when they named no starting point at all.
     "no" only when they named an actual place to start from.)
  -> params.when (ISO 8601 datetime if they named a time like "at 6pm" or
     "tomorrow morning"; omit for now/next departures)
  -> params.timeMode ("arrive" when the time they named is when they need to
     BE somewhere, "depart" when it is when they want to set off.
     "arrive" for: "I need to be in Frankfurt by 9", "I want to arrive at 9",
     "get me there before the meeting at 10", "what should I take to make it
     to the airport by 6", "I have to reach Mainz no later than noon".
     "depart" for: "the next train at 9", "trains leaving around 9", "what
     time is the last S-Bahn", "I want to take the 9 o'clock train".
     The distinction matters: answering "be there by 9" with trains that
     leave at 9 gives them something that arrives far too late.)
  -> params.watch ("yes" when they want to be kept informed about that service
     rather than simply told once, "no" when they just want the times.
     "yes" for: "keep me updated", "keep me posted", "notify me when/if there
     is a delay", "let me know about any delays", "tell me if it's cancelled",
     "can you confirm it and keep me updated".
     "no" for: "when is the next train to Frankfurt", "what time is the last
     S-Bahn".
     If they mention delays, cancellations, or being told/updated/notified at
     all in connection with the service, it is "yes".)
  Use this rather than "search" for anything about catching a service: a web
  search returns timetable *pages*, this returns actual departures.
  IMPORTANT: "notify me if the 17:30 to Frankfurt is delayed" is "transit" with
  params.watch, NOT "alarm". An alarm fires once at a time the user names; this
  follows a train and speaks up whenever its delay changes. Anything about
  delays, cancellations or being kept updated on a *service* belongs here.
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
- "outdoors": asking whether it's a good time to be outside, or about the
  conditions for doing something outdoors — "is it a good time for a run",
  "should I go jogging now", "can I cycle to work", "is the air bad today",
  "how's the pollen", "do I need sunscreen", "is it nice out".
  -> params.city (only if they named a place; omit for where they are)
  This is not "weather". Weather answers "what is the temperature"; this
  answers "should I go out", and combines rain, air quality, pollen, UV and
  remaining daylight into one verdict. Anything mentioning running, jogging,
  cycling, a walk, hay fever, pollen, air quality or sunscreen belongs here.
- "convert": converting an amount of money between currencies -- "how much is
  50 euros in dollars", "what's 200 pounds in euros", "convert 1000 yen to
  euros", "what's the euro dollar rate".
  -> params.amount (just the number, e.g. "50". Use "1" when they asked for a
     rate rather than an amount.)
  -> params.fromCurrency (what they are converting from, as said: "euros",
     "pounds", or a code like "EUR")
  -> params.toCurrency (what they want it in)
  Only for money. Converting units (miles, kilos, celsius) is "chat".
- "holidays": asking about public/bank holidays -- "is Monday a holiday",
  "when is the next public holiday", "are the shops open on Thursday", "what
  holidays are coming up". No params.
- "episode": asking when a TV show is next on, or where it is up to -- "when
  is the next episode of Severance", "is there a new Simpsons this week",
  "has The Bear come back yet", "when does season 3 start".
  -> params.query (just the show's name, e.g. "Severance")
  For a film, or for what a show is about, use "search" instead.
- "flights": asking what aircraft are in the sky nearby -- "what's that plane
  overhead", "any planes above me", "what's flying over Frankfurt right now".
  -> params.city (only when they named a place; omit for where they are)
  This is live positions, not schedules. A question about a *particular*
  flight's status -- "is LH400 delayed", "when does BA912 land" -- is "search".
- "define": asking what an ENGLISH word means or how it is used -- "what does
  resilient mean", "define concede", "how do you use 'albeit'".
  -> params.word (just the single word, lowercase)
  Not for translation between languages, which is a text action, and not for
  "what is X" about a person, place or thing, which is "search".
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
  Not for train delays — being told when a *service* changes is "transit" with
  params.watch, because that fires whenever the delay moves rather than once.
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
- "event": telling Nimbus about something happening on a particular day or
  range of days, or asking what is coming up — "I'm in Düsseldorf for the Reply
  Leadvise event from the 24th to the 27th", "I'm at my girlfriend's this
  weekend", "dentist on Tuesday", "what have I got coming up", "cancel the
  Düsseldorf trip".
  -> params.eventTitle (what it is, short: "Reply Leadvise event". Omit when
     they're only asking what's coming up.)
  -> params.eventStart — REQUIRED whenever params.eventTitle is set. The first
     day as YYYY-MM-DD. Work it out from the current date given below:
     "the 24th" -> the 24th of this month, or next month if that has passed;
     "Tuesday" -> the next Tuesday; "this weekend" -> the coming Saturday.
     Never a date in the past. If they genuinely gave no day at all, use today.
  -> params.eventEnd (last day as YYYY-MM-DD, for a range like "from the 24th
     to the 27th"; omit for a single day)
  -> params.eventPlace (the town or city it happens in, whenever they name one —
     "Düsseldorf". Omit only for something local with no place mentioned.)
  -> params.cancel (set when dropping one: a phrase identifying it)
  The difference from "alarm": an alarm fires once at a minute, an event
  occupies whole days and is worth mentioning on each of them. The difference
  from "remember": a fact stays true indefinitely, an event finishes.
- "location": asking where they are, or what Nimbus knows about their
  position - "where am I", "do you know my location", "which city am I in",
  "do you know where I live", "what's my current position", "wo bin ich".
  Nimbus reads this from the device itself, so no parameters are needed.
  This is NOT for asking where some other place is ("where is Frankfurt") -
  that is "search" or "directions".
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
          playIn: { type: SchemaType.STRING, enum: ['youtube', 'here'], format: 'enum' },
          language: { type: SchemaType.STRING },
          from: { type: SchemaType.STRING },
          to: { type: SchemaType.STRING },
          when: { type: SchemaType.STRING },
          timeMode: { type: SchemaType.STRING, enum: ['depart', 'arrive'], format: 'enum' },
          fromHere: { type: SchemaType.STRING, enum: ['yes', 'no'], format: 'enum' },
          // A real two-way choice rather than an optional "yes". The local
          // model decodes under a grammar that must emit every property, so a
          // single-value enum would make every transit question a watch.
          watch: { type: SchemaType.STRING, enum: ['yes', 'no'], format: 'enum' },
          stockAction: {
            type: SchemaType.STRING,
            enum: ['quote', 'list', 'add', 'remove', 'alert'],
            format: 'enum'
          },
          alertPrice: { type: SchemaType.STRING },
          amount: { type: SchemaType.STRING },
          word: { type: SchemaType.STRING },
          fromCurrency: { type: SchemaType.STRING },
          toCurrency: { type: SchemaType.STRING },
          alertDirection: { type: SchemaType.STRING, enum: ['below', 'above'], format: 'enum' },
          topic: { type: SchemaType.STRING },
          fact: { type: SchemaType.STRING },
          forget: { type: SchemaType.STRING },
          task: { type: SchemaType.STRING },
          leaveFor: { type: SchemaType.STRING },
          cancel: { type: SchemaType.STRING },
          eventTitle: { type: SchemaType.STRING },
          eventStart: { type: SchemaType.STRING },
          eventEnd: { type: SchemaType.STRING },
          eventPlace: { type: SchemaType.STRING },
          mode: {
            type: SchemaType.STRING,
            enum: ['driving', 'cycling', 'walking', 'transit'],
            format: 'enum'
          }
        },
        // Forced rather than optional. Flash Lite reliably *omits* an optional
        // enum it isn't sure about — 'tell me when Tesla drops below 300' came
        // back with no stockAction at all and fell through to a plain quote.
        // Requiring it makes the model choose, and 'quote' is a safe default
        // for every non-stock intent.
        required: ['stockAction']
      }
    },
    required: ['intent', 'params']
  }
}

// ---------------------------------------------------------------------------
// Routing on the on-device model
// ---------------------------------------------------------------------------

/**
 * The router prompt above is written for a model that can read four thousand
 * tokens without anyone noticing. On-device that assumption is the entire
 * latency budget, and the schema makes it worse: llama.cpp's JSON grammar
 * makes every property mandatory, so one classification generates all
 * thirty-one parameters whether or not the chosen intent has any use for them.
 *
 * Measured on an RTX 3070 laptop with a 4B model under that grammar, over
 * seventeen utterances: one call for intent and every parameter took 6,764ms.
 * Asking for the intent alone took 543ms. The parameters nobody asked for were
 * most of the wait.
 *
 * So on-device the routing is split. First the intent, against the prompt in
 * full. Then, only when that intent actually carries parameters, a second pass
 * with a schema holding just that intent's fields and a prompt trimmed to just
 * that intent's section of the text above — 1,278ms, and it fills them in as
 * accurately as the single call did. "briefing", "location", "holidays" and
 * "chat" carry none and never make the second call at all.
 *
 * 6.8 seconds to 1.8, with routing accuracy unchanged at 17/17.
 *
 * Cloud providers keep the single call. They are fast, their JSON mode leaves
 * absent fields absent rather than forcing them, and a second round trip there
 * would cost more than it saves.
 */

/**
 * What each intent can carry, which is what the second pass asks for.
 *
 * An intent missing from this map takes no parameters and skips the pass. The
 * cost of listing a field here that the handler never reads is a few tokens;
 * the cost of omitting one it does read is a parameter that is silently always
 * empty, so where a field was ambiguous it is listed.
 */
const INTENT_PARAMS: Partial<Record<NimbusIntent, string[]>> = {
  weather: ['city'],
  stocks: ['symbol', 'stockAction', 'alertPrice', 'alertDirection'],
  crypto: ['coin'],
  news: ['query'],
  github: ['language'],
  music: ['query', 'playback', 'playIn'],
  transit: ['to', 'from', 'fromHere', 'when', 'timeMode', 'watch'],
  directions: ['to', 'from', 'fromHere', 'mode'],
  outdoors: ['city'],
  convert: ['amount', 'fromCurrency', 'toCurrency'],
  // The handler falls back to params.query when params.word is empty.
  define: ['word', 'query'],
  search: ['query', 'entity'],
  remember: ['fact', 'forget'],
  recall: ['query'],
  // from and timeMode are for "tell me when to leave for the office by nine",
  // which plans against a timetable and so needs the journey as well as the
  // reminder.
  alarm: ['task', 'when', 'leaveFor', 'cancel', 'fromHere', 'from', 'timeMode'],
  event: ['eventTitle', 'eventStart', 'eventEnd', 'eventPlace', 'cancel']
}

/** The router prompt taken apart into the pieces each pass needs. */
interface RouterSections {
  /** What the model is, and what it is being asked to do. */
  preamble: string
  /** One entry per intent, keyed by intent name, headline first. */
  blocks: Map<string, string>
  /** The params.topic guidance, which applies whatever the intent. */
  tail: string
}

let sections: RouterSections | null | undefined

/**
 * Splits CLASSIFY_SYSTEM_PROMPT rather than keeping a second, shorter copy of
 * it.
 *
 * A trimmed duplicate would drift the first time someone tunes the wording of
 * an intent, and drift between the prompt that picks an intent and the prompt
 * that fills it in shows up as one phrasing quietly routing wrong. Parsing
 * prose is the lesser risk, and it is checked: if the prompt is ever
 * restructured into a shape this does not recognise, it returns null and
 * routing falls back to the single call.
 */
function routerSections(): RouterSections | null {
  if (sections !== undefined) return sections
  sections = parseRouterPrompt()
  if (!sections) {
    console.warn('[router] prompt not in the expected shape, using the single-pass route')
  }
  return sections
}

function parseRouterPrompt(): RouterSections | null {
  const lines = CLASSIFY_SYSTEM_PROMPT.split('\n')
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^- "[a-z]+":/.test(line)) starts.push(index)
  })

  const tailAt = lines.findIndex((line) => line.startsWith('Separately, for ANY intent'))
  if (starts.length !== VALID_INTENTS.length) return null
  if (tailAt <= starts[starts.length - 1]) return null

  const blocks = new Map<string, string>()
  for (const [n, start] of starts.entries()) {
    const end = n + 1 < starts.length ? starts[n + 1] : tailAt
    const name = /^- "([a-z]+)":/.exec(lines[start])?.[1]
    if (!name) return null
    blocks.set(name, lines.slice(start, end).join('\n').trimEnd())
  }
  // Every intent the app can act on needs a section, or one could be chosen
  // and then have nothing to fill its parameters in from.
  for (const intent of VALID_INTENTS) if (!blocks.has(intent)) return null

  return {
    preamble: lines.slice(0, starts[0]).join('\n').trimEnd(),
    blocks,
    tail: lines.slice(tailAt).join('\n').trimEnd()
  }
}

/** The parameter definitions from the full schema, so there is one source. */
function paramDefinitions(): Record<string, unknown> {
  const schema = CLASSIFY_SCHEMA.responseSchema as unknown as {
    properties: { params: { properties: Record<string, unknown> } }
  }
  return schema.properties.params.properties
}

const INTENT_ONLY_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    intent: { type: SchemaType.STRING, enum: VALID_INTENTS, format: 'enum' }
  },
  required: ['intent']
}

/**
 * Routes on-device in two passes. Returns null when the prompt could not be
 * split, leaving the caller to make its single call.
 */
async function classifyLocally(
  utterance: string,
  context: string
): Promise<IntentClassification | null> {
  const parts = routerSections()
  if (!parts) return null

  // Deliberately the whole prompt, not a trimmed menu of the intent headlines.
  // Cutting it to one line per intent was tried: 451 tokens instead of 3,714,
  // and 340ms instead of 543ms — but 15/17 instead of 17/17. Both misses were
  // the same kind: "I need to be in Mainz by 9" and "keep me posted on the
  // 8:15 to Frankfurt" both became "alarm", because what separates them from
  // an alarm is written in the body of the transit section, not its headline.
  // The 200ms was not worth routing two plausible sentences to the wrong
  // handler.
  const chosen = await complete({
    system: [CLASSIFY_SYSTEM_PROMPT, context].filter((piece) => piece !== '').join('\n'),
    messages: [{ role: 'user', text: utterance }],
    jsonSchema: INTENT_ONLY_SCHEMA as unknown as Record<string, unknown>,
    temperature: 0
  })

  let intent: NimbusIntent = 'chat'
  try {
    const parsed = JSON.parse(stripFences(chosen))
    if (VALID_INTENTS.includes(parsed.intent)) intent = parsed.intent
  } catch {
    return { intent: 'chat', params: {} }
  }

  const fields = INTENT_PARAMS[intent]
  if (!fields || fields.length === 0) return { intent, params: {} }

  const definitions = paramDefinitions()
  const properties: Record<string, unknown> = {}
  for (const field of fields) {
    if (definitions[field]) properties[field] = definitions[field]
  }
  // Asked for whatever the intent, so a picture can accompany any answer.
  if (definitions.topic) properties.topic = definitions.topic

  const filled = await complete({
    system: [parts.preamble, parts.blocks.get(intent) ?? '', parts.tail, context]
      .filter((piece) => piece !== '')
      .join('\n\n'),
    messages: [{ role: 'user', text: utterance }],
    jsonSchema: { type: SchemaType.OBJECT, properties } as unknown as Record<string, unknown>,
    temperature: 0
  })

  try {
    const parsed = JSON.parse(stripFences(filled))
    const raw: Record<string, string> = parsed && typeof parsed === 'object' ? parsed : {}
    return { intent, params: cleanParams(raw, utterance) }
  } catch {
    // The intent is still good. A turn routed correctly with nothing filled in
    // beats one thrown away because the second pass stumbled.
    return { intent, params: {} }
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

  if (activeProvider() === 'local') {
    const routed = await classifyLocally(
      utterance,
      [
        currentTimeContext(),
        placeContext(),
        factsContext(),
        context ? `\nRecent conversation (for resolving pronouns and follow-ups):\n${context}` : ''
      ]
        .filter((part) => part !== '')
        .join('\n')
    )
    if (routed) return routed
  }

  const text = await complete({
    system: systemInstruction,
    messages: [{ role: 'user', text: utterance }],
    jsonSchema: CLASSIFY_SCHEMA.responseSchema as unknown as Record<string, unknown>,
    temperature: 0
  })

  try {
    const parsed = JSON.parse(stripFences(text))
    const intent: NimbusIntent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : 'chat'
    const rawParams: Record<string, string> =
      parsed.params && typeof parsed.params === 'object' ? parsed.params : {}
    return { intent, params: cleanParams(rawParams, utterance) }
  } catch {
    return { intent: 'chat', params: {} }
  }
}


/**
 * Words a model writes when it has nothing to say but the schema demands a
 * string anyway.
 */
const PLACEHOLDERS = new Set(['none', 'n/a', 'na', 'null', 'nil', 'unknown', 'empty', '-', 'chat'])

/** Short openers that are never a request for information. */
const GREETING = /^(hi|hey|hello|yo|hiya|sup|greetings)/i
const PLEASANTRY =
  /^(thanks|thank you|thx|cheers|ok|okay|cool|nice|great|bye|goodbye|see you|good morning|good afternoon|good evening|good night|how are you|how's it going|what's up)/i

/** True for openers and sign-offs that never carry a request. */
function isSmallTalk(utterance: string): boolean {
  const text = utterance.trim().replace(/[!.?]+$/, '')
  // Length-capped so "hey, how far is the airport" is still a real question.
  if (text.length > 24) return false
  return GREETING.test(text) || PLEASANTRY.test(text)
}

/**
 * Filters what the router extracted down to what the user actually said.
 *
 * A constrained-decoding grammar has to emit a value for every property in the
 * schema, so a local model asked to route "hi" cannot leave the fields blank —
 * it invents them. In practice that produced `topic: "Nimbus"` and
 * `topic: "Berlin"` for plain greetings, which then went off and fetched
 * Wikipedia photographs of clouds and of Darmstadt. Cloud models sidestepped
 * this by simply omitting the keys, so the bug only appeared on-device.
 *
 * The rule is grounding: a parameter has to be traceable to the utterance.
 * A real topic is always something the user mentioned — "how does a jet engine
 * work" yields "jet engine" — whereas an invented one shares no words with
 * what was said, which makes it cheap to spot without another model call.
 */
function cleanParams(raw: Record<string, string>, utterance: string): Record<string, string> {
  const said = utterance.toLowerCase()
  const smallTalk = isSmallTalk(utterance)

  const entries = Object.entries(raw).filter(([key, value]) => {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    if (!trimmed) return false
    if (PLACEHOLDERS.has(trimmed.toLowerCase())) return false

    // Nothing is being asked for, so nothing should be extracted.
    if (smallTalk) return false

    // `topic` only ever drives illustrations, and an illustration of something
    // the user never mentioned is pure noise.
    if (key === 'topic') return isGrounded(trimmed, said)

    return true
  })

  return Object.fromEntries(entries)
}

/** True when a meaningful word of `value` actually appears in the utterance. */
function isGrounded(value: string, said: string): boolean {
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .filter((word) => word.length > 3)

  // Nothing substantial to check against — keep it rather than guess wrong.
  if (words.length === 0) return true
  return words.some((word) => said.includes(word))
}

const EVENT_SCHEMA: GenerationConfig = {
  temperature: 0,
  responseMimeType: 'application/json',
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      title: { type: SchemaType.STRING },
      startDate: { type: SchemaType.STRING },
      endDate: { type: SchemaType.STRING },
      location: { type: SchemaType.STRING }
    },
    required: ['title', 'startDate']
  }
}

const EVENT_PROMPT = `Extract the details of something happening on a day or range of days.

- title: what it is, short and without dates — "Reply Leadvise event", "dentist".
- startDate: the first day, YYYY-MM-DD. Resolve relative wording against the
  current date below: "the 24th" is the 24th of this month, or next month if
  that day has already passed; "Tuesday" is the next Tuesday; "this weekend" is
  the coming Saturday. Never return a date in the past. If no day is stated at
  all, use today.
- endDate: the last day, YYYY-MM-DD, only when they gave a range ("from the
  24th to the 27th"). Leave empty for a single day.
- location: the town or city, when one is named. Leave empty otherwise.`

/**
 * Event details, extracted on their own rather than as part of routing.
 *
 * The intent router reliably recognises *that* an utterance is an event, and
 * just as reliably drops the dates: its prompt covers fifteen intents and some
 * twenty-five parameters, and the extra fields fall off the end. "Reply
 * Leadvise event from the 24th to the 27th" came back with a title and no
 * dates at all, and tightening the wording made it worse, not better. A short
 * single-purpose prompt gets it right, and only runs when an event is actually
 * being created.
 */
export async function extractEvent(utterance: string): Promise<{
  title: string
  startDate: string
  endDate?: string
  location?: string
}> {
  const systemInstruction = `${EVENT_PROMPT}\n\n${currentTimeContext()}\n\n${placeContext()}`
  const text = await complete({
    system: systemInstruction,
    messages: [{ role: 'user', text: utterance }],
    jsonSchema: EVENT_SCHEMA.responseSchema as unknown as Record<string, unknown>,
    temperature: 0
  })

  const parsed = JSON.parse(stripFences(text))
  const clean = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined

  return {
    title: clean(parsed.title) ?? '',
    startDate: clean(parsed.startDate) ?? '',
    endDate: clean(parsed.endDate),
    location: clean(parsed.location)
  }
}

/** Called with each token chunk as the model generates it. */
export type StreamHandler = (chunk: string) => void

export async function chat(utterance: string, onChunk?: StreamHandler): Promise<string> {
  const systemInstruction =
    'You are Nimbus, a concise, friendly voice assistant living in a desktop overlay. ' +
    'Keep responses to 1-3 short sentences since they will be read aloud by text-to-speech. ' +
    'Do not use markdown, bullet points, or emoji. ' +
    'You are mid-conversation — refer back to what was already said when relevant.\n\n' +
    'Where the user is comes only from the place context below, which is the ' +
    'real position of their device. Never infer where they live or where they ' +
    'are from places they have asked about: someone looking up a train from ' +
    'Mainz is not in Mainz. With no place context, say you do not know rather ' +
    'than guessing.\n\n' +
    `${replyLanguageContext()}\n\n` +
    `${placeContext()}\n\n` +
    `${factsContext()}\n\n` +
    currentTimeContext()

  // Full prior turns (not just a summary) so the model can genuinely follow
  // the thread rather than answering each utterance in isolation.
  const messages = [
    ...getHistoryAsContents().map((entry) => ({
      role: entry.role,
      text: entry.parts.map((part) => part.text).join('')
    })),
    { role: 'user' as const, text: utterance }
  ]

  if (!onChunk) return complete({ system: systemInstruction, messages })
  return streamComplete({ system: systemInstruction, messages }, onChunk)
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
    'If the data has "usuallyChecksNow", those are the things this person ' +
    'looks at around this time on most days - lead with them where the data ' +
    'covers them. Never mention noticing a habit and never read that list ' +
    'back. Being told what you always do is irritating; knowing it should ' +
    'only show as having the answer ready already.\n\n' +
    `${replyLanguageContext()}\n\n` +
    currentTimeContext()

  // No conversation history here, deliberately.
  //
  // This turns freshly fetched data into a sentence, and it was being handed
  // the last few turns as well. The model blended the two and answered with a
  // departure from an hour earlier, because nothing told it which source was
  // current. Everything Nimbus looks up is perishable - times, prices,
  // weather, what is on now - so the fetched data has to be the only thing it
  // can draw a fact from. Nothing is lost: the router already used the
  // conversation to work out what was being asked.
  const prompt = [
    `The user asked: "${utterance}"`,
    `Intent: ${intent}`,
    `Data: ${JSON.stringify(data)}`,
    '',
    'Every fact in your reply must come from Data above, which was fetched just',
    'now. Never use times, numbers, prices or names from anywhere else. If Data',
    'does not contain something, say you do not have it.',
    '',
    'Respond with only the spoken sentence(s), nothing else.'
  ]
    .filter(Boolean)
    .join('\n')

  const messages = [{ role: 'user' as const, text: prompt }]
  if (!onChunk) return complete({ system: systemInstruction, messages })
  // Streaming can't retry mid-flight without replaying tokens the UI already
  // showed, so any fallback applies to opening the stream only.
  return streamComplete({ system: systemInstruction, messages }, onChunk)
}
