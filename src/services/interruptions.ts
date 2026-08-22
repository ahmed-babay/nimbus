import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { silenceReason } from './quiet'
import type { Interruption } from '../shared/types'

/**
 * A record of every time Nimbus spoke first, and a way to make it stop.
 *
 * An assistant that interrupts needs to be accountable for it. Two questions
 * have to be answerable at any moment: *what did you tell me while I was
 * away*, and *how do I make you stop telling me that*. Without the first,
 * anything raised during quiet hours is simply lost. Without the second, the
 * only control anyone has is uninstalling the app.
 *
 * Muting is by source rather than by kind, so silencing one delayed train does
 * not silence every train.
 */

export type { Interruption } from '../shared/types'

interface Store {
  interruptions: Interruption[]
  muted: string[]
}

/** Enough to answer "what did I miss" without becoming an archive. */
const MAX_KEPT = 60

let cache: Store | null = null

function file(): string {
  return join(app.getPath('userData'), 'interruptions.json')
}

function load(): Store {
  if (cache) return cache
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>
      cache = { interruptions: parsed.interruptions ?? [], muted: parsed.muted ?? [] }
      return cache
    }
  } catch {
    // A corrupt log is not worth failing a notification over.
  }
  cache = { interruptions: [], muted: [] }
  return cache
}

function save(): void {
  try {
    writeFileSync(file(), JSON.stringify(load(), null, 2))
  } catch {
    /* best effort */
  }
}

export function isMuted(source: string): boolean {
  return load().muted.includes(source)
}

export function mute(source: string): void {
  const store = load()
  if (!store.muted.includes(source)) {
    store.muted.push(source)
    save()
  }
}

export function unmute(source: string): void {
  const store = load()
  store.muted = store.muted.filter((entry) => entry !== source)
  save()
}

export function recentInterruptions(): Interruption[] {
  return [...load().interruptions].reverse()
}

/** Anything raised while Nimbus was silent, so it can be caught up on. */
export function missedInterruptions(): Interruption[] {
  return recentInterruptions().filter((entry) => entry.heldBecause !== null)
}

export interface InterruptionDecision {
  /** Whether the overlay should actually be shown and spoken. */
  deliver: boolean
  entry: Interruption
}

/**
 * Decides whether something unprompted may reach the user, and records it
 * either way.
 *
 * Muted sources are dropped outright — the user has said they do not want
 * this. Quiet hours only hold it back, because "not now" is not "never" and
 * a reminder that never arrives is worse than a late one.
 */
export function considerInterruption(
  source: string,
  kind: Interruption['kind'],
  text: string
): InterruptionDecision {
  const store = load()
  const held = isMuted(source) ? 'muted' : silenceReason()

  const entry: Interruption = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    kind,
    text,
    at: new Date().toISOString(),
    heldBecause: held
  }

  // A muted source is not worth remembering; the user asked not to hear it.
  if (held !== 'muted') {
    store.interruptions.push(entry)
    if (store.interruptions.length > MAX_KEPT) {
      store.interruptions = store.interruptions.slice(-MAX_KEPT)
    }
    save()
  }

  if (held) console.log(`[interrupt] held "${text.slice(0, 60)}" (${held})`)
  return { deliver: held === null, entry }
}

/** Marks everything held as seen, once the user has caught up. */
export function clearHeld(): void {
  const store = load()
  store.interruptions = store.interruptions.map((entry) =>
    entry.heldBecause ? { ...entry, heldBecause: null } : entry
  )
  save()
}
