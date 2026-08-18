import { app } from 'electron'
import { join } from 'node:path'
import config from '../../config.json'

/**
 * The voice that runs on your own machine.
 *
 * Unlike speech recognition, this one does not remove an API key — Edge's
 * "Read Aloud" endpoint has always been free and unauthenticated. What it
 * removes is a network round trip on every answer, and the fact that every
 * word Nimbus speaks is currently typed into a Microsoft endpoint first.
 *
 * **It was chosen on consistency, not peak speed.** Measured on an RTX 3070
 * laptop, generating the same 7.3s sentence:
 *
 * | backend           | time                      |
 * |-------------------|---------------------------|
 * | Edge (network)    | 412ms / 1923ms / 3676ms   |
 * | Kokoro on WebGPU  | 856ms / 865ms             |
 * | Kokoro on CPU     | ~10700ms                  |
 *
 * Edge is sometimes faster and sometimes eight times slower, because it is a
 * network call competing with everything else on the connection. Kokoro lands
 * within a few milliseconds of the same number every time, which is what an
 * assistant that speaks after every question actually needs.
 *
 * The CPU row is why this is GPU-only: 1.46x real time means the sentence takes
 * longer to synthesise than to say. There is no CPU fallback because a CPU
 * fallback would be worse than the cloud in every case.
 */

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

/** fp32 because quantised weights do not run on the WebGPU backend. */
const DTYPE = 'fp32'

/**
 * WebGPU first, DirectML second. Both are GPU execution providers on Windows —
 * this is not a slide down to CPU, just a hedge against `onnxruntime-node`
 * builds (or driver setups) that don't expose WebGPU on a given machine.
 */
const DEVICES_BY_PREFERENCE = ['webgpu', 'dml'] as const

/**
 * A warm, unremarkable narrator voice. Deliberately not a character: this
 * reads train times and weather dozens of times a day, and personality wears
 * out fast at that frequency.
 */
const VOICE = process.env.NIMBUS_LOCAL_VOICE || 'af_heart'

/** Unloaded on the same schedule as the speech recogniser it sits beside. */
const IDLE_UNLOAD_MS = 15 * 60 * 1000

interface Kokoro {
  generate(
    text: string,
    options: { voice: string }
  ): Promise<{ audio: Float32Array; sampling_rate: number; toBlob(): Blob }>
}

let loaded: Kokoro | null = null
let loading: Promise<Kokoro> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

export function ttsCacheDir(): string {
  return join(app.getPath('userData'), 'models', 'onnx')
}

function scheduleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => unloadLocalTts(), IDLE_UNLOAD_MS)
}

export function unloadLocalTts(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!loaded) return
  loaded = null
  console.log('[local-tts] unloaded after idle')
}

/**
 * Whether this voice can speak the configured language at all.
 *
 * kokoro-js bundles an English-only phonemiser, so a German or Arabic answer
 * would come out as an English reading of foreign spelling — worse than the
 * robotic fallback. Those languages keep using Edge, which has real voices for
 * them.
 */
export function localTtsSupportsLanguage(): boolean {
  const language = (config.language?.native ?? 'english').trim().toLowerCase()
  return language === 'english' || language.startsWith('en')
}

export interface TtsProgress {
  receivedBytes: number
  totalBytes: number
  done: boolean
}

async function load(onProgress?: (progress: TtsProgress) => void): Promise<Kokoro> {
  if (loaded) return loaded
  if (loading) return loading

  loading = (async () => {
    const { KokoroTTS } = await import('kokoro-js')
    const { env } = await import('@huggingface/transformers')
    env.cacheDir = ttsCacheDir()

    const started = Date.now()
    const progressCallback = onProgress
      ? (report: { status: string; loaded?: number; total?: number }) => {
          if (report.status === 'progress') {
            onProgress({
              receivedBytes: report.loaded ?? 0,
              totalBytes: report.total ?? 0,
              done: false
            })
          }
        }
      : undefined

    let tts: Kokoro | undefined
    let device: (typeof DEVICES_BY_PREFERENCE)[number] | undefined
    let lastError: unknown
    for (const candidate of DEVICES_BY_PREFERENCE) {
      try {
        tts = (await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: DTYPE,
          device: candidate,
          progress_callback: progressCallback
        } as Parameters<typeof KokoroTTS.from_pretrained>[1])) as unknown as Kokoro
        device = candidate
        break
      } catch (error) {
        console.warn(`[local-tts] ${candidate} unavailable, trying next backend`, error)
        lastError = error
      }
    }
    if (!tts) throw lastError

    console.log(`[local-tts] ready in ${Date.now() - started}ms (${MODEL_ID}, ${device})`)
    onProgress?.({ receivedBytes: 0, totalBytes: 0, done: true })
    loaded = tts
    return loaded
  })()

  try {
    return await loading
  } finally {
    loading = null
  }
}

export async function localTtsInstalled(): Promise<boolean> {
  const { existsSync, readdirSync } = await import('node:fs')
  const dir = join(ttsCacheDir(), ...MODEL_ID.split('/'))
  if (!existsSync(dir)) return false
  try {
    const onnx = join(dir, 'onnx')
    return existsSync(onnx) && readdirSync(onnx).some((name) => name.endsWith('.onnx'))
  } catch {
    return false
  }
}

export async function prepareLocalTts(onProgress?: (progress: TtsProgress) => void): Promise<void> {
  await load(onProgress)
  scheduleUnload()
}

/** One GPU pipeline, so requests are serialised rather than left to contend. */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work)
  queue = result.catch(() => undefined)
  return result
}

export interface LocalSpeech {
  audio: Buffer
  mimeType: string
}

export async function speakLocally(text: string): Promise<LocalSpeech> {
  return enqueue(async () => {
    const tts = await load()
    const started = Date.now()
    const result = await tts.generate(text, { voice: VOICE })
    scheduleUnload()

    const seconds = result.audio.length / result.sampling_rate
    console.log(
      `[local-tts] ${seconds.toFixed(1)}s of speech in ${Date.now() - started}ms (${VOICE})`
    )

    // WAV rather than raw samples: the renderer hands this straight to an
    // audio element, which needs a container it can recognise. (`toBlob` on
    // transformers v4; v3's `toWav` is gone, and kokoro-js still expects v3.)
    const wav = await result.toBlob().arrayBuffer()
    return { audio: Buffer.from(wav), mimeType: 'audio/wav' }
  })
}
