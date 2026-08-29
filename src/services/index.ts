import {
  classifyIntent,
  chat,
  extractEvent,
  formatResponse,
  type StreamHandler
} from './gemini'
import { getWeather } from './weather'
import { getStockQuote } from './stocks'
import {
  addPriceAlert,
  addToWatchlist,
  parseAlert,
  pricedWatchlist,
  removeFromWatchlist
} from './watchlist'
import { getCryptoPrice } from './crypto'
import { getNews } from './news'
import { getTrendingRepos } from './github'
import { describeEpisode, nextEpisode } from './tv'
import { webSearch } from './search'
import { research } from './research'
import { tryIllustrate } from './illustrate'
import { addReminder, cancelReminders, pendingReminders } from './reminders'
import { planDepartureAlarm } from './departure-alarm'
import { buildBriefing } from './briefing'
import { addEvent, removeEvents, upcomingEvents } from './events'
import {
  forgetFacts,
  getFacts,
  recentAnswers,
  recordAnswer,
  rememberFact,
  searchAnswers
} from './memory'
import { lookupEntity } from './wikipedia'
import { findMusic, wantsBrowserPlayback } from './music'
import { isStopPlaybackPhrase, isMediaStopRequest } from '../shared/stop-phrases'
import { watchJourney, wantsWatching } from './watchers'
import { findJourneys, wantsArrival } from './transit'
import { outdoorConditions, describeOutdoors } from './outdoors'
import { convertCurrency, currencyCode, describeConversion } from './currency'
import { upcomingHolidays, describeHolidays } from './holidays'
import { defineWord, describeDefinition } from './dictionary'
import { watchOutdoors, wantsOutdoorWatch, outdoorWatchMode } from './outdoor-watch'
import {
  geocode,
  getDirections,
  mapForPlace,
  modeFromUtterance,
  wantsMap,
  PLACE_ZOOM_STREET,
  PLACE_ZOOM_TOWN
} from './maps'
import { findStation } from './radio'
import { recordTurn } from './conversation'
import { describeRoutine, noteAsk, routinesNow } from './routines'
import {
  asksWhereTheyAre,
  describeWhereYouAre,
  deviceLocation,
  meansFromHere
} from './device-location'
import { learnFrom } from './learn'
import type { MemoryCardData, NimbusIntent, NimbusResponse, TravelMode } from '../shared/types'
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

/** "in 20 minutes" / "at 18:00" — how a new reminder is confirmed aloud. */
function describeWhen(at: Date): string {
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000)
  if (minutes <= 1) return "I'll tell you in a moment"
  if (minutes < 90) return `I'll tell you in ${minutes} minutes`
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = at.toDateString() === new Date().toDateString()
  return `I'll tell you at ${clock}${sameDay ? '' : ` on ${at.toLocaleDateString([], { weekday: 'long' })}`}`
}

/** "on Monday 24 August" / "24 to 27 August" — how an event is confirmed aloud. */
function describeEventDates(event: { startDate: string; endDate?: string }): string {
  const start = new Date(`${event.startDate}T12:00:00`)
  const long: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }
  if (!event.endDate || event.endDate === event.startDate) {
    return `on ${start.toLocaleDateString('en-GB', long)}`
  }
  const end = new Date(`${event.endDate}T12:00:00`)
  return `from ${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} to ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`
}

/** Card shown after storing or dropping a fact: the profile as it now stands. */
function memoryCard(query: string): MemoryCardData {
  return { query, answers: [], facts: getFacts() }
}

export async function handleUtterance(
  utterance: string,
  onChunk?: StreamHandler,
  onSearching?: (active: boolean) => void
): Promise<NimbusResponse> {
  const { intent, ...resolved } = await resolveUtterance(utterance, onChunk, onSearching)
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
  // Deliberately not awaited. Noticing that someone works in Frankfurt is
  // worth much less than answering them promptly, and if the extraction fails
  // nothing about this turn should change.
  void learnFrom(utterance)
  // The archive keeps the full answer, not the spoken truncation — the whole
  // point of looking something up again is getting all of it back.
  if (intent !== 'recall' && intent !== 'remember') {
    recordAnswer(utterance, resolved.speech, intent)
  }
  return response
}

