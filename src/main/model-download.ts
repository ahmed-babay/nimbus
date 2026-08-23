import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { chooseModelToDownload, localModelPath } from '../services/local-llm'
import { localSttInstalled, prepareLocalStt, sttCacheDir } from '../services/local-stt'
import { localTtsInstalled, prepareLocalTts, ttsCacheDir } from '../services/local-tts'
import type { LocalModelKind, LocalModelProgress, LocalModelStatus } from '../shared/types'

/**
 * Fetches the local model on first use.
 *
 * The weights are not committed or bundled — half a gigabyte in the installer
 * would be paid for by everyone, including people who only ever use a cloud
 * provider. Downloading on demand also means the model can be replaced without
 * shipping a new build.
 *
 * Written to a temporary file and renamed only once complete, so a download
 * interrupted by a closed laptop leaves nothing behind that looks like a
 * working model. A half-written GGUF loads far enough to fail confusingly.
 */

/**
 * Sanity floor for reporting a model as installed. The real per-model floor
 * lives with the model list in local-llm; this is only for the status call,
 * which reports whatever path that module picked.
 */
const MIN_MODEL_BYTES = 400_000_000

export type DownloadProgress = LocalModelProgress

let inFlight: Promise<void> | null = null

/**
 * The two speech models are both folders of ONNX files managed by
 * transformers.js rather than single files, and both download by being loaded,
 * so they share one code path.
 */
const ONNX_MODELS = {
  stt: { installed: localSttInstalled, dir: sttCacheDir, prepare: prepareLocalStt },
  tts: { installed: localTtsInstalled, dir: ttsCacheDir, prepare: prepareLocalTts }
} as const

const onnxInFlight: Partial<Record<'stt' | 'tts', Promise<void>>> = {}

export async function localModelStatus(kind: LocalModelKind = 'llm'): Promise<LocalModelStatus> {
  if (kind === 'stt' || kind === 'tts') {
    const model = ONNX_MODELS[kind]
    return {
      kind,
      installed: await model.installed(),
      path: model.dir(),
      // Reported as 0 rather than walked: the size is spread over a folder,
      // and the number is decoration next to whether it works.
      sizeBytes: 0,
      downloading: onnxInFlight[kind] !== undefined
    }
  }

  const path = localModelPath()
  try {
    const info = await stat(path)
    return {
      kind,
      installed: info.size >= MIN_MODEL_BYTES,
      path,
      sizeBytes: info.size,
      downloading: inFlight !== null
    }
  } catch {
    return { kind, installed: false, path, sizeBytes: 0, downloading: inFlight !== null }
  }
}

/**
 * Fetches a speech model. transformers.js downloads on first load, so this is
 * just a load with the progress reported — and it leaves the model warm, which
 * means the first thing said afterwards isn't the request that waits.
 */
export async function downloadOnnxModel(
  kind: 'stt' | 'tts',
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  const running = onnxInFlight[kind]
  if (running) return running

  const started = (async () => {
    try {
      await ONNX_MODELS[kind].prepare((progress) =>
        onProgress({
          kind,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          done: progress.done
        })
      )
      onProgress({ kind, receivedBytes: 0, totalBytes: 0, done: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The download failed.'
      onProgress({ kind, receivedBytes: 0, totalBytes: 0, done: true, error: message })
      throw error
    }
  })()

  onnxInFlight[kind] = started
  try {
    await started
  } finally {
    delete onnxInFlight[kind]
  }
}

export async function downloadLocalModel(
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  // A second click while one is running joins the first rather than starting
  // a competing write to the same path.
  if (inFlight) return inFlight

  inFlight = (async () => {
    // Which model depends on the machine: the 4B is both faster and more
    // accurate, and needs a card that can hold it. Measured here rather than
    // guessed, and decided at download time so a 2.3GB fetch is only started
    // where it will actually be used.
    const model = await chooseModelToDownload()
    const target = join(dirname(localModelPath()), model.file)
    const temp = `${target}.part`
    await mkdir(dirname(target), { recursive: true })

    try {
      const res = await fetch(model.url)
      if (!res.ok || !res.body) {
        throw new Error(`The download failed (${res.status}). Check your connection.`)
      }

      const totalBytes = Number(res.headers.get('content-length') ?? 0)
      let receivedBytes = 0
      let lastReport = 0

      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      body.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length
        // Reporting every chunk would flood IPC for very little; a few times
        // a second is enough to animate a bar honestly.
        const now = Date.now()
        if (now - lastReport > 250) {
          lastReport = now
          onProgress({ kind: 'llm', receivedBytes, totalBytes, done: false })
        }
      })

      await pipeline(body, createWriteStream(temp))
      await rename(temp, target)
      onProgress({ kind: 'llm', receivedBytes, totalBytes, done: true })
      console.log(`[model] downloaded ${model.url} -> ${target}`)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      const message = error instanceof Error ? error.message : 'The download failed.'
      onProgress({ kind: 'llm', receivedBytes: 0, totalBytes: 0, done: true, error: message })
      throw error
    }
  })()

  try {
    await inFlight
  } finally {
    inFlight = null
  }
}
