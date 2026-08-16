import { complete, streamComplete } from './llm'
import { getHistorySummary } from './conversation'
import type { StreamHandler } from './gemini'
import config from '../../config.json'
import { currentTimeContext } from './now'

const native = config.language?.native || 'English'

const SYSTEM_PROMPT = `You are Nimbus, looking at a screenshot of the user's screen.
Answer their question about what's on it directly and concretely — quote exact error text,
button labels, or values you can see rather than describing the screen in general terms.
Keep it to 1-4 short sentences; it will be read aloud by text-to-speech, so no markdown,
bullet points or emoji. If the answer genuinely isn't visible, say so plainly.

Always answer in ${native}, even when the screen is in a different language — the user may
well be looking at something they don't fully read. When the screen is a letter, form,
invoice or official notice, lead with what it actually means for them: what is being asked,
any deadline, and any amount of money. Quote names, dates, reference numbers and amounts
exactly as written rather than translating them.`

/**
 * Answers a question about a screenshot. Uses the same free-tier Gemini model
 * as everything else — its vision support needs no separate key or endpoint.
 */
export async function askAboutScreen(
  question: string,
  image: { base64: string; mimeType: string },
  onChunk?: StreamHandler
): Promise<string> {
  const context = getHistorySummary(4)
  const request = {
    system:
      `${SYSTEM_PROMPT}\n\n${currentTimeContext()}` +
      (context ? `\n\nRecent conversation:\n${context}` : ''),
    messages: [{ role: 'user' as const, text: question }],
    image
  }

  if (!onChunk) return complete(request)
  return streamComplete(request, onChunk)
}