async function resolveUtterance(
  utterance: string,
  onChunk?: StreamHandler,
  onSearching?: (active: boolean) => void
): Promise<NimbusResponse & { intent: NimbusIntent }> {
  // Before the router: "stop the music" is silence, not a YouTube search
  // for a song of that name. The renderer also intercepts this; this is the
  // backstop if a transcript still arrives here.
  if (isMediaStopRequest(utterance)) {
    return { speech: 'Stopped.', card: { type: 'text' }, intent: 'music' }
  }
  const { intent, params } = await classifyIntent(utterance)
  // Noted before running it, so a question still counts even if the lookup
  // fails. What is being learned is what you asked for, not what came back.
  noteAsk(intent, params)
  const response = await runIntent(intent, params, utterance, onChunk, onSearching)
  return { ...response, intent }
}

async function runIntent(
  intent: NimbusIntent,
  params: Record<string, string>,
  utterance: string,
  onChunk?: StreamHandler,
  onSearching?: (active: boolean) => void
): Promise<NimbusResponse> {
  try {
    // Before the switch, deliberately. "Where am I" was being classified as a
    // memory lookup and answered "nothing saved for that", because the check
    // for it lived inside the chat branch and chat was never reached. Where
    // the machine is is not a question any intent should get to answer: it is
    // a fact the operating system holds, and no router should stand between
    // the user and it.
    //
    // The router's own classification comes first, so this works for any
    // phrasing rather than the handful someone thought to list. The phrase
    // test behind it is only a backstop for when the router drops the intent,
    // which this one does often enough to matter.
    if (intent === 'location' || asksWhereTheyAre(utterance)) {
      const speech = await describeWhereYouAre()
      // "Where am I" wants telling; "show me where I am on the map" wants
      // showing. Every map in Nimbus used to be a by-product of working out a
      // journey, so asking to see your own position — which is not a journey —
      // returned a sentence and nothing else, however plainly you asked for a
      // map.
      if (config.integrations.maps && wantsMap(utterance)) {
        const fix = await deviceLocation()
        if (fix) {
          const map = await mapForPlace(
            { name: speech, lat: fix.lat, lon: fix.lon },
            PLACE_ZOOM_STREET
          )
          return { speech, card: { type: 'place', data: { name: speech, map } } }
        }
      }
      return { speech, card: { type: 'text' } }
    }

    // "Show me Munich on the map" is a place, not a search and not a journey.
    //
    // The router sends it to `search`, which is right for "what is Munich" and
    // useless for this: it answered a request to see a city with a list of web
    // links. Handled before the switch because it is the same question
    // whichever intent the router picked for it — what matters is that they
    // named somewhere and asked to see it.
    if (
      config.integrations.maps &&
      wantsMap(utterance) &&
      (intent === 'search' || intent === 'chat') &&
      (params.entity || params.topic)
    ) {
      const place = await geocode(params.entity || params.topic)
      if (place) {
        return {
          speech: `${place.name}.`,
          card: { type: 'place', data: { name: place.name, map: await mapForPlace(place, PLACE_ZOOM_TOWN) } }
        }
      }
    }

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

        const action = params.stockAction || 'quote'

        if (action === 'list') {
          const stocks = await pricedWatchlist()
          if (stocks.length === 0) {
            return {
              speech: "You aren't following any stocks yet. Say \"add Tesla to my stocks\".",
              card: { type: 'watchlist', data: { stocks: [] } }
            }
          }
          // Deterministic rather than model-written: this is a list of numbers,
          // and a sentence per stock would be slower and no clearer.
          const movers = stocks
            .map((s) => `${s.symbol} ${s.changePercent >= 0 ? 'up' : 'down'} ${Math.abs(s.changePercent).toFixed(1)}%`)
            .join(', ')
          return {
            speech: `Your stocks today: ${movers}.`,
            card: { type: 'watchlist', data: { stocks } }
          }
        }

        const symbol = params.symbol
        if (!symbol) throw new Error("I didn't catch which ticker you meant.")

        // "Show me Tesla and Google" is one question about two companies. The
        // router returns them comma-separated; anything with more than one
        // gets the list card rather than silently answering about the first.
        const symbols = symbol
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)

        if (action === 'quote' && symbols.length > 1) {
          const quotes = await Promise.all(
            symbols.slice(0, 6).map((entry) => getStockQuote(entry, '1d').catch(() => null))
          )
          const stocks = quotes.filter((quote): quote is NonNullable<typeof quote> => quote !== null)
          if (stocks.length === 0) throw new Error("I couldn't find those stocks.")
          const movers = stocks
            .map(
              (s) =>
                `${s.symbol} ${s.changePercent >= 0 ? 'up' : 'down'} ${Math.abs(s.changePercent).toFixed(1)}%`
            )
            .join(', ')
          return { speech: `${movers}.`, card: { type: 'watchlist', data: { stocks } } }
        }

        if (action === 'add') {
          const added: string[] = []
          for (const entry of symbols.slice(0, 6)) {
            // One bad name shouldn't lose the others in "add Tesla and Googl".
            try {
              added.push(await addToWatchlist(entry))
            } catch (err) {
              console.warn(`[stocks] could not add ${entry}:`, err)
            }
          }
          if (added.length === 0) throw new Error(`I couldn't find "${symbol}".`)
          const stocks = await pricedWatchlist()
          return {
            speech: `Added ${added.join(' and ')} to your stocks.`,
            card: { type: 'watchlist', data: { stocks } }
          }
        }

        if (action === 'remove') {
          const gone = symbols.filter((entry) => removeFromWatchlist(entry))
          const stocks = await pricedWatchlist()
          return {
            speech: gone.length
              ? `Removed ${gone.join(' and ').toUpperCase()} from your stocks.`
              : `${symbol.toUpperCase()} wasn't in your stocks.`,
            card: { type: 'watchlist', data: { stocks } }
          }
        }

        if (action === 'alert') {
          // The sentence first, the router second: the parser reads a number
          // out of "goes down to $200" every time, and the model keeps
          // omitting it entirely.
          const parsed = parseAlert(utterance)
          const modelPrice = Number((params.alertPrice ?? '').replace(/,/g, ''))
          const price = parsed?.price ?? (Number.isFinite(modelPrice) ? modelPrice : NaN)
          if (!Number.isFinite(price) || price <= 0) {
            throw new Error(
              "I didn't catch the price to watch for. Try \"tell me when Tesla drops below 300\"."
            )
          }

          // Direction, in order of how much it can be trusted: what the words
          // actually said, then the router, then where the price is now --
          // "notify me at 300" with the stock at 340 can only mean below.
          let direction = parsed?.direction ?? null
          if (!direction && (params.alertDirection === 'above' || params.alertDirection === 'below')) {
            direction = params.alertDirection
          }
          if (!direction) {
            const now = await getStockQuote(symbols[0], '1d')
            direction = price > now.price ? 'above' : 'below'
          }

          const { speech } = await addPriceAlert(symbols[0], direction, price)
          const data = await getStockQuote(symbols[0], '1d')
          return { speech, card: { type: 'stock', data } }
        }

        const data = await getStockQuote(symbols[0], '1d')
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
        if (isStopPlaybackPhrase(utterance)) {
          return { speech: 'Stopped.', card: { type: 'text' } }
        }
        const query = params.query || utterance
        // Only when they asked for it. The router decides however it was
        // phrased; the regex is a backstop for the plain wordings.
        const toBrowser = params.playIn === 'youtube' || wantsBrowserPlayback(utterance)

        // Background music by genre or mood plays *inside* Nimbus via a radio
        // stream. Skipped entirely when they asked for YouTube, since handing
        // them a radio station is not what they asked for either.
        if (!toBrowser && params.playback !== 'track') {
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

        const data = await findMusic(query, toBrowser)
        // Skip the model round-trip: the useful confirmation is just what's
        // playing, and this keeps "play X" feeling immediate.
        //
        // A specific track cannot legitimately be streamed in-app — see
        // src/services/radio.ts — so all Nimbus can do is find it. It used to
        // then open the browser every time, which meant asking for music threw
        // a YouTube window over whatever you were doing. Now the card sits
        // there with a play button and waits.
        return {
          speech: toBrowser
            ? `Opening ${data.title} by ${data.channel}.`
            : `I found ${data.title} by ${data.channel}. Tap it to play.`,
          card: { type: 'music', data }
        }
      }

      case 'transit': {
        // "Trains to Frankfurt and show me the map" is a departure board plus a
        // picture, and only the directions answer carries a picture - it
        // includes the departures too, so nothing is lost by answering there.
        // Routed as plain transit it returned the times and no map at all,
        // which reads as the map being broken.
        if (config.integrations.maps && params.to && wantsMap(utterance)) {
          const data = await getDirections(
            params.fromHere === 'yes' || meansFromHere(utterance) ? undefined : params.from,
            params.to,
            'transit'
          )
          const speech = await formatResponse('directions', utterance, data, onChunk)
          return { speech, card: { type: 'directions', data } }
        }

        if (!config.integrations.transit) {
          throw new Error('Transit lookups are disabled in config.json.')
        }
        const destination = params.to
        if (!destination) throw new Error("I didn't catch where you're heading.")

        // "From my place" means from the device, not from whichever station
        // the router inferred from earlier conversation. Dropping the guess is
        // what lets transit fall through to the real position. The router
        // decides, so any wording works; the phrase test is the backstop.
        const startsHere = params.fromHere === 'yes' || meansFromHere(utterance)
        const origin = startsHere ? undefined : params.from

        // "…and keep me posted" turns a lookup into a standing watch. The
        // classifier's own flag is checked first and the phrase test is the
        // backstop: the router is better at "notify me if it's delayed" than a
        // regex can be, but the regex catches the case where it forgets.
        if (params.watch === 'yes' || wantsWatching(utterance)) {
          const { watch, speech } = await watchJourney(origin, destination, params.when)
          const data = await findJourneys(origin, destination, watch.scheduledDeparture)
          return { speech, card: { type: 'transit', data } }
        }

        // "Be there by nine" is a deadline, not a departure. Same belt and
        // braces as the watch flag above: the router's own answer first, the
        // sentence itself as the backstop when it omits the enum.
        const arriveBy = params.timeMode === 'arrive' || wantsArrival(utterance)
        const data = await findJourneys(origin, destination, params.when, arriveBy)
        const speech = await formatResponse('transit', utterance, data, onChunk)
        return { speech, card: { type: 'transit', data } }
      }

      case 'outdoors': {
        // "Tell me when it's good" is a standing question, not a lookup — the
        // one thing a chat assistant cannot do is still be thinking about you
        // in an hour.
        if (wantsOutdoorWatch(utterance)) {
          const { speech } = await watchOutdoors(outdoorWatchMode(utterance), params.city)
          const data = await outdoorConditions(params.city)
          return { speech, card: { type: 'outdoors', data } }
        }

        const data = await outdoorConditions(params.city)
        // Not sent to the model: the verdict is already a sentence, and every
        // round trip here is quota spent to reword something deterministic.
        return { speech: describeOutdoors(data), card: { type: 'outdoors', data } }
      }

      case 'convert': {
        const amount = Number((params.amount ?? '1').replace(/,/g, ''))
        const from = currencyCode(params.fromCurrency, 'EUR')
        const to = currencyCode(params.toCurrency, 'USD')
        const data = await convertCurrency(Number.isFinite(amount) ? amount : 1, from, to)
        // Arithmetic, not prose: a model that miscalculates a conversion is
        // worse than no feature, so it is never asked.
        return { speech: describeConversion(data), card: { type: 'currency', data } }
      }

      case 'holidays': {
        const holidays = await upcomingHolidays()
        return {
          speech: describeHolidays(holidays),
          // Holidays are days on a calendar, so they render through the card
          // that already draws those rather than needing one of their own.
          card: { type: 'event', data: { created: null, upcoming: holidays } }
        }
      }

      case 'episode': {
        if (!config.integrations.tv) {
          throw new Error('The TV integration is disabled in config.json.')
        }
        const show = params.query
        if (!show) throw new Error("I didn't catch which show you meant.")
        const data = await nextEpisode(show)
        return { speech: describeEpisode(data), card: { type: 'tv', data } }
      }

      case 'define': {
        const word = params.word || params.query
        if (!word) throw new Error("I didn't catch which word you meant.")
        const data = await defineWord(word)
        return { speech: describeDefinition(data), card: { type: 'entity', data } }
      }

      case 'directions': {
        if (!config.integrations.maps) {
          throw new Error('Maps and directions are disabled in config.json.')
        }
        const destination = params.to
        if (!destination) throw new Error("I didn't catch where you want to go.")
        const data = await getDirections(
          // Same as transit: starting where you are outranks any guess.
          params.fromHere === 'yes' || meansFromHere(utterance) ? undefined : params.from,
          destination,
          (params.mode as TravelMode) || modeFromUtterance(utterance)
        )
        // The map answers "where"; the spoken line answers "how far and how
        // long", so it only needs the costed options, not the geometry.
        const speech = await formatResponse(
          'directions',
          utterance,
          { from: data.from, to: data.to, options: data.options },
          onChunk
        )
        return { speech, card: { type: 'directions', data } }
      }

      case 'remember': {
        if (params.forget) {
          const removed = forgetFacts(params.forget)
          const speech =
            removed.length > 0
              ? `Forgotten: ${removed.map((fact) => fact.text).join('; ')}.`
              : `I wasn't holding anything about "${params.forget}".`
          return { speech, card: { type: 'memory', data: memoryCard('') } }
        }

        const fact = rememberFact(params.fact || utterance)
        if (!fact) throw new Error("I didn't catch what to remember.")
        // Skipping the model round-trip keeps this instant, and there's
        // nothing to phrase — echoing it back is the useful confirmation.
        return {
          speech: `Got it — I'll remember that.`,
          card: { type: 'memory', data: memoryCard('') }
        }
      }

      case 'alarm': {
        if (params.cancel !== undefined && !params.task && !params.when && !params.leaveFor) {
          const cancelled = cancelReminders(params.cancel)
          return {
            speech:
              cancelled.length > 0
                ? `Cancelled ${cancelled.length === 1 ? 'it' : `${cancelled.length} reminders`}.`
                : "You don't have a reminder like that.",
            card: { type: 'reminder', data: { created: null, pending: pendingReminders() } }
          }
        }

        // "Tell me when to leave" — worked out from the timetable, not a clock
        // time the user had to know in advance.
        if (params.leaveFor) {
          // "Be at the office by nine" is a deadline; "tell me when to leave
          // for the office" is not. Same phrase test the transit lookup uses,
          // so the two agree about what was asked.
          const deadline =
            params.timeMode === 'arrive' || wantsArrival(utterance) ? params.when : undefined
          const alarm = await planDepartureAlarm(
            params.leaveFor,
            params.fromHere === 'yes' || meansFromHere(utterance) ? undefined : params.from,
            deadline
          )
          const created = addReminder({
            at: alarm.at,
            text: alarm.text,
            departure: alarm.departure
          })
          // The reminder alone is a calculation frozen at the moment it was
          // made. Watching the journey too is what makes this worth having:
          // if that train is cancelled at seven in the morning, the thing
          // Nimbus knows is that you were counting on it.
          await watchJourney(params.from, params.leaveFor, alarm.journey.departsAt).catch(
            (error: unknown) => {
              // A failed watch must not lose the user their reminder.
              console.warn('[commute] could not watch the journey:', error)
            }
          )
          const leaveIn = Math.max(
            0,
            Math.round((new Date(alarm.at).getTime() - Date.now()) / 60_000)
          )
          return {
            speech: `The ${alarm.departure.line} leaves at ${alarm.departure.departs}. I'll tell you to go in ${leaveIn} minutes.`,
            card: { type: 'reminder', data: { created, pending: pendingReminders() } }
          }
        }

        if (!params.task && !params.when) {
          const pending = pendingReminders()
          return {
            speech:
              pending.length > 0
                ? `You have ${pending.length} reminder${pending.length === 1 ? '' : 's'} coming up.`
                : "You don't have any reminders set.",
            card: { type: 'reminder', data: { created: null, pending } }
          }
        }

        const at = new Date(params.when ?? '')
        if (Number.isNaN(at.getTime())) {
          throw new Error("I didn't catch when you want to be reminded.")
        }
        const created = addReminder({ at: at.toISOString(), text: params.task || 'Reminder.' })
        return {
          speech: `Right — ${describeWhen(at)}.`,
          card: { type: 'reminder', data: { created, pending: pendingReminders() } }
        }
      }

      case 'event': {
        if (params.cancel !== undefined && !params.eventTitle) {
          const removed = removeEvents(params.cancel)
          return {
            speech:
              removed.length > 0
                ? `Removed ${removed.map((event) => event.title).join('; ')}.`
                : "I don't have an event like that.",
            card: { type: 'event', data: { created: null, upcoming: upcomingEvents() } }
          }
        }

        if (!params.eventTitle) {
          const upcoming = upcomingEvents()
          return {
            speech:
              upcoming.length > 0
                ? await formatResponse(
                    'event',
                    utterance,
                    upcoming.map((event) => ({
                      what: event.title,
                      from: event.startDate,
                      to: event.endDate,
                      where: event.location
                    })),
                    onChunk
                  )
                : "You haven't told me about anything coming up.",
            card: { type: 'event', data: { created: null, upcoming } }
          }
        }

        // Details come from the focused extractor, not from the router's
        // params — see extractEvent for why the router can't be trusted with
        // the dates. The router's job here was only to recognise the intent.
        const details = await extractEvent(utterance)
        const created = addEvent({
          title: details.title || params.eventTitle,
          startDate: details.startDate || params.eventStart,
          endDate: details.endDate || params.eventEnd,
          location: details.location || params.eventPlace
        })
        return {
          speech: `Noted — ${created.title}, ${describeEventDates(created)}.`,
          card: { type: 'event', data: { created, upcoming: upcomingEvents() } }
        }
      }

      case 'briefing': {
        const data = await buildBriefing()
        if (
          !data.weather &&
          !data.news &&
          data.reminders.length === 0 &&
          data.today.length === 0 &&
          data.upcoming.length === 0
        ) {
          throw new Error("I couldn't put a briefing together — nothing was reachable.")
        }
        // Only the parts that came back are described, so a failed section is
        // simply absent rather than being apologised for.
        const speech = await formatResponse(
          'briefing',
          utterance,
          {
            weather: data.weather && {
              city: data.weather.city,
              temp: data.weather.temp,
              condition: data.weather.condition
            },
            today: data.today.map((event) => ({ what: event.title, where: event.location })),
            comingUp: data.upcoming.map((event) => ({
              what: event.title,
              from: event.startDate,
              to: event.endDate,
              where: event.location
            })),
            nextDepartures: data.commute?.journeys.slice(0, 2).map((journey) => ({
              departs: journey.departs,
              line: journey.legs[0]?.line,
              to: data.commute?.to
            })),
            reminders: data.reminders.map((reminder) => reminder.text),
            headlines: data.news?.articles.map((article) => article.title),
            // What this person checks at roughly this time on most days. Given
            // to the model as context rather than read out as a list: the
            // useful behaviour is a briefing that already covers the usual
            // things, not one that announces it knows your habits.
            usuallyChecksNow: routinesNow().slice(0, 3).map(describeRoutine)
          },
          onChunk
        )
        return { speech, card: { type: 'briefing', data } }
      }

      case 'recall': {
        const query = params.query
        const answers = query ? searchAnswers(query) : recentAnswers()
        const facts = getFacts()

        if (answers.length === 0) {
          // "What do you know about me" searches for nothing useful — the
          // answer to it is the profile, which would otherwise sit on the
          // card while the spoken reply claimed there was nothing.
          if (facts.length > 0) {
            const speech = await formatResponse('recall', utterance, { knownAboutUser: facts.map((fact) => fact.text) }, onChunk)
            return { speech, card: { type: 'memory', data: { query: query || '', answers: [], facts } } }
          }
          return {
            speech: query
              ? `I don't have anything saved about ${query}.`
              : "I haven't answered anything yet.",
            card: { type: 'memory', data: memoryCard(query || '') }
          }
        }
        // The model reads the matches back conversationally rather than the
        // card being the whole answer — this is usually asked hands-free.
        const speech = await formatResponse(
          'recall',
          utterance,
          answers.map((entry) => ({ asked: entry.question, answered: entry.answer, at: entry.at })),
          onChunk
        )
        return { speech, card: { type: 'memory', data: { query: query || '', answers, facts } } }
      }

      case 'search': {
        if (!config.integrations.search) {
          throw new Error('Web search is disabled in config.json.')
        }
        const query = params.query || utterance
        // Runs alongside the search and synthesis, so pictures cost no extra
        // wall-clock time. Skipped for entity answers, which already carry
        // their own Wikipedia photo.
        const pictures = params.entity ? Promise.resolve([]) : tryIllustrate(params.topic)

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

        // Deep mode plans sub-queries and reads the pages themselves; it costs
        // more search credits and a couple of seconds, and answers questions a
        // snippet search simply can't.
        if (config.search?.deep) {
          // Once a chunk has reached the UI there's no falling back — a second
          // attempt would stream a fresh answer on top of the first.
          let streamed = false
          const track = onChunk
            ? (chunk: string) => {
                streamed = true
                onChunk(chunk)
              }
            : undefined
          try {
            const { speech, card } = await research(utterance, query, track, onSearching)
            return {
              speech,
              card: { type: 'search', data: { ...card, illustrations: await pictures } }
            }
          } catch (err) {
            if (streamed) throw err
            console.warn('[nimbus] deep search failed, falling back:', err)
          }
        }

        onSearching?.(true)
        let data: Awaited<ReturnType<typeof webSearch>>
        try {
          data = await webSearch(query)
        } finally {
          onSearching?.(false)
        }
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
        return {
          speech,
          card: { type: 'search', data: { ...data, illustrations: await pictures } }
        }
      }

      default: {
        // Started before the answer so the pictures are fetched while the
        // model is still writing, rather than after it finishes.
        const pictures = tryIllustrate(params.topic)
        const speech = await chat(utterance, onChunk)
        const illustrations = await pictures
        if (illustrations.length === 0) return { speech, card: { type: 'text' } }
        return {
          speech,
          card: { type: 'explainer', data: { topic: params.topic as string, illustrations } }
        }
      }
    }
  } catch (err) {
    const speech = err instanceof Error ? err.message : 'Something went wrong.'
    return { speech, card: { type: 'text' } }
  }
}
