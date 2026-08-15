import { GoogleGenerativeAI } from '@google/generative-ai'
import type { StreamHandler } from './gemini'
import type { TextActionKind } from '../shared/types'

const INSTRUCTIONS: Record<Exclude<TextActionKind, 'custom'>, string> = {
  translate:
    'Translate the text into English. If it is already English, translate it into French instead. Output only the translation.',
  summarize:
    'Summarise the text in at most three short sentences, keeping concrete details like names, numbers and dates. Output only the summary.',
  explain:
    'Explain what the text means in plain language, as if to a smart person unfamiliar with the subject. Three sentences maximum.',
  rewrite:
    'Rewrite the text so it reads clearly and professionally. Preserve the meaning, tone and approximate length. Output only the rewritten text.',
  grammar:
    'Correct spelling, grammar and punctuation. Change nothing else — keep the wording, tone and formatting as close to the original as possible. Output only the corrected text.'
}

// Rewrites replace what the user had, so the output must be the text itself
// with no preamble — "Here is the rewritten version:" pasted into a document
// is worse than useless.
const SYSTEM_PROMPT = `You transform a snippet of text the user selected in another application.
Return only the transformed text. No preamble, no explanation, no quotes around it, no
markdown fences. Preserve the original line breaks and list structure where they exist.`

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
    kind === 'custom'
      ? (customInstruction ?? 'Improve this text.')
      : INSTRUCTIONS[kind]

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
