import { app } from 'electron'
import { join } from 'node:path'
import type { DeviceType } from '@huggingface/transformers'
import { usableBackend } from '../main/gpu-probe'

/**
 * Speech recognition that runs on your own machine.
 *
 * This replaces a Groq Whisper call, and the reason is not speed — it is that
 * transcription was the last thing in Nimbus that *required* an API key. The
 * overlay could not hear you at all without one. Now the key is optional and
 * the assistant works on a plane.
 *
 * **It runs on the GPU through WebGPU, and that choice was measured.** On an
 * RTX 3070 laptop, against 13.7s of German speech:
 *
 * | backend        | time   | real-time factor |
 * |----------------|--------|------------------|
 * | CPU (q8)       | 4742ms | 0.35x            |
 * | WebGPU (fp32)  |  690ms | 0.05x            |
 *
 * Both produced the identical, correct transcript. DirectML was tried too and
 * is not usable: quantized weights fail outright, and fp32 took 170s to load.
 * WebGPU is also the backend that ships bundled with onnxruntime-node on every
 * platform, so there is no CUDA toolkit for anyone to install.
 *
 * **`base` rather than `small`.** `small` is twice as slow, downloads a
 * gigabyte instead of ~290MB, and on the same clip transcribed no better —
 * `base` actually punctuated it more accurately. `tiny` is faster still but
 * heard "Infraktion" for "Inflation", and a wrong word in a meeting transcript
 * is worse than a slow one.
 *
 * **Audio arrives already decoded.** The renderer hands over 16kHz mono PCM
 * because Chromium can decode WebM/Opus and Node cannot — doing it there costs
 * nothing and avoids bundling a codec.
 */

/** Small, accurate enough. fp32 runs on every backend, GPU or CPU, so a
 *  machine that falls back to CPU reuses the weights it already downloaded
 *  rather than fetching a second quantised copy mid-question. */
const MODEL_ID = 'onnx-community/whisper-base'
const DTYPE = 'fp32'

/**
 * Floor for a weights file. Whisper base's smallest part is 82MB, so anything
 * under this is a truncated download rather than a real model.
 */
const MIN_WEIGHT_BYTES = 40_000_000

/**
 * The device is decided by probing the GPU in a child process first.
 *
 * A WebGPU or DirectML failure here is a native crash, not a JS exception —
 * it takes the whole process down instead of throwing something catchable, so
 * there is no way to try it in-process and recover. main/gpu-probe.ts tries it
 * somewhere expendable and reports back, which is what lets this fall back to
 * CPU on a machine whose driver cannot cope instead of dying on it.
 *
 * NIMBUS_STT_DEVICE still forces a specific backend when someone wants one.
 */
async function sttDevice(): Promise<DeviceType> {
  const forced = process.env.NIMBUS_STT_DEVICE
  if (forced) return forced as DeviceType
  return (await usableBackend()) as DeviceType
}

/** What Whisper is trained on; the renderer resamples to match. */
export const SAMPLE_RATE = 16000

/**
 * Unloaded after this long without speech. Longer than the LLM's five minutes
 * because STT is what runs *first* in every interaction — paying a reload
 * before every question would be felt on each one, and the weights are a
 * fraction of the LLM's size.
 */
const IDLE_UNLOAD_MS = 15 * 60 * 1000

/** Whisper emits these for silence or noise; they are not speech. */
const NOISE = /^[\s.,!?-]*(\[.*?\]|\(.*?\)|♪.*♪|thank you\.?|you\.?|bye\.?)[\s.,!?-]*$/i

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<{ text: string }>

let loaded: Transcriber | null = null
let loading: Promise<Transcriber> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** Kept beside the LLM weights so one folder holds everything downloaded. */
export function sttCacheDir(): string {
  return join(app.getPath('userData'), 'models', 'onnx')
}

function scheduleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => unloadLocalStt(), IDLE_UNLOAD_MS)
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

/**
 * Throws away the cached weights.
 *
 * Called when loading fails, because the overwhelmingly likely reason is a
 * half-written file, and a bad cache that is never cleared is permanent: it
 * keeps reporting itself as installed and failing for ever.
 */
export async function purgeLocalStt(): Promise<void> {
  const { rm } = await import('node:fs/promises')
  const dir = join(sttCacheDir(), ...MODEL_ID.split('/'))
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  loaded = null
  console.warn('[local-stt] cleared a bad model cache; it will download again')
}

export function unloadLocalStt(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!loaded) return
  if (loadedOnGpu) return
  loaded = null
  console.log('[local-stt] unloaded after idle')
}

