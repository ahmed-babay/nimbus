import { httpFetch } from './http'
import { transcriptionHint } from './region'
import { localSttInstalled, transcribeLocally, SAMPLE_RATE } from './local-stt'

const TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

interface GroqTranscriptionResponse {
  text: string
}

/**
 * Speech to text, on-device first.
 *
 * Electron's Chromium doesn't ship the proprietary Google key that the Web
 * Speech API needs, so it always fails with a "network" error regardless of
 * connectivity — Nimbus has never been able to use it. What replaced it was a
 * Groq Whisper call, which worked but made an API key mandatory just to be
 * heard.
 *
 * Now the local model runs first and Groq is the fallback. Both paths take the
 * same 16kHz mono samples, decoded once in the renderer, so switching between
 * them changes nothing else in the pipeline.
 */

export interface TranscribeOptions {
  /**
   * Replaces the region hint with continuation context — the tail of what was
   * said just before. Whisper treats its prompt as preceding text, so this
   * keeps a piece that was cut mid-sentence from being transcribed as if it
   * began there.
   */
  contextPrompt?: string
  /** ISO code to decode as; omitted means the model detects it. */
  language?: string
}

/**
 * Wraps raw samples in a WAV header for the cloud fallback, which wants a file
 * rather than an array. Uncompressed is fine — these are seconds of 16kHz
 * mono, and re-encoding to Opus in the main process would cost more than the
 * upload saves.
 */
function toWav(pcm: Float32Array): Buffer {
  const header = Buffer.alloc(44)
  const bytes = pcm.length * 2

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // format: uncompressed
  header.writeUInt16LE(1, 22) // channels
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(bytes, 40)

  const body = Buffer.alloc(bytes)
  for (let i = 0; i < pcm.length; i++) {
    // Clamped before scaling: a sample slightly outside [-1,1] would otherwise
    // wrap to the opposite extreme and click.
    const sample = Math.max(-1, Math.min(1, pcm[i]))
    body.writeInt16LE(Math.round(sample * 32767), i * 2)
  }

  return Buffer.concat([header, body])
}

async function transcribeWithGroq(pcm: Float32Array, options: TranscribeOptions): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error(
      'Speech recognition needs either the on-device model (download it in settings) or a Groq API key.'
    )
  }

  const wav = toWav(pcm)
  console.log(`[whisper] uploading ${wav.length} bytes to Groq`)

  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo')
  form.append('response_format', 'json')
  // Whisper takes an optional prompt as a vocabulary hint. Naming the region
  // measurably improves local place names — "Lusenplatz" became "Luisenplatz"
  // and "Mephilden hole" became "Mathildenhole" on the same audio. It doesn't
  // fix everything, so the intent router corrects what's left.
  const hint = options.contextPrompt?.trim() || transcriptionHint()
  if (hint) form.append('prompt', hint)

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

/**
 * Transcribes 16kHz mono samples, on-device when the weights are present.
 *
 * The local model is only tried when it is already installed — a first-use
 * download in the middle of an utterance would look like a hang, so the
 * download is something settings does deliberately.
 */
export async function transcribeAudio(
  pcm: Float32Array,
  options: TranscribeOptions = {}
): Promise<string> {
  // Shorter than this cannot hold a word, and both backends waste time on it.
  if (pcm.length < SAMPLE_RATE / 5) {
    throw new Error("I didn't catch that — the recording was too short.")
  }

  if (await localSttInstalled()) {
    try {
      return await transcribeLocally(pcm, { language: options.language })
    } catch (error) {
      // Falling through to the cloud is better than failing outright — a GPU
      // that lost its device or a corrupted cache shouldn't make Nimbus deaf.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[whisper] on-device transcription failed, falling back to Groq: ${message}`)
    }
  }

  return transcribeWithGroq(pcm, options)
}
