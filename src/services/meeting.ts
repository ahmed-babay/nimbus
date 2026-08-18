import { complete } from './llm'
import { transcribeAudio } from './whisper'
import { buildDocx, buildPptx, type Slide } from './office'
import config from '../../config.json'
import type { MeetingExportFormat, MeetingLine, MeetingSummary } from '../shared/types'

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
  pcm: Float32Array,
  previous: string,
  /** ISO code, or empty to let Whisper guess. */
  language?: string
): Promise<string | null> {
  // Told which language to expect, because a meeting arrives as a stream of
  // short pieces and short audio is exactly where Whisper's own detection
  // fails — a few seconds of German comes back as broken English, and it makes
  // that decision independently for every piece, so a German meeting ends up
  // transcribed into a mixture of both.
  const text = await transcribeAudio(pcm, {
    contextPrompt: previous.slice(-220),
    ...(language ? { language } : {})
  })
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
- actions: what someone now has to do. Anything a person committed to is an action, including
  the ones said in passing — "I'll chase Martin today" and "I'll send that round on Thursday"
  both belong here. Start each with who is responsible: "You" for the person whose microphone
  this was, the name used in the meeting for anyone else, or "Them" if no name was given.
  Include a deadline when one was said.
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
  // All four are required so the model has to consider each one. With only
  // `summary` required it silently omitted the actions list on a transcript
  // that plainly contained three of them, and mentioned one in the prose
  // instead. An empty array is a fine answer; a missing one hides work.
  required: ['summary', 'decisions', 'actions', 'openQuestions']
}

/**
 * Splits a long transcript on line boundaries.
 *
 * Never mid-sentence: a chunk that starts halfway through someone committing
 * to something loses the commitment, and those are the lines that matter most.
 */
function chunkTranscript(transcript: string, size: number): string[] {
  if (transcript.length <= size) return [transcript]

  const chunks: string[] = []
  let current = ''
  for (const line of transcript.split('\n')) {
    if (current.length + line.length + 1 > size && current) {
      chunks.push(current)
      current = ''
    }
    current += `${line}\n`
  }
  if (current.trim()) chunks.push(current)
  return chunks
}

const PASS_PROMPT = `You are taking notes on one section of a longer meeting transcript.

Write in ${native}.

Pull out, from this section only: what was discussed and where it got to, anything
that was actually decided, anything a person committed to doing (with who and by when
if said), and anything raised but left unresolved.

Be specific and keep names, numbers and dates exactly as they appear. This will be
combined with notes from the other sections, so do not write an introduction or a
conclusion — just the substance. If this section contains nothing of consequence,
say so in one line.`

function parseSummary(text: string): MeetingSummary {
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

export async function summarizeMeeting(
  lines: MeetingLine[],
  startedAt: number
): Promise<MeetingSummary> {
  if (lines.length === 0) {
    throw new Error('There is nothing recorded to summarise yet.')
  }

  const transcript = formatTranscript(lines, startedAt)

  // Short enough to summarise whole — the common case.
  if (transcript.length <= MAX_SUMMARY_CHARS) {
    return parseSummary(
      await complete({
        system: SUMMARY_PROMPT,
        messages: [{ role: 'user', text: transcript }],
        jsonSchema: SUMMARY_SCHEMA,
        temperature: 0
      })
    )
  }

  // Long meeting. The previous version kept the last 24,000 characters and
  // discarded the rest, which for a forty-minute meeting silently threw away
  // the first half — including everything agreed early on. Read it in
  // sections, then summarise the notes: slower, and it actually covers the
  // meeting that happened.
  const chunks = chunkTranscript(transcript, MAX_SUMMARY_CHARS)
  console.log(`[meeting] ${transcript.length} chars, summarising in ${chunks.length} passes`)

  const notes: string[] = []
  for (const [index, chunk] of chunks.entries()) {
    notes.push(
      await complete({
        system: PASS_PROMPT,
        messages: [
          { role: 'user', text: `Section ${index + 1} of ${chunks.length}:\n\n${chunk}` }
        ],
        temperature: 0
      })
    )
  }

  const combined = notes.map((note, i) => `--- Section ${i + 1} ---\n${note}`).join('\n\n')

  return parseSummary(
    await complete({
      system: `${SUMMARY_PROMPT}

What follows is not a transcript but section-by-section notes from one long meeting,
in order. Merge them into one account of the whole meeting. Where the same thread runs
through several sections, report where it ended up rather than listing each mention.`,
      messages: [{ role: 'user', text: combined.slice(-MAX_SUMMARY_CHARS * 2) }],
      jsonSchema: SUMMARY_SCHEMA,
      temperature: 0
    })
  )
}

// --- Export ---------------------------------------------------------------

/**
 * What a meeting can leave as.
 *
 * `transcript` is the raw text, which stays plain on purpose: it has to open
 * anywhere and paste into anything, including a bigger model than the one that
 * wrote the summary. The rest are the shapes a summary is actually used in —
 * a document to circulate, a deck to present from, and Markdown, which is what
 * both Notion and OneNote import.
 */
export type ExportFormat = MeetingExportFormat

export interface ExportedFile {
  data: Buffer
  extension: string
  /** Shown in the save dialog's file-type filter. */
  filterName: string
}

function meetingTitle(startedAt: number): string {
  return `Meeting — ${new Date(startedAt).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })}`
}

function meetingSubtitle(startedAt: number, lines: MeetingLine[]): string {
  const last = lines.reduce((max, line) => Math.max(max, line.offsetMs), 0)
  const minutes = Math.max(1, Math.round(last / 60000))
  const time = new Date(startedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })
  return `Started ${time} · ${minutes} minutes · transcribed by Nimbus`
}

