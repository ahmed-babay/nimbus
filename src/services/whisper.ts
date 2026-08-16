import { httpFetch } from './http'

const TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

interface GroqTranscriptionResponse {
  text: string
}

/**
 * Groq's free-tier, OpenAI-compatible Whisper endpoint. Electron's Chromium
 * doesn't ship the proprietary Google API key that the Web Speech API's
 * SpeechRecognition (STT) needs to reach Google's servers, so it always
 * fails with a "network" error in Electron regardless of connectivity —
 * this replaces it. SpeechSynthesis (TTS) is unaffected since it's local.
 */
/** Groq validates by file extension, so keep it consistent with the blob type. */
function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0].trim()
  switch (base) {
    case 'audio/webm':
      return 'webm'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/mp4':
    case 'audio/mpeg':
      return 'mp4'
    case 'audio/wav':
      return 'wav'
    default:
      return 'webm'
  }
}

export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set. Add it to your .env file.')
  }

  // Groq rejects empty/near-empty uploads; fail with a clear message rather
  // than an opaque 400.
  if (audio.length < 1024) {
    throw new Error("I didn't catch that — the recording was too short.")
  }

  const extension = extensionFor(mimeType)
  console.log(`[whisper] uploading ${audio.length} bytes as audio.${extension} (${mimeType})`)

  const form = new FormData()
  form.append('file', new Blob([audio], { type: mimeType }), `audio.${extension}`)
  form.append('model', process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo')
  form.append('response_format', 'json')

  const res = await httpFetch(TRANSCRIPTION_URL, {
    label: 'Groq',
    timeoutMs: 20000,
    retries: 2,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })

  if (!res.ok) {
    // Include the API's own explanation — a bare status code turned every
    // failure here into guesswork.
    const detail = await res.text().catch(() => '')
    console.error(`[whisper] ${res.status} response: ${detail.slice(0, 400)}`)
    if (res.status === 401) {
      throw new Error('The Groq API key looks invalid. Check GROQ_API_KEY in your .env file.')
    }
    if (res.status === 429) {
      throw new Error('Groq rate limit reached. Give it a moment and try again.')
    }
    throw new Error(`Transcription failed (${res.status}). See the terminal for details.`)
  }

  const json = (await res.json()) as GroqTranscriptionResponse
  return (json.text ?? '').trim()
}
