import { complete } from './llm'
import { currentTimeContext } from './now'
import config from '../../config.json'
import type { PaperworkCardData } from '../shared/types'

/**
 * Official letters, read for you.
 *
 * This is the same explicit screenshot flow as any other screen question —
 * you press the capture hotkey, nothing is watched in the background — but
 * the answer is structured rather than prose, because what you need from a
 * Behörde letter is always the same four things: what it is, what it wants
 * from you, by when, and how much. Those are exactly the things that are
 * hardest to find in a formal letter written in a language you don't read
 * well, and exactly the things it is expensive to get wrong.
 *
 * The deadline comes back as a real date so a reminder can be offered
 * directly from the card — a due date you have to re-enter by hand is a due
 * date you will forget.
 */

const native = config.language?.native || 'English'

const PAPERWORK_PROMPT = `You are reading an official document from a photograph or screenshot:
a letter, form, invoice, contract, notice or bill.

Explain it in ${native}, however the document itself is written. Assume the reader does not
read the document's language well and is worried about missing something that matters.

- summary: two or three plain sentences on what this actually is and what it means for them.
  Lead with the consequence, not the letterhead.
- sender: the organisation it is from, exactly as written.
- documentType: a short label — "Rent increase", "Tax assessment", "Invoice", "Appointment
  confirmation", "Insurance renewal".
- actionRequired: what they must actually DO, in one line. Use "Nothing — for your records"
  when it genuinely needs no action.
- deadline: the date they must act by, as YYYY-MM-DD, resolved against today's date given
  below. Leave empty if the document sets none. Never invent one.
- deadlineLabel: how the document words that deadline, quoted — "within 14 days",
  "bis zum 31.08.2026".
- amount: any sum of money involved, with its currency exactly as printed. Empty if none.
- reference: the case, invoice or customer number they would need to quote. Empty if none.
- keyPoints: up to four short lines for anything else that carries a consequence — a right
  to object, a penalty, an automatic renewal, a required document to enclose.

Quote names, dates, reference numbers and amounts exactly as printed rather than translating
them. If something genuinely is not in the document, leave that field empty rather than
guessing — a wrong deadline is far worse than a missing one.`

const PAPERWORK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    sender: { type: 'STRING' },
    documentType: { type: 'STRING' },
    actionRequired: { type: 'STRING' },
    deadline: { type: 'STRING' },
    deadlineLabel: { type: 'STRING' },
    amount: { type: 'STRING' },
    reference: { type: 'STRING' },
    keyPoints: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['summary', 'documentType', 'actionRequired']
}

/**
 * Words that mean "this is a document, not a screen" — in the user's own
 * language and in German, since that is the paperwork most likely to need
 * this. A keyword test rather than another model call: it is instant, free,
 * and predictable, and the cost of a miss is only a prose answer instead of a
 * structured one.
 */
const DOCUMENT_WORDS =
  /\b(letter|document|form|invoice|bill|contract|notice|statement|fine|tax|deadline|paperwork|brief|schreiben|rechnung|bescheid|mahnung|vertrag|kündigung|antrag|formular|frist|steuer|beitrag|nebenkosten|widerspruch)\b/i

export function looksLikePaperwork(utterance: string): boolean {
  return DOCUMENT_WORDS.test(utterance)
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export async function readDocument(
  question: string,
  image: { base64: string; mimeType: string }
): Promise<Omit<PaperworkCardData, 'thumbnail'>> {
  const text = await complete({
    system: `${PAPERWORK_PROMPT}\n\n${currentTimeContext()}`,
    messages: [{ role: 'user', text: question || 'What does this document say?' }],
    image,
    jsonSchema: PAPERWORK_SCHEMA,
    temperature: 0
  })

  const parsed = JSON.parse(stripFences(text)) as Record<string, unknown>
  const str = (value: unknown): string =>
    typeof value === 'string' && value.trim() ? value.trim() : ''

  const deadline = str(parsed.deadline)

  return {
    summary: str(parsed.summary),
    sender: str(parsed.sender),
    documentType: str(parsed.documentType) || 'Document',
    actionRequired: str(parsed.actionRequired),
    // A malformed date would silently become an invalid reminder, so anything
    // that isn't a real YYYY-MM-DD is dropped rather than passed on.
    deadline: DATE_PATTERN.test(deadline) ? deadline : '',
    deadlineLabel: str(parsed.deadlineLabel),
    amount: str(parsed.amount),
    reference: str(parsed.reference),
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.filter((point): point is string => typeof point === 'string' && !!point.trim()).slice(0, 4)
      : []
  }
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}
