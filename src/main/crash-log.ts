import { app } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A crash always looks the same from the tray: the app was there, then it
 * wasn't. `console.error` alone answers nothing once that happens, because a
 * packaged build has no terminal attached to have shown it — the log line
 * that would explain *why* was written into a window that no longer exists.
 *
 * Written on its own line per event, to userData rather than next to the
 * binary, so it survives an update and doesn't need install-directory write
 * access. Kept deliberately dumb: appendFileSync, no rotation, no library —
 * this only has to survive long enough to be read once after the fact.
 */
const LOG_PATH = join(app.getPath('userData'), 'crash.log')

/**
 * A dev server owns stdout/stderr through pipes. If that server is stopped
 * while Electron is still winding down, the next console write raises EPIPE.
 * Letting that reach `uncaughtException` is especially dangerous here: the
 * exception handler logs with `console.error`, which writes to the same broken
 * pipe and recursively raises EPIPE until the main process hangs.
 *
 * Stream errors are not application errors, so consume them at the stream.
 * Once stderr breaks, the file remains the crash logger's only destination.
 */
let stderrBroken = false
process.stdout.on('error', () => {})
process.stderr.on('error', () => {
  stderrBroken = true
})

let writingCrash = false

export function logCrashEvent(line: string): void {
  if (writingCrash) return
  writingCrash = true
  const stamped = `${new Date().toISOString()} ${line}\n`
  try {
    appendFileSync(LOG_PATH, stamped)
  } catch {
    // The log is a courtesy, not a dependency. In particular, do not report
    // this failure through console.error: stderr may be the thing that failed.
  }

  if (!stderrBroken) {
    try {
      process.stderr.write(`[crash-log] ${line}\n`)
    } catch {
      stderrBroken = true
    }
  }
  writingCrash = false
}

export function crashLogPath(): string {
  return LOG_PATH
}
