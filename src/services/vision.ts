import { GoogleGenerativeAI } from '@google/generative-ai'
import { getHistorySummary } from './conversation'
import type { StreamHandler } from './gemini'

const SYSTEM_PROMPT = `You are Nimbus, looking at a screenshot of the user's screen.
Answer their question about what's on it directly and concretely — quote exact error text,
button labels, or values you can see rather than describing the screen in general terms.
Keep it to 1-4 short sentences; it will be read aloud by text-to-speech, so no markdown,
bullet points or emoji. If the answer genuinely isn't visible, say so plainly.`

let client: GoogleGenerativeAI | null = null

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.')
    client = new GoogleGenerativeAI(apiKey)
  }
  return client
}

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
  const model = getClient().getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
    systemInstruction: context ? `${SYSTEM_PROMPT}\n\nRecent conversation:\n${context}` : SYSTEM_PROMPT
  })

  const parts = [
    { text: question },
    { inlineData: { mimeType: image.mimeType, data: image.base64 } }
  ]

  if (!onChunk) {
    const result = await model.generateContent(parts)
    return result.response.text().trim()
  }

  const { stream } = await model.generateContentStream(parts)
  let full = ''
  for await (const part of stream) {
    const chunk = part.text()
    if (!chunk) continue
    full += chunk
    onChunk(chunk)
  }
  return full.trim()
}
