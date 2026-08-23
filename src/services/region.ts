import config from '../../config.json'
import { describeFix, deviceLocation } from './device-location'

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

/**
 * Set from the device's own position when Windows will say where it is.
 *
 * Kept as a plain value rather than looked up on demand because everything
 * that wants it - the transcriber's spelling bias, the intent router's place
 * correction - is synchronous and runs on the critical path of answering. It
 * is refreshed in the background instead.
 */
let livePlace = ''

export function homeRegion(): string {
  // The device before config.json: that file ships inside the installer, so
  // trusting it first means every copy of Nimbus believes it is wherever the
  // person who built it happened to be.
  return livePlace || config.location?.region || ''
}

/**
 * Asks the machine where it is and remembers the answer.
 *
 * Never throws and never blocks anything: no fix simply leaves the configured
 * region in place, which is exactly the old behaviour.
 */
export async function refreshPlace(): Promise<string> {
  try {
    const fix = await deviceLocation()
    if (!fix) return livePlace
    const name = await describeFix(fix)
    if (name) {
      if (name !== livePlace) console.log(`[location] you appear to be in ${name}`)
      livePlace = name
    }
  } catch {
    // Location is a nicety here; the configured region still works.
  }
  return livePlace
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
/**
 * Words Whisper otherwise guesses at.
 *
 * Genre names are short, rare in ordinary speech and sit next to far more
 * common words, which is exactly the shape of thing a speech model gets wrong:
 * "lofi" came back as "Luffy", the One Piece character, because that is a
 * vastly more frequent string in its training data. Whisper takes its prompt
 * as preceding text, so listing the words makes them likely rather than
 * exotic. Cheap enough to send on every transcription.
 */
const MUSIC_VOCABULARY =
  'lofi, lo-fi hip hop, synthwave, drum and bass, dubstep, techno, house, trance, ' +
  'ambient, chillhop, jazz, bossa nova, reggaeton, afrobeats, K-pop, indie rock, ' +
  'classical, opera, metal, punk, R&B, soul, funk, disco, radio.'

export function transcriptionHint(): string {
  const region = homeRegion()
  const language = placeLanguage()
  const places = (config.location?.frequentPlaces ?? []).filter(Boolean)
  const named = places.length > 0 ? places : [config.location?.home].filter(Boolean)

  const parts: string[] = []
  if (region && named.length > 0) {
    parts.push(`${language ? `${language} p` : 'P'}lace names near ${region}: ${named.join(', ')}.`)
  }
  // Sent whatever the region, because music is asked for everywhere and this
  // used to return nothing at all when no places were configured.
  parts.push(`Music genres: ${MUSIC_VOCABULARY}`)

  return parts.join(' ')
}

/**
 * Instruction for the intent router. Place names are asked for in their real
 * local spelling because that is what the geocoders index — the answer itself
 * stays in the user's own language, which is handled separately.
 */
export function placeContext(): string {
  const region = homeRegion()
  // Saying nothing is not the same as saying "unknown", and the difference is
  // a model that makes something up. Asked for trains in the first seconds
  // after a restart — before the location fix has come back — one answered
  // "You're in Berlin, and it's 16:31 local time", having been given the time
  // and nothing at all about the place. An empty prompt is a hole, and a
  // language model fills holes with whatever is plausible.
  if (!region) {
    return (
      'You do not know where the user is yet — the location has not come back. ' +
      'Never state or guess where they are, and never fill in a starting place ' +
      'from anything except what they actually said. If where they are matters ' +
      'to the answer, say you are still working it out.'
    )
  }
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
