/**
 * Everything Nimbus can do, in one list.
 *
 * This exists because features are reached by *saying* them rather than by
 * pressing something. That keeps the app to three global hotkeys no matter how
 * much it learns to do — but an invisible feature is worse than an awkwardly
 * bound one, so there has to be somewhere to see the whole set.
 *
 * The palette shows these and, on picking one, types the example into the
 * input rather than running a hidden command. That way the list teaches the
 * phrasing and then gets out of the way: next time you just say it.
 *
 * Keep this in step with the intents in `src/services/gemini.ts` — anything
 * missing here is, in practice, a feature nobody will find.
 */

export interface Capability {
  /** Grouping shown as a section header. */
  group: string
  /** Short name of the thing it does. */
  title: string
  /** A phrase that actually works, inserted into the input when picked. */
  example: string
  /** Extra words to match against when filtering. */
  keywords?: string
  /** Needs something captured first (screenshot, selection). */
  requires?: string
  /** Opens a panel instead of typing the example — for things that are not
   *  questions, like the settings screen. */
  action?: 'settings' | 'subtitles' | 'meeting'
}

export const CAPABILITIES: Capability[] = [
  {
    group: 'Setup',
    title: 'Settings and API keys',
    example: 'open settings',
    keywords: 'api key model provider gemini openai anthropic config setup token',
    action: 'settings'
  },
  {
    group: 'Listen along',
    title: 'Record a meeting',
    example: 'record meeting',
    keywords: 'meeting call transcript minutes notes record capture dialogue summary teams zoom',
    action: 'meeting'
  },
  {
    group: 'Listen along',
    title: 'Live subtitles for a video',
    example: 'subtitles',
    keywords: 'translate subtitle movie film video youtube dub foreign language german caption',
    action: 'subtitles'
  },
  // Everyday lookups
  {
    group: 'Look things up',
    title: 'Search the web',
    example: 'what happened with the ECB rate decision',
    keywords: 'google research find news current'
  },
  {
    group: 'Look things up',
    title: 'Explain something',
    example: 'how does a jet engine work',
    keywords: 'diagram picture illustration teach what is'
  },
  {
    group: 'Look things up',
    title: 'Weather',
    example: "what's the weather in Darmstadt",
    keywords: 'forecast temperature rain'
  },
  {
    group: 'Look things up',
    title: 'News headlines',
    example: 'give me the news',
    keywords: 'headlines today stories'
  },
  {
    group: 'Look things up',
    title: 'Stock price',
    example: 'how is Apple stock doing',
    keywords: 'shares ticker market'
  },
  {
    group: 'Look things up',
    title: 'Crypto price',
    example: "what's bitcoin at",
    keywords: 'coin btc ethereum'
  },

  // Getting around
  {
    group: 'Getting around',
    title: 'Next departures',
    example: 'when is the next train to Frankfurt',
    keywords: 'train bahn s-bahn tram bus timetable transit transport departure'
  },
  {
    group: 'Getting around',
    title: 'Follow a train for delays',
    example: 'the 17:30 to Frankfurt, keep me posted',
    keywords: 'watch delay delayed cancelled keep me updated notify posted track train'
  },
  {
    group: 'Outside',
    title: 'Is it a good time to go out?',
    example: 'is it a good time for a run',
    keywords: 'run jog jogging cycle walk outside outdoors exercise sport training'
  },
  {
    group: 'Outside',
    title: 'Pollen, air quality and UV',
    example: "how's the pollen today",
    keywords: 'pollen hay fever allergy air quality aqi smog uv sunscreen burn'
  },
  {
    group: 'Getting around',
    title: 'Distance and travel time',
    example: 'how far is the airport',
    keywords: 'map directions route drive walk cycle how long'
  },
  {
    group: 'Getting around',
    title: 'Tell me when to leave',
    example: 'tell me when I need to leave for Frankfurt',
    keywords: 'departure alarm catch train set off'
  },

  // Your day
  {
    group: 'Your day',
    title: 'Daily briefing',
    example: 'what does my day look like',
    keywords: 'brief catch me up morning summary today'
  },
  {
    group: 'Your day',
    title: 'Add something to your calendar',
    example: "I'm in Düsseldorf for a conference from the 24th to the 27th",
    keywords: 'event trip appointment date days plans'
  },
  {
    group: 'Your day',
    title: "What's coming up",
    example: 'what have I got coming up',
    keywords: 'events calendar plans upcoming'
  },
  {
    group: 'Your day',
    title: 'Set a reminder',
    example: 'remind me in 20 minutes to call the landlord',
    keywords: 'alarm timer later notify'
  },

  // Memory
  {
    group: 'Memory',
    title: 'Remember something about you',
    example: 'remember that I take the RB68 to work',
    keywords: 'profile preference save fact'
  },
  {
    group: 'Memory',
    title: 'Recall a past answer',
    example: 'what was that station you told me about',
    keywords: 'history earlier yesterday said before'
  },
  {
    group: 'Memory',
    title: 'What you know about me',
    example: 'what do you know about me',
    keywords: 'profile facts stored'
  },

  // On your screen
  {
    group: 'On your screen',
    title: 'Ask about the screen',
    example: 'what does this letter say',
    keywords: 'screenshot capture read translate document',
    requires: 'Ctrl+Shift+S first'
  },
  {
    group: 'On your screen',
    title: 'Read an official letter',
    example: 'what does this letter say',
    keywords: 'document form invoice bill contract deadline paperwork brief rechnung bescheid amt behörde',
    requires: 'Ctrl+Shift+S first'
  },
  {
    group: 'On your screen',
    title: 'Act on selected text',
    example: 'translate this into English',
    keywords: 'selection rewrite summarise grammar reply',
    requires: 'Ctrl+Shift+A first'
  },

  // Playback
  {
    group: 'Playback',
    title: 'Play music',
    example: 'play some lofi',
    keywords: 'song radio station video youtube'
  },
  {
    group: 'Playback',
    title: 'Stop playback',
    example: 'stop the music',
    keywords: 'pause quiet silence'
  }
]

/**
 * Ranked matches for what has been typed after the slash. Scored rather than
 * filtered so the closest thing surfaces first: typing "trans" should lead
 * with departures and translation, not with whatever happens to be first.
 */
export function matchCapabilities(query: string): Capability[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return CAPABILITIES

  const scored = CAPABILITIES.map((capability) => {
    const title = capability.title.toLowerCase()
    const haystack = `${title} ${capability.example} ${capability.keywords ?? ''}`.toLowerCase()
    let score = 0
    if (title.startsWith(needle)) score += 4
    else if (title.includes(needle)) score += 3
    if (haystack.includes(needle)) score += 1
    // Every word must appear somewhere, so "train frankfurt" narrows rather
    // than widening the way a plain OR would.
    const words = needle.split(/\s+/)
    if (words.length > 1 && words.every((word) => haystack.includes(word))) score += 2
    return { capability, score }
  })

  return scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.capability)
}
