import config from '../../config.json'

/**
 * Where the user is, and what language the places around them are named in.
 *
 * This exists because speech recognition mangles local place names badly when
 * the surrounding sentence is English. Measured against real audio: "How far
 * is Luisenplatz" came back as "Lusenplatz", and "Mathildenhöhe" as
 * "Mephilden hole". Nothing downstream can geocode those, so the region is
 * given to every stage that could repair them — the transcriber, to bias its
 * spelling, and the intent router, to correct what still comes through wrong.
 */

export function homeRegion(): string {
  return config.location?.region || ''
}

export function placeLanguage(): string {
  return config.location?.placeLanguage || ''
}

/**
 * Keeps replies in the user's own language. Worth stating outright: once the
 * data coming back is full of German station and street names, an unprompted
 * model will happily answer in German too.
 */
export function replyLanguageContext(): string {
  const native = config.language?.native
  if (!native) return ''
  return (
    `Answer in ${native}. Keep place names, station names and street names in ` +
    `their real local spelling rather than translating them.`
  )
}

/**
 * Vocabulary hint for the transcriber.
 *
 * Whisper's prompt biases *vocabulary*, not behaviour, and the difference is
 * measurable: describing the region ("the speaker is in Darmstadt, Hesse")
 * changed nothing at all, while naming actual places turned "Lusenplatz" into
 * "Luisenplatz" and "Mephilden hole" into "Mathildenhole". So this lists the
 * places the user actually says. It's a partial measure even then — the
 * reliable correction happens in the intent router, which reads the mangled
 * transcript and writes the real name.
 */
export function transcriptionHint(): string {
  const region = homeRegion()
  const language = placeLanguage()
  const places = (config.location?.frequentPlaces ?? []).filter(Boolean)
  const named = places.length > 0 ? places : [config.location?.home].filter(Boolean)
  if (!region || named.length === 0) return ''

  return `${language ? `${language} p` : 'P'}lace names near ${region}: ${named.join(', ')}.`
}

/**
 * Instruction for the intent router. Place names are asked for in their real
 * local spelling because that is what the geocoders index — the answer itself
 * stays in the user's own language, which is handled separately.
 */
export function placeContext(): string {
  const region = homeRegion()
  if (!region) return ''
  const language = placeLanguage() || 'the local language'

  return (
    `The user is in ${region}, and the places they mention are usually nearby. ` +
    `Their words reach you through speech recognition, which mishears local ` +
    `place names — "Lusenplatz" for "Luisenplatz", "Mephilden hole" for ` +
    `"Mathildenhöhe", "Herngarten" for "Herrngarten". Whenever you fill in a ` +
    `place (city, from, to), write the real ${language} name, correctly spelled ` +
    `with its proper accents, rather than repeating what the transcript said. ` +
    `If it sounds like a local place, assume it is one. ` +
    `Also turn vague references into the actual place they mean near the user — ` +
    `"the airport", "the main station", "the old town", "downtown" — because a ` +
    `map search takes them literally and finds the wrong country's airport. ` +
    `This applies to place names only — everything else you produce stays in English.`
  )
}
