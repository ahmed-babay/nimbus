import { GoogleGenerativeAI, type GenerationConfig, type GenerativeModel } from '@google/generative-ai'

/**
 * Shared Gemini access with a model fallback.
 *
 * Free-tier capacity moves around: measured on the same key minutes apart,
 * `gemini-flash-latest` answered in ~1-3s while `gemini-flash-lite-latest`
 * took 21-27s for the identical prompt — and the fast one intermittently
 * returns 503 "high demand". So the fast model is primary, and anything that
 * looks like congestion falls back to the slower-but-available one rather
 * than failing or hanging the turn.
 */
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-latest'

/**
 * How long to wait on the primary before *also* trying the fallback.
 *
 * Falling back only on errors isn't enough: free-tier congestion shows up as
 * a request that succeeds but takes 20-30 seconds, which is indistinguishable
 * from broken to anyone waiting. After this the fallback is raced alongside,
 * and whichever answers first wins — so a slow primary costs a few seconds,
 * not the whole turn.
 */
const PRIMARY_SOFT_TIMEOUT_MS = Number(process.env.GEMINI_SOFT_TIMEOUT_MS || 6000)

let client: GoogleGenerativeAI | null = null

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.')
    client = new GoogleGenerativeAI(apiKey)
  }
  return client
}

export function buildModel(
  modelName: string,
  systemInstruction?: string,
  generationConfig?: GenerationConfig
): GenerativeModel {
  return getClient().getGenerativeModel({ model: modelName, systemInstruction, generationConfig })
}

/** Congestion or transport trouble — worth trying the other model. */
function isOverloaded(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('503') ||
    message.includes('429') ||
    message.includes('overloaded') ||
    message.includes('high demand') ||
    message.includes('fetch failed') ||
    message.includes('Timeout')
  )
}

/**
 * Runs `work` against the primary model, retrying on the fallback if the
 * primary is congested. `work` receives the model name so callers can build
 * whatever configuration they need (schemas, system prompts, streaming).
 */
const FAILED = Symbol('failed')
const SLOW = Symbol('slow')

export async function withModelFallback<T>(work: (modelName: string) => Promise<T>): Promise<T> {
  const started = Date.now()
  let primaryError: unknown = null

  // Resolves to FAILED rather than rejecting, so a dead primary ends the race
  // immediately instead of either winning it or hanging until the timeout.
  const primary = work(PRIMARY_MODEL).catch((error): T | typeof FAILED => {
    primaryError = error
    return FAILED
  })

  const first = await Promise.race([
    primary,
    new Promise<typeof SLOW>((resolve) => setTimeout(() => resolve(SLOW), PRIMARY_SOFT_TIMEOUT_MS))
  ])

  if (first !== SLOW && first !== FAILED) return first

  // A genuine error (bad request, missing key) won't be fixed by another
  // model — only congestion is worth a second attempt.
  if (first === FAILED && primaryError && !isOverloaded(primaryError)) throw primaryError

  console.warn(
    `[gemini] ${PRIMARY_MODEL} ${first === FAILED ? 'failed' : 'slow'} after ${Date.now() - started}ms; using ${FALLBACK_MODEL}`
  )

  const fallback = work(FALLBACK_MODEL)

  // Primary already dead — nothing left to race against.
  if (first === FAILED) return fallback.catch((error) => { throw primaryError ?? error })

  // Both still in flight. `Promise.any`, not `Promise.race`: race rejects the
  // moment *either* entry rejects, so a fallback that came back 503 "high
  // demand" ended the turn while the primary was still working and about to
  // answer. That is the whole reason a slow question — directions, departures —
  // could fail while quick ones never did: only the slow ones ever reached the
  // fallback, and then the loser took the winner down with it.
  //
  // `any` waits for the first *success* and only gives up if both fail.
  const primaryOutcome = primary.then((value) => {
    if (value === FAILED) throw primaryError ?? new Error(`${PRIMARY_MODEL} failed.`)
    return value
  })

  return Promise.any([primaryOutcome, fallback]).catch((error: unknown) => {
    // Both models failed; report the first real cause rather than the wrapper.
    if (error instanceof AggregateError) throw error.errors[0] ?? error
    throw error
  })
}
