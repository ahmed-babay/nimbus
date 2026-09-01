import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryFact, RememberedAnswer } from '../shared/types'

/**
 * What Nimbus keeps between sessions.
 *
 * `src/services/conversation.ts` holds the last dozen turns in memory so
 * follow-ups resolve, and throws them away when the overlay closes. That is
 * the right lifetime for "what about tomorrow?" and the wrong one for
 * everything else: until this existed, closing the app meant every answer it
 * had ever given was gone, and it re-learned who you were on every launch.
 *
 * Two separate things live here, because they behave differently:
 *
 * - **Answers** are an append-only archive. Searchable, never injected into a
 *   prompt wholesale — there could be thousands.
 * - **Facts** are a short list you asked it to remember. Small enough to put
 *   in front of the model on every single turn, which is the entire point.
 */

/** Facts are prompt payload on every turn, so this stays small deliberately. */
const MAX_FACTS = 40
/** Roughly a year of heavy use before the oldest answers roll off. */
const MAX_ANSWERS = 2000

interface MemoryFile {
  version: 1
  facts: MemoryFact[]
  answers: RememberedAnswer[]
}

const EMPTY: MemoryFile = { version: 1, facts: [], answers: [] }

let cache: MemoryFile | null = null
let storePath: string | null = null

function path(): string {
  if (!storePath) {
    // userData rather than next to the app: survives reinstalls, and is the
    // directory Electron already guarantees is writable.
    storePath = join(app.getPath('userData'), 'memory.json')
  }
  return storePath
}

function load(): MemoryFile {
  if (cache) return cache
  try {
    if (!existsSync(path())) {
      cache = { ...EMPTY }
      return cache
    }
    const parsed = JSON.parse(readFileSync(path(), 'utf8')) as Partial<MemoryFile>
    cache = {
      version: 1,
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      answers: Array.isArray(parsed.answers) ? parsed.answers : []
    }
  } catch (err) {
    // A corrupt store must not stop the app from answering. Start clean and
    // say so, rather than crashing on every launch from then on.
    console.error('[memory] could not read store, starting empty:', err)
    cache = { ...EMPTY }
  }
  return cache
}

function save(): void {
  if (!cache) return
  try {
    // Write-then-rename: a crash mid-write leaves the previous store intact
    // instead of a half-written file that fails to parse forever after.
    const temp = `${path()}.tmp`
    writeFileSync(temp, JSON.stringify(cache), 'utf8')
    renameSync(temp, path())
  } catch (err) {
    console.error('[memory] could not write store:', err)
  }
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Facts — the small, prompt-sized profile
// ---------------------------------------------------------------------------

export function getFacts(): MemoryFact[] {
  return load().facts
}

export function rememberFact(text: string): MemoryFact | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const store = load()
  // Saying the same thing twice shouldn't grow the prompt. Replace rather
  // than skip, so a restated fact refreshes its timestamp.
  const normalized = trimmed.toLowerCase()
  store.facts = store.facts.filter((fact) => fact.text.toLowerCase() !== normalized)

  const fact: MemoryFact = { id: id(), text: trimmed, at: new Date().toISOString() }
  store.facts.push(fact)
  if (store.facts.length > MAX_FACTS) {
    store.facts = store.facts.slice(-MAX_FACTS)
  }
  save()
  return fact
}

/** Drops facts matching a phrase. Returns what was removed, for confirmation. */
export function forgetFacts(phrase: string): MemoryFact[] {
  const needle = phrase.trim().toLowerCase()
  if (!needle) return []

  const store = load()
  const removed = store.facts.filter((fact) => fact.text.toLowerCase().includes(needle))
  if (removed.length === 0) return []

  store.facts = store.facts.filter((fact) => !removed.includes(fact))
  save()
  return removed
}

/** The profile block handed to the model. Empty string when nothing is known. */
export function factsContext(): string {
  const facts = getFacts()
  if (facts.length === 0) return ''
  return (
    'Private background facts the user told you directly. Use one only when it ' +
    'materially improves the answer to the current request. Never announce, ' +
    'list, or repeat a fact merely to personalize a greeting or unrelated answer, ' +
    'and never contradict it:\n' +
    facts.map((fact) => `- ${fact.text}`).join('\n')
  )
}

// ---------------------------------------------------------------------------
// Answers — the searchable archive
// ---------------------------------------------------------------------------

export function recordAnswer(question: string, answer: string, intent: string): void {
  if (!question.trim() || !answer.trim()) return

  const store = load()
  store.answers.push({
    id: id(),
    at: new Date().toISOString(),
    question: question.trim(),
    answer: answer.trim(),
    intent
  })
  if (store.answers.length > MAX_ANSWERS) {
    store.answers = store.answers.slice(-MAX_ANSWERS)
  }
  save()
}

/** Words too common to tell two answers apart. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'from', 'by', 'that',
  'this', 'it', 'as', 'what', 'when', 'where', 'who', 'how', 'why', 'did', 'do',
  'does', 'you', 'me', 'my', 'i', 'we', 'us', 'said', 'say', 'told', 'tell'
])

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
}

/**
 * Keyword search over the archive, newest-first among equal scores.
 *
 * Deliberately not embeddings: that would mean either a paid API on every
 * write or a local model, and for "what was that station you mentioned" the
 * words the user says are very nearly the words they said the first time.
 */
export function searchAnswers(query: string, limit = 5): RememberedAnswer[] {
  const wanted = terms(query)
  if (wanted.length === 0) return []

  const store = load()
  return store.answers
    .map((entry) => {
      const haystack = `${entry.question} ${entry.answer}`.toLowerCase()
      // The question carries the topic more reliably than the answer, which
      // is why a hit there counts double.
      const questionText = entry.question.toLowerCase()
      let score = 0
      for (const word of wanted) {
        if (!haystack.includes(word)) continue
        score += questionText.includes(word) ? 2 : 1
      }
      return { entry, score }
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.at.localeCompare(a.entry.at))
    .slice(0, limit)
    .map((hit) => hit.entry)
}

/** Most recent answers, for "what did we talk about" with no search terms. */
export function recentAnswers(limit = 5): RememberedAnswer[] {
  return load().answers.slice(-limit).reverse()
}
