import { app } from 'electron'
import { join } from 'node:path'
import config from '../../config.json'
import { usableBackend } from '../main/gpu-probe'

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

/** Kokoro's weights are 325MB whole, so anything near this is truncated. */
const MIN_WEIGHT_BYTES = 100_000_000

/**
 * WebGPU first, DirectML second. Both are GPU execution providers on Windows —
 * this is not a slide down to CPU, just a hedge against `onnxruntime-node`
 * builds (or driver setups) that don't expose WebGPU on a given machine.
 */
/** Decided by probing the GPU in a child process — see main/gpu-probe.ts. */
async function devicesToTry(): Promise<readonly string[]> {
  const backend = await usableBackend()
  // On a machine with no usable GPU there is no point loading Kokoro at all:
  // on CPU it takes longer to speak a sentence than the sentence lasts. An
  // empty list makes speakLocally fail fast so the caller uses Edge, which is
  // free, keyless and fast everywhere.
  return backend === 'webgpu' ? ['webgpu'] : []
}

/**
 * A full, low male narrator voice. Fenrir is one of Kokoro's stronger male
 * voices and stays clear when Nimbus reads short answers at a brisk pace.
 *
 * Read lazily, not at module load: this module is reached (via tts.ts) from
 * main/index.ts's static imports, which run before that file's own
 * `dotenv.config()` call — a top-level `const` here would freeze before
 * .env was ever read.
 */
function voice(): string {
  return process.env.NIMBUS_LOCAL_VOICE || 'am_fenrir'
}

/** The voice the out-of-process host should use. */
export function localVoiceName(): string {
  return voice()
}

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

/**
 * Idle unloading is only safe for a CPU session.
 *
 * Dropping the reference hands the native session to the garbage collector,
 * which frees the GPU device whenever it next runs — and freeing a WebGPU
 * device crashes the process outright with 0xC0000409 on hardware where
 * inference itself is perfectly healthy (measured: a child process that opens
 * a session, uses it, then exits, dies every time). At an unpredictable moment
 * long after the last question, that is indistinguishable from the app
 * closing for no reason.
 *
 * So a GPU-backed model stays resident for the life of the process. It costs
 * memory; the alternative costs the app.
 */
let loadedOnGpu = false

/** Throws away the cached weights after a load failure — see local-stt. */
export async function purgeLocalTts(): Promise<void> {
  const { rm } = await import('node:fs/promises')
  const dir = join(ttsCacheDir(), ...MODEL_ID.split('/'))
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  loaded = null
  console.warn('[local-tts] cleared a bad model cache; it will download again')
}

export function unloadLocalTts(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!loaded) return
  if (loadedOnGpu) return
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

/**
 * How long a backend gets to load before it is written off.
 *
 * Not a safety net — a real measurement. DirectML on this hardware took 170
 * seconds to load and then failed anyway, so with it in the fallback chain a
 * WebGPU failure did not produce a quick switch to the cloud voice; it produced
 * three minutes of apparent silence first. Whatever the backend, one that has
 * not loaded by now is not the one the user should be waiting on.
 *
 * The abandoned load carries on in the background because ONNX Runtime has no
 * way to cancel it. That is worth it: the alternative is blocking the answer.
 */
const BACKEND_LOAD_TIMEOUT_MS = 25_000

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`did not load within ${BACKEND_LOAD_TIMEOUT_MS}ms`)),
        BACKEND_LOAD_TIMEOUT_MS
      )
    })
  ]).finally(() => clearTimeout(timer)) as Promise<T>
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
    let device: string | undefined
    let lastError: unknown
    const candidates = await devicesToTry()
    if (candidates.length === 0) throw new Error('No GPU backend on this machine for the on-device voice.')
    for (const candidate of candidates) {
      const attempt = Date.now()
      try {
        tts = (await withDeadline(
          KokoroTTS.from_pretrained(MODEL_ID, {
            dtype: DTYPE,
            device: candidate,
            progress_callback: progressCallback
          } as Parameters<typeof KokoroTTS.from_pretrained>[1])
        )) as unknown as Kokoro
        device = candidate
        break
      } catch (error) {
        console.warn(
          `[local-tts] ${candidate} unusable after ${Date.now() - attempt}ms, trying next backend:`,
          error instanceof Error ? error.message : error
        )
        lastError = error
      }
    }
    if (!tts) throw lastError

    loadedOnGpu = device !== 'cpu'
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
    // Whole files, not just present ones — an interrupted download leaves a
    // truncated .onnx that reports as installed and fails to parse for ever.
    const onnx = join(dir, 'onnx')
    if (!existsSync(onnx)) return false
    const { statSync } = await import('node:fs')
    const weights = readdirSync(onnx).filter((name) => name.endsWith('.onnx'))
    if (weights.length === 0) return false
    return weights.every((name) => statSync(join(onnx, name)).size >= MIN_WEIGHT_BYTES)
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
    const selectedVoice = voice()
    const result = await tts.generate(text, { voice: selectedVoice })
    scheduleUnload()

    const seconds = result.audio.length / result.sampling_rate
    console.log(
      `[local-tts] ${seconds.toFixed(1)}s of speech in ${Date.now() - started}ms (${selectedVoice})`
    )

    // WAV rather than raw samples: the renderer hands this straight to an
    // audio element, which needs a container it can recognise. (`toBlob` on
    // transformers v4; v3's `toWav` is gone, and kokoro-js still expects v3.)
    const wav = await result.toBlob().arrayBuffer()
    return { audio: Buffer.from(wav), mimeType: 'audio/wav' }
  })
}
