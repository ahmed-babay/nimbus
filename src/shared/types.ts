export type AiProvider = 'local' | 'gemini' | 'openai' | 'anthropic'

export type SecretName =
  | 'GEMINI_API_KEY'
  | 'OPENAI_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'GROQ_API_KEY'
  | 'TAVILY_API_KEY'
  | 'OPENWEATHER_API_KEY'
  | 'GNEWS_API_KEY'
  | 'GITHUB_TOKEN'

export interface SecretStatus {
  name: SecretName
  set: boolean
  /** Where the value came from. "env" cannot be overridden from settings. */
  source: 'env' | 'settings' | 'none'
  /** Masked fragment, so you can tell which key is stored. Never the key. */
  hint: string | null
}

export interface AiChoice {
  provider: AiProvider
  /** Empty means "use the built-in default for this provider". */
  model: string
}

export interface ProviderModel {
  id: string
  label: string
}

export type NimbusIntent =
  | 'weather'
  | 'stocks'
  | 'crypto'
  | 'news'
  | 'github'
  | 'search'
  | 'music'
  | 'transit'
  | 'directions'
  | 'remember'
  | 'recall'
  | 'alarm'
  | 'event'
  | 'briefing'
  | 'chat'

export interface IntentClassification {
  intent: NimbusIntent
  params: Record<string, string>
}

export interface WeatherCardData {
  city: string
  temp: number
  feelsLike: number
  condition: string
  icon: string
  humidity: number
  windSpeed: number
}

export interface StockCardData {
  symbol: string
  price: number
  change: number
  changePercent: number
  high: number
  low: number
  /** Recent closing prices, oldest first — drives the sparkline. */
  history: number[]
}

export interface CryptoCardData {
  name: string
  symbol: string
  price: number
  change24h: number
  marketCap: number
  /** Recent prices, oldest first — drives the sparkline. */
  history: number[]
}

export interface EntityCardData {
  title: string
  description: string | null
  extract: string
  /** base64 data URI — the overlay's CSP blocks remote image URLs. */
  image: string | null
  url: string
}

export interface NewsArticle {
  title: string
  source: string
  url: string
  publishedAt: string
  /** base64 data URI thumbnail, or null when the article has no usable image. */
  image: string | null
}

export interface NewsCardData {
  query: string
  articles: NewsArticle[]
  /**
   * Topic-level illustrations, used when the provider gives images for the
   * search rather than per article. Deliberately separate from
   * `NewsArticle.image` so an unrelated picture is never shown as if it
   * belonged to a specific headline. Rendered as a cross-fading carousel.
   */
  heroImages: string[]
}

export interface GithubRepo {
  name: string
  fullName: string
  description: string
  stars: number
  url: string
  language: string | null
}

