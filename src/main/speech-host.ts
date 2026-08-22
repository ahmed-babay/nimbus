import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { usableBackend } from './gpu-probe'

/**
 * Runs the on-device speech models in a process that is allowed to die.
 *
 * Both of them crash. Kokoro on WebGPU Not while generating — the audio comes back
 * perfectly — but whenever the GPU device is torn down, which happens
 * whenever V8 decides to collect something holding it. Measured here: ten
 * spoken answers in a row all succeeded and the process then died on exit with
 * 0xC0000409, and a second run died after the eighth. It is a hard native
 * fault, so there is no exception to catch and nothing to recover from. In the
 * main process that means Nimbus vanishes mid-conversation with no error and
 * no log, which is exactly what users described as "it just closes".
 *
 * Whisper does exactly the same thing: eight transcriptions in a row, the
 * seventh killed the process. Same backend, same fault.
 *
 * Keeping the models resident stopped the *scheduled* teardown, but not the
 * garbage collector, so it could still happen at any moment. The only reliable
 * answer is to put them somewhere their death does not matter.
 *
 * So: one long-lived child process holds both models. It pays each model load
 * once, answers in the same couple of hundred milliseconds, and if it dies the
 * parent notices, falls back to the cloud for that request, and starts a new
 * one for next time. One child rather than two because they share a GPU and a
 * runtime, and two would double both.
 */

/** Loading the model is slow; speaking is not. This covers both. */
const REQUEST_TIMEOUT_MS = 30_000

/** Consecutive crashes before the on-device voice is given up on entirely. */
const MAX_RESTARTS = 3

interface Reply {
  audio?: string
  text?: string
}

interface Pending {
  resolve: (reply: Reply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The child. Written at runtime so nothing extra has to be packaged, and given
 * absolute module paths because it does not live inside the app directory and
 * so cannot resolve bare specifiers itself.
 */
function childScript(
  kokoroPath: string,
  transformersPath: string,
  cacheDir: string,
  device: string
): string {
  return `
const { pathToFileURL } = require('node:url')
let tts = null
let asr = null

async function transformers() {
  const mod = await import(pathToFileURL(${JSON.stringify(transformersPath)}).href)
  mod.env.cacheDir = ${JSON.stringify(cacheDir)}
  return mod
}

async function loadTts() {
  if (tts) return tts
  const { KokoroTTS } = await import(pathToFileURL(${JSON.stringify(kokoroPath)}).href)
  await transformers()
  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'fp32',
    device: ${JSON.stringify(device)}
  })
  return tts
}

async function loadAsr() {
  if (asr) return asr
  const { pipeline } = await transformers()
  asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
    dtype: 'fp32',
    device: ${JSON.stringify(device)}
  })
  return asr
}

let buffer = ''
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    try {
      if (request.kind === 'transcribe') {
        const model = await loadAsr()
        const bytes = Buffer.from(request.pcm, 'base64')
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
        const out = await model(samples, {
          language: request.language || undefined,
          task: 'transcribe',
          return_timestamps: false
        })
        const text = ((Array.isArray(out) ? out[0] : out) || {}).text || ''
        process.stdout.write(JSON.stringify({ id: request.id, ok: true, text }) + '\\n')
      } else {
        const model = await loadTts()
        const result = await model.generate(request.text, { voice: request.voice })
        const audio = Buffer.from(await result.toBlob().arrayBuffer())
        process.stdout.write(JSON.stringify({ id: request.id, ok: true, audio: audio.toString('base64') }) + '\\n')
      }
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: String(error && error.message || error) }) + '\\n')
    }
  }
})

// Nothing else keeps this alive; stdin closing means the parent has gone.
process.stdin.on('end', () => process.exit(0))
`
}

let child: ChildProcess | null = null
let restarts = 0
let nextId = 1
const pending = new Map<number, Pending>()

/** True once the voice has failed too often to be worth trying again. */
let givenUp = false

function fail(reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  pending.clear()
}

function start(device: string): ChildProcess | null {
  let kokoroPath: string
  let transformersPath: string
  try {
    kokoroPath = require.resolve('kokoro-js')
    transformersPath = require.resolve('@huggingface/transformers')
  } catch {
    givenUp = true
    return null
  }

  const scriptPath = join(app.getPath('userData'), 'tts-host.js')
  const cacheDir = join(app.getPath('userData'), 'models', 'onnx')
  try {
    // Whatever the probe cleared for this machine. On a GPU that failed the
    // probe this is 'cpu', which is slower but does not take processes with it.
    writeFileSync(scriptPath, childScript(kokoroPath, transformersPath, cacheDir, device))
  } catch {
    givenUp = true
    return null
  }

  const spawned = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  })

