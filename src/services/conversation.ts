export interface ConversationTurn {
  role: 'user' | 'model'
  text: string
}

/** Gemini's `Content` wire shape, kept local so callers don't import SDK types. */
export interface GeminiContent {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

// Keep a rolling window rather than the whole session: enough for follow-ups
// ("what about tomorrow?", "who is he?") without growing the prompt forever.
const MAX_TURNS = 12

let history: ConversationTurn[] = []

export function getHistory(): ConversationTurn[] {
  return history
}

/** History formatted for the Gemini SDK's `contents` array. */
export function getHistoryAsContents(): GeminiContent[] {
  return history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }))
}

export function recordTurn(role: ConversationTurn['role'], text: string): void {
  if (!text.trim()) return
  history.push({ role, text })
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
  return history
    .slice(-maxTurns)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Nimbus'}: ${turn.text}`)
    .join('\n')
}
