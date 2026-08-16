import { complete } from './llm'
import { transcribeAudio } from './whisper'
import config from '../../config.json'
import type { MeetingLine, MeetingSummary } from '../shared/types'

/**
 * Meeting capture.
 *
 * Nimbus listens to a call for as long as it runs and says nothing at all —
 * no wake word, no answers, no chime. It is a notetaker here, not a
 * participant, and a voice assistant that joins in during a meeting would be
 * a liability rather than a feature.
 *
 * Speaker attribution is the interesting part. Real diarisation — working out
 * how many people spoke and which is which from a single mixed track — is not
 * something the free tier offers. But a call already arrives as two physically
 * separate signals: your microphone is you, and the system's audio output is
 * everyone else. Recording them as two streams gives a clean "you" / "them"
 * split for free, which is most of the value of a dialogue transcript and
 * needs no model at all.
 *
 * The limitation that follows is worth being clear about: everyone on the
 * far end is a single speaker called "them". Splitting three colleagues out
 * of one mixed stream is not possible here, and guessing would produce a
 * transcript that is confidently wrong about who said what.
 */

const native = config.language?.native || 'English'

/** Roughly a two-hour meeting at normal speaking density. */
const MAX_LINES = 3000

export function speakerFor(source: 'system' | 'microphone'): MeetingLine['speaker'] {
  return source === 'microphone' ? 'you' : 'them'
}

/**
 * Transcribes one captured piece. Returns null for silence — a meeting is
 * mostly one side listening, so most pieces from any given stream are empty.
 */
export async function transcribePiece(
  audio: Buffer,
  mimeType: string,
  previous: string
): Promise<string | null> {
  const text = await transcribeAudio(audio, mimeType, { contextPrompt: previous.slice(-220) })
  const bare = text.replace(/[.,!?…\-[\]()*]/g, '').trim()
  if (!bare) return null
  return text.trim()
}

function clockFor(offsetMs: number): string {
  const total = Math.max(0, Math.round(offsetMs / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

/**
 * The exported file. Plain text on purpose: it has to open anywhere, paste
 * into anything, and still be readable in five years.
 */
export function formatTranscript(lines: MeetingLine[], startedAt: number): string {
  const when = new Date(startedAt)
  const header = [
    `Meeting transcript — ${when.toLocaleString()}`,
    `Captured by Nimbus. "You" is this microphone; "Them" is everyone on the call.`,
    ''
  ]

  const body = lines
    .slice()
    .sort((a, b) => a.offsetMs - b.offsetMs)
    .map((line) => `[${clockFor(line.offsetMs)}] ${line.speaker === 'you' ? 'You' : 'Them'}: ${line.text}`)

  return [...header, ...body, ''].join('\n')
}

/** Kept well inside a request limit while still covering a long meeting. */
const MAX_SUMMARY_CHARS = 24000

const SUMMARY_PROMPT = `You are summarising a meeting transcript for someone who was in the room
and needs to remember what actually came out of it.

Write in ${native}, whatever language the meeting was held in.

- summary: three to five sentences on what the meeting was about and where it landed.
  Lead with the outcome, not the agenda.
- decisions: things that were actually settled. Not topics discussed — conclusions reached.
  Empty if nothing was genuinely decided.
- actions: what someone now has to do. Start each with who is responsible, using "You" for
  the person whose microphone this was and the name used in the meeting for anyone else, or
  "Them" if no name was given. Include a deadline when one was said.
- openQuestions: things raised and deliberately left unresolved, or that need an answer
  before anything can move.

Take only what is in the transcript. A meeting that decided nothing should come back with
an empty decisions list — inventing an outcome is far worse than reporting that there
wasn't one. Speech-to-text makes mistakes: where a word is obviously garbled, read through
it, but never invent facts, numbers or names that aren't there.`

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    decisions: { type: 'ARRAY', items: { type: 'STRING' } },
    actions: { type: 'ARRAY', items: { type: 'STRING' } },
    openQuestions: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['summary']
}

export async function summarizeMeeting(
  lines: MeetingLine[],
  startedAt: number
): Promise<MeetingSummary> {
  if (lines.length === 0) {
    throw new Error('There is nothing recorded to summarise yet.')
  }

  const transcript = formatTranscript(lines, startedAt)
  // Keeps the end of a long meeting, where decisions and next steps live.
  const trimmed =
    transcript.length > MAX_SUMMARY_CHARS ? transcript.slice(-MAX_SUMMARY_CHARS) : transcript

  const text = await complete({
    system: SUMMARY_PROMPT,
    messages: [{ role: 'user', text: trimmed }],
    jsonSchema: SUMMARY_SCHEMA,
    temperature: 0
  })

  const parsed = JSON.parse(stripFences(text)) as Record<string, unknown>
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : []

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    decisions: list(parsed.decisions),
    actions: list(parsed.actions),
    openQuestions: list(parsed.openQuestions)
  }
}

export function clampLines(lines: MeetingLine[]): MeetingLine[] {
  return lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}
