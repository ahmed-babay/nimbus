import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import * as ort from 'onnxruntime-node'

/**
 * Deciding whether a sound is a human voice, rather than whether it is loud.
 *
 * The old detector measured energy in the voice band and how much that energy
 * fluctuated, on the theory that "steady noise sits near 0". That holds for a
 * fan or a hum and fails for everything that actually interrupts people: a
 * train going past, a car, wind gusting through a window, a siren. All of
 * those modulate as hard as speech does, so they passed every test the
 * detector had. There is no threshold that fixes it — the feature being
 * measured genuinely does not separate the two classes.
 *
 * **Silero VAD** is a small neural model trained on exactly this distinction.
 * Measured here against the old heuristic's failure cases, with its own
 * English sample as the positive control:
 *
 *   real speech          77.1% of frames over 0.5
 *   train passing         0.0%   (peak 0.33)
 *   ambulance siren       0.6%   (peak 0.52)
 *   gusting wind          0.0%   (peak 0.49)
 *   car passing           0.0%   (peak 0.04)
 *
 * And with traffic noise mixed into the speech itself, it still finds the
 * voice down to about 5dB SNR — a train beside you — while noise on its own
 * never once crossed 0.5, even when scaled as loud as the speech.
 *
 * It costs 0.117ms per 32ms frame on the CPU, so it runs about 270x faster
 * than real time and needs no GPU. The weights are 2.2MB.
 *
 * Run in the main process rather than the renderer because onnxruntime-node is
 * already proven here, which avoids serving WASM binaries and an audio worklet
 * from the renderer bundle. The renderer sends raw frames over IPC; at 16kHz
 * that is 64KB/s, which is nothing.
 */

const MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx'

/** The model is fixed to this rate; the renderer resamples before sending. */
export const VAD_SAMPLE_RATE = 16000
/** Silero v5 wants exactly this many samples per call — 32ms at 16kHz. */
export const VAD_FRAME_SAMPLES = 512

/** Sanity floor. A truncated download still parses as a file but not as a model. */
const MIN_MODEL_BYTES = 2_000_000

/** Recurrent state, shaped [2, batch, 128]. */
const STATE_SIZE = 2 * 1 * 128

export function vadModelPath(): string {
  return join(app.getPath('userData'), 'models', 'onnx', 'silero-vad', 'silero_vad.onnx')
}

let session: ort.InferenceSession | null = null
let loading: Promise<ort.InferenceSession | null> | null = null

async function downloadModel(): Promise<void> {
  const target = vadModelPath()
  try {
    const info = await stat(target)
    if (info.size >= MIN_MODEL_BYTES) return
  } catch {
    // Not there yet, which is the normal first-run path.
  }

  const temp = `${target}.part`
  await mkdir(join(target, '..'), { recursive: true })
  try {
    const res = await fetch(MODEL_URL)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(body, createWriteStream(temp))
    await rename(temp, target)
    console.log(`[vad] downloaded ${target}`)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Loads the model, downloading it once if needed.
 *
 * Returns null rather than throwing on failure. Voice input has to keep
 * working when this is unavailable — offline on first run, say — and the
 * renderer falls back to the old energy heuristic when there is no session.
 */
async function ensureSession(): Promise<ort.InferenceSession | null> {
  if (session) return session
  if (loading) return loading

  loading = (async () => {
    try {
      await downloadModel()
      // CPU only. It is far too cheap to be worth a GPU context, and the
      // quantised-weights-on-GPU problem that bit the other two models here
      // does not arise at all on CPU.
      session = await ort.InferenceSession.create(vadModelPath(), {
        executionProviders: ['cpu']
      })
      console.log('[vad] Silero VAD ready')
      return session
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[vad] unavailable, falling back to the energy heuristic: ${message}`)
      return null
    } finally {
      loading = null
    }
  })()

  return loading
}

/** Whether the model is on disk and loadable — drives the setup panel's row. */
export async function vadInstalled(): Promise<boolean> {
  try {
    const info = await stat(vadModelPath())
    return info.size >= MIN_MODEL_BYTES
  } catch {
    return false
  }
}

/**
 * One listening turn's worth of recurrent state.
 *
 * Silero is stateful: the probability for a frame depends on the frames before
 * it, which is how it distinguishes a syllable from a click. State therefore
 * has to be per-turn and reset between them, or the tail of the last utterance
 * colours the start of the next one.
 */
interface VadSession {
  state: ort.Tensor
  /** Serialises runs so two IPC messages can't interleave and corrupt state. */
  queue: Promise<void>
}

const sessions = new Map<string, VadSession>()

const sampleRateTensor = (): ort.Tensor =>
  new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [])

function freshState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(STATE_SIZE), [2, 1, 128])
}

export function resetVadSession(id: string): void {
  sessions.set(id, { state: freshState(), queue: Promise.resolve() })
}

export function endVadSession(id: string): void {
  sessions.delete(id)
}

/**
 * Speech probability for each 512-sample frame in `samples`.
 *
 * Returns an empty array when the model isn't available, which the caller
 * reads as "no opinion" and falls back on.
 */
export async function vadProbabilities(id: string, samples: Float32Array): Promise<number[]> {
  const model = await ensureSession()
  if (!model) return []

  let entry = sessions.get(id)
  if (!entry) {
    entry = { state: freshState(), queue: Promise.resolve() }
    sessions.set(id, entry)
  }

  const run = entry.queue.then(async () => {
    const probabilities: number[] = []
    const sr = sampleRateTensor()
    for (let offset = 0; offset + VAD_FRAME_SAMPLES <= samples.length; offset += VAD_FRAME_SAMPLES) {
      const frame = samples.subarray(offset, offset + VAD_FRAME_SAMPLES)
      const input = new ort.Tensor('float32', frame, [1, VAD_FRAME_SAMPLES])
      const output = await model.run({ input, state: entry.state, sr })
      entry.state = output.stateN as ort.Tensor
      probabilities.push((output.output.data as Float32Array)[0])
    }
    return probabilities
  })

  // The queue only orders the runs; a failure in one must not poison the next.
  entry.queue = run.then(
    () => undefined,
    () => undefined
  )

  try {
    return await run
  } catch (error) {
    console.warn(`[vad] inference failed: ${error instanceof Error ? error.message : error}`)
    return []
  }
}

/** Loads the model ahead of the first utterance so nobody waits on it. */
export async function warmVad(): Promise<boolean> {
  return (await ensureSession()) !== null
}