export interface SttProgress {
  file: string
  receivedBytes: number
  totalBytes: number
  done: boolean
}

async function load(onProgress?: (progress: SttProgress) => void): Promise<Transcriber> {
  if (loaded) return loaded
  if (loading) return loading

  loading = (async () => {
    // Lazy so a session that never speaks never pays to initialise ONNX.
    const { pipeline, env } = await import('@huggingface/transformers')
    // Default cache is inside node_modules, which a packaged app cannot write
    // to; point it somewhere per-user and durable.
    env.cacheDir = sttCacheDir()

    const started = Date.now()
    const device = await sttDevice()
    loadedOnGpu = device !== 'cpu'
    const asr = await pipeline('automatic-speech-recognition', MODEL_ID, {
      dtype: DTYPE,
      device,
      progress_callback: onProgress
        ? (report: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (report.status === 'progress') {
              onProgress({
                file: report.file ?? '',
                receivedBytes: report.loaded ?? 0,
                totalBytes: report.total ?? 0,
                done: false
              })
            }
          }
        : undefined
    })

    console.log(`[local-stt] ready in ${Date.now() - started}ms (${MODEL_ID}, ${device})`)
    onProgress?.({ file: '', receivedBytes: 0, totalBytes: 0, done: true })
    loaded = asr as unknown as Transcriber
    return loaded
  })()

  try {
    return await loading
  } finally {
    loading = null
  }
}

/** True once the weights are on disk, so nothing has to be downloaded. */
export async function localSttInstalled(): Promise<boolean> {
  const { existsSync, readdirSync } = await import('node:fs')
  // transformers.js mirrors the Hub's own layout, so the org is a real
  // directory rather than part of a flattened name.
  const dir = join(sttCacheDir(), ...MODEL_ID.split('/'))
  if (!existsSync(dir)) return false
  try {
    // A cache folder can exist with only a config in it after a failed fetch;
    // the weights are what actually matter.
    //
    // And the weights have to be *whole*. transformers.js writes straight to
    // the cache, so a download cut off by a closed lid or a dropped connection
    // leaves a truncated .onnx behind. Merely checking the file exists then
    // reports the model as installed for ever: Setup shows it as ready, every
    // load fails to parse, and Nimbus quietly falls back to the cloud - which
    // needs a key, so on a machine without one it simply stops hearing.
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

/** Warms the model up so the first question isn't the one that waits. */
export async function prepareLocalStt(
  onProgress?: (progress: SttProgress) => void
): Promise<void> {
  await load(onProgress)
  scheduleUnload()
}

/**
 * Serialises transcription. One pipeline, one GPU context — two decodes at
 * once would contend, and subtitles genuinely can overlap a spoken question.
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work)
  queue = result.catch(() => undefined)
  return result
}

export interface LocalTranscribeOptions {
  /** ISO code to decode as. Omitted means Whisper detects it itself. */
  language?: string
  /** Translate to English instead of transcribing verbatim. */
  translate?: boolean
}

/**
 * Whisper takes a bare language code, and guesses badly without one on short
 * audio: three seconds of German came back as "Good evening. In the today's"
 * because it decided the clip was English and transcribed it as such. Callers
 * know the language far better than a two-second sample does, so any regional
 * suffix is dropped and the rest handed straight through.
 */
function languageCode(value: string | undefined): string | undefined {
  const code = value?.trim().toLowerCase().split(/[-_]/)[0]
  return code && code.length >= 2 ? code : undefined
}

export async function transcribeLocally(
  pcm: Float32Array,
  options: LocalTranscribeOptions = {}
): Promise<string> {
  // Under a fifth of a second cannot hold a word; skip the model entirely.
  if (pcm.length < SAMPLE_RATE / 5) return ''

  return enqueue(async () => {
    const asr = await load()
    const started = Date.now()
    const language = languageCode(options.language)
    const result = await asr(pcm, {
      task: options.translate ? 'translate' : 'transcribe',
      ...(language ? { language } : {}),
      // Whisper loops on silence without this, repeating a phrase until it
      // fills the window.
      no_repeat_ngram_size: 4
    })
    scheduleUnload()

    const text = (result.text ?? '').trim()
    const seconds = pcm.length / SAMPLE_RATE
    console.log(
      `[local-stt] ${seconds.toFixed(1)}s audio in ${Date.now() - started}ms -> ${text.length} chars`
    )

    return NOISE.test(text) ? '' : text
  })
}
