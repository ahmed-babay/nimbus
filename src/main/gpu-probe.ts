import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { vadModelPath } from '../services/vad'

/**
 * Finds out whether this machine's GPU can actually run ONNX, without betting
 * the app on the answer.
 *
 * A WebGPU or DirectML failure inside onnxruntime-node is not a JS exception.
 * A bad driver takes the process down with it — no throw, no catch, no log,
 * the window just disappears. That is one bug wearing two masks: on machines
 * where it happens during model load the speech models "don't work", and on
 * machines where it happens later the app "closes for no reason".
 *
 * So the first attempt happens somewhere expendable. A child process opens a
 * GPU session on a 2MB model; if it exits cleanly the driver is fine and the
 * real process can use the GPU, and if it dies we learn that at the cost of a
 * child instead of the whole app.
 *
 * The answer is cached, keyed to the Electron build, because it only changes
 * when drivers or Electron do.
 */

/** Generous: a cold GPU driver init on a slow laptop is genuinely slow. */
const PROBE_TIMEOUT_MS = 30_000

/** Runs that must all succeed before the GPU is trusted with the real process. */
const PROBE_ATTEMPTS = 2

/** What a healthy child prints. Anything else — including a crash — is a no. */
const PROBE_MARKER = 'nimbus-gpu-ok'

/**
 * Only two answers. DirectML is not among them: measured here it took 170
 * seconds to load Kokoro and then failed anyway, so "GPU but not WebGPU" is
 * not a useful state to be in — CPU is slower than WebGPU and far faster than
 * that.
 */
export type GpuBackend = 'webgpu' | 'cpu'

interface ProbeResult {
  backend: GpuBackend
  electron: string
  checkedAt: string
}

function cachePath(): string {
  return join(app.getPath('userData'), 'gpu-probe.json')
}

function readCache(): GpuBackend | null {
  try {
    const cached = JSON.parse(readFileSync(cachePath(), 'utf8')) as ProbeResult
    // A different Electron means a different bundled driver stack, so the old
    // answer says nothing about this one.
    if (cached.electron !== process.versions.electron) return null
    return cached.backend
  } catch {
    return null
  }
}

function writeCache(backend: GpuBackend): void {
  try {
    const result: ProbeResult = {
      backend,
      electron: process.versions.electron,
      checkedAt: new Date().toISOString()
    }
    writeFileSync(cachePath(), JSON.stringify(result, null, 2))
  } catch {
    // A cache we cannot write just means probing again next launch.
  }
}

/** The script the child runs. Written at runtime so nothing needs packaging. */
function probeScript(ortPath: string, modelPath: string, backend: GpuBackend): string {
  // Success is reported by printing a marker, not by the exit code.
  //
  // Tearing down a process that holds a WebGPU device crashes with
  // 0xC0000409 on this hardware whether you call process.exit() or let the
  // loop drain, and it does so *after* the session has opened and run
  // perfectly well. Judging by exit status therefore condemns machines whose
  // GPU is entirely fine. What matters is whether inference worked, so the
  // child says so out loud and the parent listens for that.
  return `
const ort = require(${JSON.stringify(ortPath)})
ort.InferenceSession.create(${JSON.stringify(modelPath)}, { executionProviders: [${JSON.stringify(backend)}] })
  .then(() => { process.stdout.write(${JSON.stringify(PROBE_MARKER)}) })
  .catch(() => {})
`
}

function tryBackend(backend: GpuBackend, ortPath: string, modelPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let scriptPath: string
    try {
      scriptPath = join(app.getPath('userData'), `gpu-probe-${backend}.js`)
      writeFileSync(scriptPath, probeScript(ortPath, modelPath, backend))
    } catch {
      return resolve(false)
    }

    // ELECTRON_RUN_AS_NODE turns our own binary into a plain Node, so the
    // child has exactly the runtime and native modules the real process does.
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })

    let said = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      said += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, PROBE_TIMEOUT_MS)

    child.on('exit', () => {
      clearTimeout(timer)
      // Deliberately not looking at the exit code — see probeScript.
      resolve(said.includes(PROBE_MARKER))
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

let probing: Promise<GpuBackend> | null = null

/**
 * The best backend this machine can be trusted with. Always resolves — 'cpu'
 * is the floor, and it works everywhere.
 */
export async function usableBackend(): Promise<GpuBackend> {
  const cached = readCache()
  if (cached) return cached
  if (probing) return probing

  probing = (async () => {
    const modelPath = vadModelPath()
    if (!existsSync(modelPath)) {
      // Nothing small to probe with yet. Don't cache this — the VAD model
      // downloads at startup, so the next launch will have one.
      console.log('[gpu] no probe model yet, using cpu for now')
      return 'cpu'
    }

    let ortPath: string
    try {
      ortPath = require.resolve('onnxruntime-node')
    } catch {
      return 'cpu'
    }

    // Twice, and both must pass. The failure this guards against is
    // intermittent — the same session on the same machine opened cleanly twice
    // and then died with 0xC0000409 — so a single green run proves very little
    // and the whole point is to not hand a flaky driver the real process.
    const started = Date.now()
    let ok = true
    for (let attempt = 0; attempt < PROBE_ATTEMPTS && ok; attempt++) {
      ok = await tryBackend('webgpu', ortPath, modelPath)
    }

    const backend: GpuBackend = ok ? 'webgpu' : 'cpu'
    if (ok) {
      console.log(`[gpu] webgpu verified in ${Date.now() - started}ms`)
    } else {
      console.warn(
        `[gpu] webgpu unusable here (${Date.now() - started}ms) — using cpu, which is slower but cannot take the app down`
      )
    }
    writeCache(backend)
    return backend
  })()

  try {
    return await probing
  } finally {
    probing = null
  }
}

/** Forces a re-probe, for when a user has updated their drivers. */
export function forgetGpuProbe(): void {
  try {
    writeFileSync(cachePath(), '{}')
  } catch {
    /* nothing to do */
  }
}
