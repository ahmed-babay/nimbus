import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretName, SecretStatus } from '../shared/types'

/**
 * API keys entered through the settings panel, for people who never want to
 * see a `.env` file.
 *
 * Two rules shape this:
 *
 * 1. **`.env` always wins.** A key set in the environment is what a developer
 *    expects to be running; the stored value only fills gaps. That also makes
 *    the setting panel safe to open on a machine that is already configured —
 *    it can't silently shadow the real key.
 *
 * 2. **Stored keys are encrypted at rest** via Electron's `safeStorage`, which
 *    on Windows is DPAPI tied to the user account. Plain JSON would be worse
 *    than the `.env` file it replaces: `.env` is at least gitignored and
 *    obviously secret-shaped, whereas a settings file gets copied around.
 *
 * Once loaded, keys are pushed into `process.env` and every service keeps
 * reading `process.env.X` exactly as before — no service needs to know this
 * module exists.
 */

export const SECRET_NAMES = [
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'TAVILY_API_KEY',
  'OPENWEATHER_API_KEY',
  'GNEWS_API_KEY',
  'GITHUB_TOKEN',
  // Stocks quietly used a slower path without this, and Settings had no way
  // to supply it — the only route in was a .env the installed build cannot see.
  'FINNHUB_API_KEY'
] as const

interface SecretFile {
  version: 1
  /** Base64 of the safeStorage-encrypted value, keyed by name. */
  values: Partial<Record<SecretName, string>>
}

let cache: SecretFile | null = null
/** Names that came from the environment, so the UI can say they're locked. */
const fromEnvironment = new Set<SecretName>()

function path(): string {
  return join(app.getPath('userData'), 'secrets.dat')
}

function load(): SecretFile {
  if (cache) return cache
  try {
    if (existsSync(path())) {
      const parsed = JSON.parse(readFileSync(path(), 'utf8')) as Partial<SecretFile>
      cache = { version: 1, values: parsed.values ?? {} }
      return cache
    }
  } catch (err) {
    console.error('[secrets] could not read store, starting empty:', err)
  }
  cache = { version: 1, values: {} }
  return cache
}

function save(): void {
  if (!cache) return
  try {
    const temp = `${path()}.tmp`
    writeFileSync(temp, JSON.stringify(cache), 'utf8')
    renameSync(temp, path())
  } catch (err) {
    console.error('[secrets] could not write store:', err)
  }
}

function decrypt(encoded: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch (err) {
    // A store copied from another machine or user account cannot be decrypted;
    // that's expected, not a crash.
    console.error('[secrets] could not decrypt a stored key:', err)
    return null
  }
}

/**
 * Called once at startup, before anything reads a key. Records which names the
 * environment already supplied, then fills the rest from the encrypted store.
 */
export function applyStoredSecrets(): void {
  for (const name of SECRET_NAMES) {
    if (process.env[name]) fromEnvironment.add(name)
  }

  const store = load()
  let applied = 0
  for (const name of SECRET_NAMES) {
    if (fromEnvironment.has(name)) continue
    const encoded = store.values[name]
    if (!encoded) continue
    const value = decrypt(encoded)
    if (!value) continue
    process.env[name] = value
    applied++
  }
  if (applied > 0) console.log(`[secrets] loaded ${applied} key(s) from settings`)
}

/**
 * Saves (or clears, with an empty value) a key. Applied to `process.env`
 * immediately so it takes effect on the next question rather than the next
 * launch — being told to restart after typing a key is a poor first run.
 */
export function setSecret(name: SecretName, value: string): { ok: boolean; error?: string } {
  if (!SECRET_NAMES.includes(name)) return { ok: false, error: 'Unknown key.' }
  if (fromEnvironment.has(name)) {
    return { ok: false, error: 'That key is set in your .env file, which takes precedence.' }
  }

  const store = load()
  const trimmed = value.trim()

  if (!trimmed) {
    delete store.values[name]
    delete process.env[name]
    save()
    return { ok: true }
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      error: 'This system has no secure storage available, so keys cannot be saved safely.'
    }
  }

  store.values[name] = safeStorage.encryptString(trimmed).toString('base64')
  process.env[name] = trimmed
  save()
  return { ok: true }
}

/** What the settings panel shows: never the key itself, only its state. */
export function secretStatuses(): SecretStatus[] {
  const store = load()
  return SECRET_NAMES.map((name) => {
    const env = fromEnvironment.has(name)
    const stored = Boolean(store.values[name])
    return {
      name,
      set: env || stored,
      source: env ? 'env' : stored ? 'settings' : 'none',
      // Enough to recognise which key is in there, useless to anyone else.
      hint: env || !stored ? null : maskedHint(name)
    }
  })
}

function maskedHint(name: SecretName): string | null {
  const value = process.env[name]
  if (!value) return null
  return value.length <= 8 ? '••••' : `${value.slice(0, 3)}••••${value.slice(-4)}`
}
