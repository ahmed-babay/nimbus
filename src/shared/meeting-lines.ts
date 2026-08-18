import type { MeetingLine } from './types'

/**
 * Cleaning up a two-stream meeting transcript.
 *
 * Capture gives two signals — this microphone is "you", the computer's own
 * output is "them" — and that split is what makes the transcript a dialogue.
 * It also produces two failures that show up as one mess on the page.
 *
 * **The far end comes back through the microphone.** Their voice leaves the
 * speakers, crosses the room and arrives at the mic, so the same sentence is
 * captured on both streams. It is then transcribed twice and attributed to
 * "you" the second time. This is why someone else talking shows up as you
 * talking, and why lines appear twice. Echo cancellation is asked for below,
 * but Chromium's canceller only reliably knows about audio *it* is playing —
 * a meeting running in Teams or Zoom is another process, and its output is not
 * in the reference signal.
 *
 * **Pieces overlap by design.** Each recorder starts before the previous one
 * stops, because cutting strictly back to back swallowed whole words at the
 * boundary. The cost is that the audio in the overlap is transcribed twice,
 * so consecutive lines from one speaker repeat a few words across the join.
 *
 * Both are fixed here rather than at the microphone, because both are only
 * detectable once you can see the text.
 *
 * Deliberately conservative in one direction: dropping something that was
 * really said is much worse than leaving a duplicate. Every rule below
 * therefore needs real evidence before it removes anything.
 */

/** Words, lowercased, stripped of punctuation — for comparison only. */
function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * How much two utterances share, 0..1, against the shorter one.
 *
 * Measured against the shorter rather than the union on purpose: the echoed
 * copy is usually a clipped or partly-misheard version of the original, so
 * comparing to the union would score a genuine echo far too low.
 */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const counts = new Map<string, number>()
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1)

  let shared = 0
  for (const word of b) {
    const left = counts.get(word) ?? 0
    if (left > 0) {
      shared++
      counts.set(word, left - 1)
    }
  }
  return shared / Math.min(a.length, b.length)
}

/**
 * How far apart two lines can start and still be the same speech.
 *
 * Generous because the two streams are cut independently: a sentence can land
 * mid-piece on one side and at the start of a piece on the other, and pieces
 * run up to seven seconds.
 */
const ECHO_WINDOW_MS = 8000

/** Below this, two utterances are the same thing said once. */
const ECHO_SIMILARITY = 0.7

/**
 * Short replies are never treated as echoes.
 *
 * "Yes", "okay", "genau" get said by both people constantly and legitimately.
 * Removing a real one costs more than leaving a duplicate, so anything this
 * short is left alone.
 */
const MIN_ECHO_WORDS = 4

/** Longest repeat to strip across a piece boundary. */
const MAX_JOIN_REPEAT = 14

/**
 * Removes the microphone's copy of what the far end said.
 *
 * Only ever drops a "you" line, and only when a "them" line nearby says
 * substantially the same thing. The reverse never happens: a conferencing app
 * does not play your own voice back to you, so a "them" line is always the
 * authoritative copy.
 */
function removeEcho(lines: MeetingLine[]): MeetingLine[] {
  const theirs = lines.filter((line) => line.speaker === 'them')
  if (theirs.length === 0) return lines

  const theirWords = theirs.map((line) => normalize(line.text))

  return lines.filter((line) => {
    if (line.speaker !== 'you') return true
    const words = normalize(line.text)
    if (words.length < MIN_ECHO_WORDS) return true

    return !theirs.some((other, index) => {
      if (Math.abs(other.offsetMs - line.offsetMs) > ECHO_WINDOW_MS) return false
      return similarity(theirWords[index], words) >= ECHO_SIMILARITY
    })
  })
}

/**
 * Strips the words a piece repeats from the end of the one before it.
 *
 * Compares normalized words but cuts the original text, so punctuation and
 * capitalisation survive. Longest overlap wins — a short accidental match is
 * far more likely than a long one.
 */
function trimJoins(lines: MeetingLine[]): MeetingLine[] {
  const out: MeetingLine[] = []

  for (const line of lines) {
    const previous = out[out.length - 1]
    if (!previous || previous.speaker !== line.speaker) {
      out.push(line)
      continue
    }

    const before = normalize(previous.text)
    const current = normalize(line.text)
    const limit = Math.min(MAX_JOIN_REPEAT, before.length, current.length)

    let repeat = 0
    for (let size = limit; size >= 2; size--) {
      const tail = before.slice(before.length - size).join(' ')
      const head = current.slice(0, size).join(' ')
      if (tail === head) {
        repeat = size
        break
      }
    }

    if (repeat === 0) {
      out.push(line)
      continue
    }

    // Walk the original text past `repeat` words to find where to cut, so the
    // remainder keeps its original spelling rather than the normalized form.
    const words = line.text.split(/\s+/)
    const kept = words.slice(repeat).join(' ').trim()
    // Nothing left means this piece was entirely overlap.
    if (kept) out.push({ ...line, text: kept })
  }

  return out
}

/**
 * The transcript as it should actually read.
 *
 * Ordered by when things were said, with the microphone's echo of the far end
 * removed and the overlap between consecutive pieces trimmed.
 */
export function cleanMeetingLines(lines: MeetingLine[]): MeetingLine[] {
  const ordered = lines.slice().sort((a, b) => a.offsetMs - b.offsetMs)
  return trimJoins(removeEcho(ordered))
}
