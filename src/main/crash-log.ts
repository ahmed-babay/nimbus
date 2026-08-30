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

export function logCrashEvent(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`
  console.error(`[crash-log] ${line}`)
  try {
    appendFileSync(LOG_PATH, stamped)
  } catch (error) {
    // The log is a courtesy, not a dependency — a write failure here must
    // never be the reason the actual crash handling doesn't run.
    console.error('[crash-log] could not write crash.log:', error)
  }
}

export function crashLogPath(): string {
  return LOG_PATH
}
