import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AiChoice, AiProvider } from '../shared/types'

/**
 * Which model answers questions. Stored beside the keys rather than in
 * `config.json`, because `config.json` is checked into the repo and this is a
 * per-machine choice that depends on which key you happen to have.
 *
 * Environment variables still win, for the same reason they do for keys: a
 * developer setting `GEMINI_MODEL` expects that to be what runs.
 */

// Local by default: Nimbus should work the moment it is installed, without
// asking for a key first.
const DEFAULTS: AiChoice = { provider: 'local', model: '' }

let cache: AiChoice | null = null

function path(): string {
  return join(app.getPath('userData'), 'ai-choice.json')
}

export function getAiChoice(): AiChoice {
  if (cache) return cache
  try {
    if (existsSync(path())) {
      const parsed = JSON.parse(readFileSync(path(), 'utf8')) as Partial<AiChoice>
      cache = {
        provider: (parsed.provider as AiProvider) ?? DEFAULTS.provider,
        model: typeof parsed.model === 'string' ? parsed.model : DEFAULTS.model
      }
      return cache
    }
  } catch (err) {
    console.error('[ai] could not read the model choice:', err)
  }
  cache = { ...DEFAULTS }
  return cache
}

export function setAiChoice(choice: AiChoice): void {
  cache = { provider: choice.provider, model: choice.model }
  try {
    const temp = `${path()}.tmp`
    writeFileSync(temp, JSON.stringify(cache), 'utf8')
    renameSync(temp, path())
  } catch (err) {
    console.error('[ai] could not save the model choice:', err)
  }
  applyAiChoice()
}

/**
 * Names `.env` supplied at startup. Recorded once, because after the first
 * `applyAiChoice` the variables are set either way and there'd be no way to
 * tell an environment value from one we wrote ourselves — which would make
 * the setting appear to save and then do nothing.
 */
const envLocked = new Set<string>()
let captured = false

function captureEnvironment(): void {
  if (captured) return
  captured = true
  for (const name of ['NIMBUS_PROVIDER', 'NIMBUS_MODEL', 'GEMINI_MODEL']) {
    if (process.env[name]) envLocked.add(name)
  }
}

/** True when `.env` pins the model, so the settings panel can say so. */
export function aiChoiceLockedByEnv(): boolean {
  captureEnvironment()
  return envLocked.has('NIMBUS_PROVIDER') || envLocked.has('NIMBUS_MODEL')
}

/**
 * Publishes the choice through environment variables the model client reads,
 * so nothing downstream has to know settings exist. Anything `.env` set is
 * left alone.
 */
export function applyAiChoice(): void {
  captureEnvironment()
  const choice = getAiChoice()
  if (!envLocked.has('NIMBUS_PROVIDER')) process.env.NIMBUS_PROVIDER = choice.provider
  if (!envLocked.has('NIMBUS_MODEL') && !envLocked.has('GEMINI_MODEL')) {
    if (choice.model) process.env.NIMBUS_MODEL = choice.model
    else delete process.env.NIMBUS_MODEL
  }
}
