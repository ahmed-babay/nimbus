import { httpFetch } from './http'
import type { EntityCardData } from '../shared/types'

/**
 * What a word actually means, with an example of it in use.
 *
 * This exists because of who Nimbus is for. Living and working in a language
 * that isn't your first one, the gap is rarely translation — you can already
 * get the German word for something. The gap is the English word you half
 * know: whether "concede" is grudging, whether "resilient" fits a person or
 * only a material, which preposition follows it.
 *
 * Translation answers "what is this in my language". This answers "am I using
 * it right", which is the question that actually comes up while writing an
 * email at work.
 *
 * **dictionaryapi.dev** is free, keyless, and returns part of speech,
 * definitions, examples, synonyms and phonetics in one call.
 *
 * Rendered through the existing entity card: a headword, a short label and a
 * body is exactly the shape it already draws.
 */

const BASE_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en'

interface DictionaryDefinition {
  definition?: string
  example?: string
  synonyms?: string[]
}

interface DictionaryMeaning {
  partOfSpeech?: string
  definitions?: DictionaryDefinition[]
  synonyms?: string[]
}

interface DictionaryEntry {
  word?: string
  phonetic?: string
  phonetics?: Array<{ text?: string }>
  meanings?: DictionaryMeaning[]
  sourceUrls?: string[]
}

/** How many senses to show before it stops being an answer and starts being a page. */
const MAX_MEANINGS = 3

export async function defineWord(word: string): Promise<EntityCardData> {
  const term = word.trim().toLowerCase().replace(/[^a-z'-]/g, '')
  if (!term) throw new Error("I didn't catch which word you meant.")

  const res = await httpFetch(`${BASE_URL}/${encodeURIComponent(term)}`, {
    label: 'Dictionary',
    timeoutMs: 8000,
    retries: 1
  })
  // A word it doesn't have returns 404 rather than an empty list, so this is
  // the "no such word" path rather than an outage.
  if (res.status === 404) throw new Error(`I couldn't find a definition for "${word}".`)
  if (!res.ok) throw new Error(`The dictionary lookup failed (${res.status}).`)

  const json = (await res.json()) as DictionaryEntry[]
  const entry = json[0]
  if (!entry?.meanings?.length) {
    throw new Error(`I couldn't find a definition for "${word}".`)
  }

  const phonetic = entry.phonetic || entry.phonetics?.find((sound) => sound.text)?.text || ''

  const parts: string[] = []
  for (const meaning of entry.meanings.slice(0, MAX_MEANINGS)) {
    const first = meaning.definitions?.[0]
    if (!first?.definition) continue

    let block = `${meaning.partOfSpeech ?? ''} — ${first.definition}`.trim()
    // The example is the half that answers "am I using it right", so it is
    // never dropped to save space.
    if (first.example) block += `\n  “${first.example}”`

    const synonyms = (first.synonyms?.length ? first.synonyms : meaning.synonyms) ?? []
    if (synonyms.length) block += `\n  Similar: ${synonyms.slice(0, 5).join(', ')}`

    parts.push(block)
  }

  if (parts.length === 0) throw new Error(`I couldn't find a definition for "${word}".`)

  return {
    title: entry.word || term,
    description: phonetic || null,
    extract: parts.join('\n\n'),
    // No pictures: an illustration of an abstract word is decoration, and the
    // card renders fine without one.
    image: null,
    url: entry.sourceUrls?.[0] ?? `https://en.wiktionary.org/wiki/${encodeURIComponent(term)}`
  }
}

/** The first sense only — the rest is on the card to read. */
export function describeDefinition(data: EntityCardData): string {
  const firstLine = data.extract.split('\n')[0]
  return `${data.title}: ${firstLine.replace(/^\w+\s—\s/, '')}`
}