  let out = ''
  spawned.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString()
    let index: number
    while ((index = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, index)
      out = out.slice(index + 1)
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line) as {
          id: number
          ok: boolean
          audio?: string
          text?: string
          error?: string
        }
        const entry = pending.get(message.id)
        if (!entry) continue
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.ok) entry.resolve({ audio: message.audio, text: message.text })
        else entry.reject(new Error(message.error ?? 'The on-device speech model failed.'))
      } catch {
        // A partial or malformed line is not worth tearing anything down for.
      }
    }
  })

  spawned.on('exit', (code, signal) => {
    // This is the case the whole file exists for. It is expected, it is not an
    // error in the app, and the only thing that matters is that Nimbus is
    // still running to notice it.
    console.warn(`[speech] voice process exited (code ${code}, signal ${signal})`)
    child = null
    fail('The on-device voice stopped; using the cloud voice for this one.')
    restarts += 1
    if (restarts >= MAX_RESTARTS) {
      givenUp = true
      console.warn('[speech] giving up on the on-device voice for this session')
    }
  })

  spawned.on('error', () => {
    child = null
    givenUp = true
    fail('The on-device voice could not be started.')
  })

  console.log('[speech] voice process started')
  return spawned
}

/** Whether it is still worth asking the on-device models for anything. */
export function localVoiceAvailable(): boolean {
  return !givenUp
}

/**
 * Speaks one line, out of process.
 *
 * Rejects rather than throwing anything exotic, so the caller's existing
 * fallback to Edge covers a crash exactly as it already covers a load failure.
 */
async function request(payload: Record<string, unknown>): Promise<Reply> {
  if (givenUp) throw new Error('The on-device speech models are unavailable.')

  if (!child) {
    const backend = await usableBackend()
    child = start(backend)
    if (!child) throw new Error('The on-device speech process could not be started.')
  }

  const id = nextId++
  return new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('The on-device speech model took too long.'))
    }, REQUEST_TIMEOUT_MS)

    pending.set(id, { resolve, reject, timer })
    try {
      child?.stdin?.write(`${JSON.stringify({ id, ...payload })}\n`)
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      reject(new Error('The on-device speech process is not accepting work.'))
    }
  })
}

/** Speaks one line, out of process. */
export async function speakOutOfProcess(text: string, voice: string): Promise<Buffer> {
  const reply = await request({ kind: 'speak', text, voice })
  if (!reply.audio) throw new Error('The on-device voice returned nothing.')
  return Buffer.from(reply.audio, 'base64')
}

/**
 * Transcribes 16kHz mono samples, out of process.
 *
 * Whisper crashes the same way Kokoro does - measured, the seventh
 * transcription in a row killed the process - so it shares the same child and
 * its failures fall back to the cloud transcriber exactly as before.
 */
export async function transcribeOutOfProcess(
  pcm: Float32Array,
  language?: string
): Promise<string> {
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const reply = await request({ kind: 'transcribe', pcm: bytes.toString('base64'), language })
  return reply.text ?? ''
}

/** Stops the child, for shutdown. */
export function stopSpeechHost(): void {
  child?.stdin?.end()
  child?.kill()
  child = null
}