/** The four headed blocks, in the order they are useful to read. */
function summarySections(summary: MeetingSummary): Array<{
  heading: string
  body: string[]
  bullets?: boolean
}> {
  return [
    { heading: 'Summary', body: summary.summary ? [summary.summary] : [] },
    { heading: 'Decisions', body: summary.decisions, bullets: true },
    { heading: 'Actions', body: summary.actions, bullets: true },
    { heading: 'Open questions', body: summary.openQuestions, bullets: true }
  ]
}

/** Markdown — what Notion and OneNote both take on import. */
function meetingMarkdown(
  summary: MeetingSummary,
  lines: MeetingLine[],
  startedAt: number
): string {
  const parts = [`# ${meetingTitle(startedAt)}`, '', `*${meetingSubtitle(startedAt, lines)}*`, '']

  for (const section of summarySections(summary)) {
    if (section.body.length === 0) continue
    parts.push(`## ${section.heading}`, '')
    for (const line of section.body) parts.push(section.bullets ? `- ${line}` : line)
    parts.push('')
  }

  // The transcript comes along, collapsed. The summary is what gets read, but
  // the record of what was actually said is the thing you need when someone
  // disputes it — and splitting them across two files is how one gets lost.
  parts.push('---', '', '## Full transcript', '')
  for (const line of lines.slice().sort((a, b) => a.offsetMs - b.offsetMs)) {
    parts.push(`**[${clockFor(line.offsetMs)}] ${line.speaker === 'you' ? 'You' : 'Them'}:** ${line.text}`, '')
  }

  return parts.join('\n')
}

/** Slides: a title card, then one per section, split so none overflows. */
function meetingSlides(summary: MeetingSummary, lines: MeetingLine[], startedAt: number): Slide[] {
  const slides: Slide[] = [
    {
      title: meetingTitle(startedAt),
      bullets: [meetingSubtitle(startedAt, lines)]
    }
  ]

  if (summary.summary) {
    // Split into sentences so a paragraph becomes points rather than a wall of
    // text set in 18pt, which is the single most common way a generated deck
    // is unusable.
    const sentences = summary.summary
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
    slides.push({ title: 'Summary', bullets: sentences })
  }

  /** Six lines is about what fits before the text has to shrink to fit. */
  const PER_SLIDE = 6
  for (const section of summarySections(summary).slice(1)) {
    for (let i = 0; i < section.body.length; i += PER_SLIDE) {
      const page = section.body.slice(i, i + PER_SLIDE)
      const continued = i > 0 ? ` (${Math.floor(i / PER_SLIDE) + 1})` : ''
      slides.push({ title: `${section.heading}${continued}`, bullets: page })
    }
  }

  return slides
}

export function exportMeeting(
  format: ExportFormat,
  lines: MeetingLine[],
  startedAt: number,
  summary: MeetingSummary | null
): ExportedFile {
  if (format === 'transcript') {
    return {
      data: Buffer.from(formatTranscript(lines, startedAt), 'utf8'),
      extension: 'txt',
      filterName: 'Text'
    }
  }

  if (!summary) {
    throw new Error('Summarise the meeting first — this format is built from the summary.')
  }

  if (format === 'markdown') {
    return {
      data: Buffer.from(meetingMarkdown(summary, lines, startedAt), 'utf8'),
      extension: 'md',
      filterName: 'Markdown (Notion, OneNote)'
    }
  }

  if (format === 'pptx') {
    return {
      data: buildPptx(meetingSlides(summary, lines, startedAt)),
      extension: 'pptx',
      filterName: 'PowerPoint'
    }
  }

  return {
    data: buildDocx(meetingTitle(startedAt), meetingSubtitle(startedAt, lines), [
      ...summarySections(summary),
      {
        heading: 'Full transcript',
        body: lines
          .slice()
          .sort((a, b) => a.offsetMs - b.offsetMs)
          .map(
            (line) =>
              `[${clockFor(line.offsetMs)}] ${line.speaker === 'you' ? 'You' : 'Them'}: ${line.text}`
          )
      }
    ]),
    extension: 'docx',
    filterName: 'Word document'
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
