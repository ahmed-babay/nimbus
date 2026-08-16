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
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest'
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest'

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
export async function withModelFallback<T>(work: (modelName: string) => Promise<T>): Promise<T> {
  try {
    return await work(PRIMARY_MODEL)
  } catch (error) {
    if (!isOverloaded(error)) throw error
    console.warn(
      `[gemini] ${PRIMARY_MODEL} unavailable (${error instanceof Error ? error.message.slice(0, 60) : error}); trying ${FALLBACK_MODEL}`
    )
    return work(FALLBACK_MODEL)
  }
}
