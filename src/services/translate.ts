import { httpFetch } from './http'
import config from '../../config.json'

/**
 * Fast, free text translation.
 *
 * Built for subtitles, which sets the whole design: this runs once every few
 * seconds while a film plays, so it has to be quick, it has to cost nothing,
 * and it must never block the pipeline behind it. A late subtitle is worse
 * than no subtitle.
 *
 * Whisper is deliberately not asked to do this. Groq's `/audio/translations`
 * endpoint returns the *source* language unchanged for German audio — verified
 * against real speech, with an English prompt and at temperature 0 — and
 * `whisper-large-v3-turbo` rejects that endpoint outright. So translation is a
 * separate hop.
 *
 * It is not the answer model either. At three-second chunks that would be
 * ~20 calls a minute, which alone exceeds the Gemini free tier's request
 * budget and would starve every other feature in the app. These endpoints
 * measure ~200ms against the model's ~1s, and cost no quota at all.
 */

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single'
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get'

/**
 * Subtitles are worthless once the scene has moved on, so a slow provider is
 * treated as a failed one.
 */
const TIMEOUT_MS = 4000

export interface Translation {
  text: string
  /** ISO code Google detected, or '' when the fallback provider was used. */
  detected: string
  /** True when the source was already in the target language and left alone. */
  passthrough: boolean
}

/** Enough of the common cases to turn a configured language name into a code. */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  polish: 'pl',
  turkish: 'tr',
  arabic: 'ar',
  russian: 'ru',
  chinese: 'zh-CN',
  japanese: 'ja',
  korean: 'ko',
  hindi: 'hi'
}

export function targetLanguage(): string {
  const native = (config.language?.native || 'English').toLowerCase().trim()
  return LANGUAGE_CODES[native] || 'en'
}

/**
 * Google's unauthenticated translate endpoint — the one browser translate
 * extensions use. No key, no signup, auto-detects the source language, and
 * measured at 140–490ms warm across German, Chinese, Japanese and Arabic.
 *
 * It is undocumented, so it is treated as something that may vanish: a failure
 * here falls through to MyMemory rather than surfacing an error.
 */
async function translateViaGoogle(text: string, target: string): Promise<Translation> {
  const query = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: target,
    dt: 't',
    q: text
  })

  const res = await httpFetch(`${GOOGLE_URL}?${query}`, {
    label: 'Translate',
    timeoutMs: TIMEOUT_MS,
    retries: 0
  })
  if (!res.ok) throw new Error(`translate ${res.status}`)

  // Shape: [[[translated, original, ...], ...], null, detectedLanguage, ...]
  const body = (await res.json()) as [Array<[string, string]>, unknown, string]
  const segments = Array.isArray(body[0]) ? body[0] : []
  const translated = segments
    .map((segment) => (Array.isArray(segment) ? segment[0] : ''))
    .filter(Boolean)
    .join('')
    .trim()

  if (!translated) throw new Error('translate returned nothing')

  const detected = typeof body[2] === 'string' ? body[2] : ''
  return { text: translated, detected, passthrough: false }
}

/**
 * Fallback provider. Slower (~950ms) and without language detection, so it
 * needs to be told the source language — which by the time we get here we
 * only know if Google already told us on an earlier chunk.
 */
async function translateViaMyMemory(
  text: string,
  target: string,
  source: string
): Promise<Translation> {
  const query = new URLSearchParams({
    q: text,
    langpair: `${source || 'autodetect'}|${target}`
  })

  const res = await httpFetch(`${MYMEMORY_URL}?${query}`, {
    label: 'Translate fallback',
    timeoutMs: TIMEOUT_MS,
    retries: 0,
    headers: { 'User-Agent': 'Nimbus personal assistant' }
  })
  if (!res.ok) throw new Error(`mymemory ${res.status}`)

  const body = (await res.json()) as { responseData?: { translatedText?: string } }
  const translated = (body.responseData?.translatedText ?? '').trim()
  if (!translated) throw new Error('mymemory returned nothing')

  return { text: translated, detected: source, passthrough: false }
}

/**
 * Translate into the configured language, falling back between providers.
 *
 * `sourceHint` carries the language detected on a previous chunk. It exists
 * only for the fallback path, which cannot detect one itself — within a single
 * film the language doesn't change, so the first successful detection is a
 * reliable hint for every chunk after it.
 */
export async function translate(text: string, sourceHint = ''): Promise<Translation> {
  const trimmed = text.trim()
  const target = targetLanguage()

  if (!trimmed) return { text: '', detected: '', passthrough: true }

  try {
    const result = await translateViaGoogle(trimmed, target)
    // Google returns the input untouched when it is already in the target
    // language. Marking that rather than hiding it lets the caller drop the
    // subtitle instead of showing the audio back to someone who understood it.
    if (sameLanguage(result.detected, target)) {
      return { ...result, text: trimmed, passthrough: true }
    }
    return result
  } catch (error) {
    console.warn(`[translate] primary failed (${describe(error)}), trying fallback`)
  }

  return translateViaMyMemory(trimmed, target, sourceHint)
}

/** 'en' and 'en-GB' are the same language for this purpose. */
function sameLanguage(a: string, b: string): boolean {
  if (!a || !b) return false
  return a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
