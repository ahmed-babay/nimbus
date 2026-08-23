export interface ConversationTurn {
  role: 'user' | 'model'
  text: string
  /** When it was said, so stale turns can be dropped rather than reused. */
  at: number
}

/** Gemini's `Content` wire shape, kept local so callers don't import SDK types. */
export interface GeminiContent {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

// Keep a rolling window rather than the whole session: enough for follow-ups
// ("what about tomorrow?", "who is he?") without growing the prompt forever.
const MAX_TURNS = 12

/**
 * After this long, a turn stops being context and becomes misinformation.
 *
 * Everything Nimbus answers is perishable - departures, prices, weather, what
 * is on now. Asked about trains an hour after the last conversation, it
 * repeated the departure it had given then, because as far as it could tell
 * that was simply what had been established. Ten minutes is roughly the span
 * over which "what about tomorrow?" still refers to something, and well under
 * the life of any answer it gives.
 */
const STALE_AFTER_MS = 10 * 60 * 1000

let history: ConversationTurn[] = []

/** Drops anything too old to be context. Applied on read, not on a timer. */
function fresh(): ConversationTurn[] {
  const cutoff = Date.now() - STALE_AFTER_MS
  const kept = history.filter((turn) => turn.at >= cutoff)
  if (kept.length !== history.length) {
    console.log(`[conversation] dropped ${history.length - kept.length} stale turn(s)`)
    history = kept
  }
  return history
}

export function getHistory(): ConversationTurn[] {
  return fresh()
}

/** History formatted for the Gemini SDK's `contents` array. */
export function getHistoryAsContents(): GeminiContent[] {
  return fresh().map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }))
}

export function recordTurn(role: ConversationTurn['role'], text: string): void {
  if (!text.trim()) return
  // Read first, so a new turn after a long gap starts a clean conversation
  // rather than being appended to an hour-old one.
  fresh()
  history.push({ role, text, at: Date.now() })
  if (history.length > MAX_TURNS) {
    history = history.slice(-MAX_TURNS)
  }
}

/** Called when the overlay closes, so each session starts fresh. */
export function resetConversation(): void {
  history = []
}

/** Compact transcript used to give the intent classifier recent context. */
export function getHistorySummary(maxTurns = 6): string {
  return fresh()
    .slice(-maxTurns)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Nimbus'}: ${clip(turn.text)}`)
    .join('\n')
}

/**
 * How much of one past turn the router is shown.
 *
 * This summary exists so "what about tomorrow?" and "who is he?" resolve, and
 * the subject of a turn is in its first line. The whole of a turn is not: a
 * researched answer runs to thousands of characters, and six of those would be
 * larger than the router prompt they are appended to. Harmless against a cloud
 * model's window, and on-device it is the difference between a prompt that
 * fits and one that does not.
 */
const HISTORY_TURN_CHARS = 240

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= HISTORY_TURN_CHARS ? flat : `${flat.slice(0, HISTORY_TURN_CHARS)}…`
}
