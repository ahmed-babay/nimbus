import { GoogleGenerativeAI } from '@google/generative-ai'
import type { StreamHandler } from './gemini'
import type { TextActionKind } from '../shared/types'
import config from '../../config.json'

const native = config.language?.native || 'English'

const INSTRUCTIONS: Record<Exclude<TextActionKind, 'custom'>, string> = {
  translate:
    `Translate the text into ${native}. If it is already in ${native}, return it unchanged. ` +
    'Output only the translation.',
  summarize:
    `Summarise the text in at most three short sentences, in ${native}, keeping concrete ` +
    'details like names, numbers, dates and amounts. Output only the summary.',
  explain:
    `Explain in ${native} what the text means and what it is asking of the reader, in plain ` +
    'language. If it states a deadline, an amount of money, or an action the reader must ' +
    'take, say so explicitly. Four sentences maximum.',
  rewrite:
    'Rewrite the text so it reads clearly and professionally, in the same language as the ' +
    'original. Preserve the meaning, tone and approximate length. Output only the rewritten text.',
  grammar:
    'Correct spelling, grammar and punctuation, keeping the original language. Change nothing ' +
    'else — keep the wording, tone and formatting as close to the original as possible. ' +
    'Output only the corrected text.',
  // The point of this one: you understand the letter in your language, but the
  // reply has to go back in theirs.
  reply:
    'Draft a reply to this message or letter. Write the reply in the SAME language as the ' +
    'original text, not in any other language. Match its level of formality — formal and ' +
    'polite for official or business correspondence. Keep it concise and to the point. ' +
    'Use [square brackets] for anything only the sender can fill in, such as names, dates, ' +
    'reference numbers or account details. Output only the reply itself.'
}

// Rewrites replace what the user had, so the output must be the text itself
// with no preamble — "Here is the rewritten version:" pasted into a document
// is worse than useless.
const SYSTEM_PROMPT = `You transform a snippet of text the user selected in another application.
Return only the transformed text. No preamble, no explanation, no quotes around it, no
markdown fences. Preserve the original line breaks and list structure where they exist.

Never pad the output to satisfy an instruction the text can't support — if asked for more
items, sections or detail than the content actually contains, produce only what genuinely
follows from it. Repeating a line to reach a requested count is always wrong.

The user's own language is ${native}. Text they are working with is often in another
language; keep the two straight and follow whichever the instruction asks for.`

let client: GoogleGenerativeAI | null = null

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.')
    client = new GoogleGenerativeAI(apiKey)
  }
  return client
}

export async function runTextAction(
  kind: TextActionKind,
  text: string,
  customInstruction: string | undefined,
  onChunk?: StreamHandler
): Promise<string> {
  const instruction =
    kind === 'custom' ? (customInstruction ?? 'Improve this text.') : INSTRUCTIONS[kind]

  const model = getClient().getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
    systemInstruction: SYSTEM_PROMPT
  })

  const prompt = `${instruction}\n\n---\n${text}\n---`

  if (!onChunk) {
    const result = await model.generateContent(prompt)
    return result.response.text().trim()
  }

  const { stream } = await model.generateContentStream(prompt)
  let full = ''
  for await (const part of stream) {
    const chunk = part.text()
    if (!chunk) continue
    full += chunk
    onChunk(chunk)
  }
  return full.trim()
}