export interface GithubCardData {
  language: string | null
  repos: GithubRepo[]
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** A picture that helps explain the answer, with its source article. */
export interface Illustration {
  /** base64 data URI — the overlay's CSP blocks remote image URLs. */
  image: string
  caption: string
  url: string
  /**
   * Line art or a schematic rather than a photo. These must be shown whole on
   * a light backdrop; cropping a labelled diagram loses the labels.
   */
  diagram: boolean
}

export interface SearchCardData {
  query: string
  answer: string | null
  results: SearchResult[]
  illustrations?: Illustration[]
}

/** A spoken explanation that had no data card of its own, but earned pictures. */
export interface ExplainerCardData {
  topic: string
  illustrations: Illustration[]
}

export interface MusicCardData {
  title: string
  channel: string
  duration: string
  thumbnail: string | null
  url: string
  query: string
}

export interface RadioCardData {
  name: string
  /** Direct audio stream, played in-app by an <audio> element. */
  streamUrl: string
  codec: string
  bitrate: number
  tags: string[]
  country: string
  query: string
}

export interface TransitLeg {
  line: string
  /** Service number, e.g. the "24514" in "RB75 (24514)". */
  number: string | null
  direction: string
  from: string
  to: string
  departs: string
  arrives: string
  platform: string | null
}

export interface TransitJourney {
  departs: string
  arrives: string
  /** Departure as ISO, so the card can count down to it. */
  departsAt: string
  durationMinutes: number
  changes: number
  legs: TransitLeg[]
}

export interface TransitCardData {
  from: string
  to: string
  journeys: TransitJourney[]
}

/** Something happening on a given day (or range), as told to Nimbus. */
export interface CalendarEvent {
  id: string
  title: string
  /** YYYY-MM-DD. Day granularity: "the 24th" has no meaningful time of day. */
  startDate: string
  /** Last day, for multi-day events. Absent means a single day. */
  endDate?: string
  location?: string
  createdAt: string
}

export interface EventCardData {
  created: CalendarEvent | null
  upcoming: CalendarEvent[]
}

export interface BriefingCardData {
  weather: WeatherCardData | null
  /** Days you told Nimbus about: today first, then what is coming up. */
  today: CalendarEvent[]
  upcoming: CalendarEvent[]
  /** Departures to an event that starts today or tomorrow somewhere else. */
  commute: TransitCardData | null
  news: NewsCardData | null
  /** Reminders due within the next few hours. */
  reminders: Reminder[]
}

export interface Reminder {
  id: string
  /** When it fires, ISO. */
  at: string
  /** What to say — already phrased as the spoken line. */
  text: string
  /**
   * A "leave now" alarm worked out from a departure, rather than a plain
   * time the user named. Kept so the card can show why it's set when it is.
   */
  departure?: {
    line: string
    departs: string
    from: string
    to: string
    /** Travel time to the stop that was subtracted, in minutes. */
    travelMinutes: number
  }
  fired: boolean
}

export interface ReminderCardData {
  /** The one just created, when this card is confirming a new reminder. */
  created: Reminder | null
  pending: Reminder[]
}

/** Something the user asked Nimbus to remember about them. */
export interface MemoryFact {
  id: string
  text: string
  at: string
}

/** An archived answer, searchable long after the conversation ended. */
export interface RememberedAnswer {
  id: string
  at: string
  question: string
  answer: string
  intent: string
}

export interface MemoryCardData {
  /** What was searched for, or empty when simply listing recent answers. */
  query: string
  answers: RememberedAnswer[]
  facts: MemoryFact[]
}

export type TravelMode = 'driving' | 'cycling' | 'walking' | 'transit'

export interface RouteOption {
  mode: TravelMode
  /** Null for public transport, where a road distance means nothing. */
  distanceKm: number | null
  durationMinutes: number | null
}

/** One map tile, already downloaded, positioned in the map's pixel space. */
export interface MapTile {
  x: number
  y: number
  /** base64 data URI — the overlay's CSP blocks remote image URLs. */
  image: string
}

export interface RenderedMap {
  width: number
  height: number
  tiles: MapTile[]
  /** Route lines as pixel coordinates, keyed by travel mode. */
  routes: Record<string, Array<[number, number]>>
  start: [number, number]
  end: [number, number]
}

export interface DirectionsCardData {
  from: string
  to: string
  selected: TravelMode
  options: RouteOption[]
  /** Real departures, when public transport is an option between these points. */
  transit: TransitCardData | null
  map: RenderedMap
}

export type TextActionKind =
  | 'translate'
  | 'summarize'
  | 'explain'
  | 'rewrite'
  | 'grammar'
  | 'reply'
  | 'custom'

export interface SelectionCardData {
  /** The text that was selected, for reference while reading the result. */
  source: string
  action: TextActionKind
  /** Human-readable label of what was done, e.g. "Fixed grammar". */
  actionLabel: string
  result: string
  /** False when the source window can no longer be targeted for paste-back. */
  canReplace: boolean
}

export interface PaperworkCardData {
  summary: string
  sender: string
  documentType: string
  actionRequired: string
  /** YYYY-MM-DD, or empty when the document sets no deadline. */
  deadline: string
  /** The document's own wording for the deadline, quoted. */
  deadlineLabel: string
  amount: string
  reference: string
  keyPoints: string[]
  /** What was captured, so it's clear what Nimbus read. */
  thumbnail: string
}

export interface ScreenCardData {
  /** Data URI of what was captured, shown so it's clear what Nimbus saw. */
  thumbnail: string
}

export type ResponseCardData =
  | { type: 'weather'; data: WeatherCardData }
  | { type: 'stock'; data: StockCardData }
  | { type: 'crypto'; data: CryptoCardData }
  | { type: 'news'; data: NewsCardData }
  | { type: 'github'; data: GithubCardData }
  | { type: 'search'; data: SearchCardData }
  | { type: 'entity'; data: EntityCardData }
  | { type: 'music'; data: MusicCardData }
  | { type: 'radio'; data: RadioCardData }
  | { type: 'transit'; data: TransitCardData }
  | { type: 'screen'; data: ScreenCardData }
  | { type: 'paperwork'; data: PaperworkCardData }
  | { type: 'selection'; data: SelectionCardData }
  | { type: 'directions'; data: DirectionsCardData }
  | { type: 'memory'; data: MemoryCardData }
  | { type: 'reminder'; data: ReminderCardData }
  | { type: 'briefing'; data: BriefingCardData }
  | { type: 'event'; data: EventCardData }
  | { type: 'explainer'; data: ExplainerCardData }
  | { type: 'text' }

export interface SynthesizedSpeech {
  audio: ArrayBuffer
  mimeType: string
}

export interface NimbusResponse {
  /** What gets read aloud — length-capped so it can't monologue. */
  speech: string
  /**
   * The complete answer when `speech` had to be shortened for TTS. Displaying
   * and copying use this, so asking for something long (an email, a draft
   * message) doesn't silently lose everything past the spoken portion.
   */
  fullText?: string
  card: ResponseCardData
}

export type NimbusState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'playing'

export interface NimbusConfig {
  integrations: {
    weather: boolean
    stocks: boolean
    crypto: boolean
    news: boolean
    github: boolean
    search: boolean
    music: boolean
    transit: boolean
    maps: boolean
  }
  hotkey: {
    enabled: boolean
    accelerator: string
    /** Captures the screen, then listens for a question about it. */
    captureAccelerator: string
    /** Grabs the highlighted text in the focused app and offers actions on it. */
    selectionAccelerator: string
  }
  overlay: {
    autoFadeMs: number
  }
  voice: {
    /** Quiet time before a turn is considered finished. Lower = snappier,
     *  but tolerates shorter mid-sentence pauses. */
    endOfSpeechMs: number
    /** Speech pace for TTS, e.g. "+20%". Edge's default reads slowly. */
    speechRate: string
  }
  screenshot: {
    /** Drag to pick a region instead of grabbing the whole display. */
    selectRegion: boolean
  }
  briefing: {
    /** City for the weather line; defaults to the first part of location.region. */
    weatherCity: string
    /** Headline topic, or empty for the top stories. */
    newsTopic: string
  }
  location: {
    /** Where 'from here' means. A street address is far more precise than
     *  the city-level guess an IP lookup gives. */
    home: string
    /** Your area, e.g. "Darmstadt, Hesse, Germany". Biases place lookups and
     *  tells the model which places you are likely to mean. */
    region: string
    /** The language local place names are in. Answers stay in language.native;
     *  this only affects how place names are spelled and searched. */
    placeLanguage: string
    /** Places you say often. Given to the transcriber as a vocabulary hint,
     *  which is the only form of hint it measurably acts on. */
    frequentPlaces: string[]
  }
  transit: {
    /** Used when you say "trains to Frankfurt" without naming a start. */
    defaultOrigin: string
  }
  language: {
    /**
     * The language you think in. Explanations, summaries and translations
     * arrive in this; replies are drafted in whatever language the original
     * text was written in.
     */
    native: string
  }
}

/** One line of a live translation, produced from a few seconds of audio. */
export interface Subtitle {
  /** What was actually said, in the source language. */
  original: string
  /** The same line in the user's language. */
  translated: string
  /** ISO code of the detected source language, when known. */
  detected: string
  /** Position within the session, so lines can't render out of order. */
  offsetMs: number
}

/** One utterance in a captured meeting. */
export interface MeetingLine {
  /** 'you' is this microphone; 'them' is everyone on the far end. */
  speaker: 'you' | 'them'
  text: string
  /** Milliseconds since capture began, used for ordering and timestamps. */
  offsetMs: number
}

export interface MeetingSummary {
  summary: string
  decisions: string[]
  actions: string[]
  openQuestions: string[]
}

/** Whether the on-device model is present, and how big it is. */
export interface LocalModelStatus {
  installed: boolean
  path: string
  sizeBytes: number
  downloading: boolean
}

export interface LocalModelProgress {
  receivedBytes: number
  totalBytes: number
  done: boolean
  error?: string
}
