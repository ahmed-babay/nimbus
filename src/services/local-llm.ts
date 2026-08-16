import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Llama, LlamaChatSession, LlamaContext, LlamaModel } from 'node-llama-cpp'
import type { LlmRequest } from './llm'

/**
 * The model that runs on your own machine.
 *
 * Nimbus is meant to sit in the tray all day on a laptop that is also running
 * Chrome, Teams, Cursor, Discord and sometimes a game. That single fact
 * decides almost every choice in this file, and it is not the choice you would
 * make if the assistant were the only thing running.
 *
 * **It uses the GPU while in use, and unloads when it isn't.** The intent was
 * to stay on the CPU so nothing ever competed with a game for VRAM, and on
 * throughput alone that would have been fine: 15.6 tok/s beats the ~4 tok/s a
 * voice speaks at, so a spoken answer is never waiting on the model.
 *
 * Routing is what killed it. Measured on an RTX 3070 laptop, a single
 * schema-constrained classification took 3.5-4.5s on the CPU against 34ms to
 * first token on Vulkan — and that was with a far shorter system prompt than
 * the real router's. Most of the cost is prompt processing, which is exactly
 * what the CPU is worst at, and it lands on every single utterance before any
 * work begins. A four-second pause before the assistant even knows what you
 * asked is not something throughput can make up for.
 *
 * So the trade is made in time rather than in hardware: the GPU is used while
 * you are actually talking to Nimbus, and the model is unloaded entirely after
 * a few minutes of silence. A game started later finds the VRAM already
 * returned. Set NIMBUS_LOCAL_GPU=false to force CPU on a machine where that
 * trade is wrong.
 *
 * Deep research still goes to a cloud model. A 0.8B model asked to synthesise
 * twenty thousand characters of search results produces fluent, shallow and
 * occasionally wrong answers, and that is the one task where being wrong
 * matters most.
 */

/** Where a bundled or downloaded model lives. */
const MODEL_FILE = 'Qwen3.5-0.8B-Q4_K_M.gguf'

/**
 * Unloaded after this long without a question, returning both the ~1GB of RAM
 * and the VRAM. Short, because holding VRAM is the expensive part: the cost of
 * being wrong is one ~4s reload on the next question, and the cost of holding
 * on is a game that stutters.
 */
const IDLE_UNLOAD_MS = 5 * 60 * 1000

/**
 * Qwen3.5 reasons before answering unless told not to, and on a 0.8B model
 * that is a disaster for an assistant: a plain "what is the capital of
 * Germany" spent its entire token budget thinking and returned an empty
 * string. Every call here disables it.
 */
const NO_THINKING = { budgets: { thoughtTokens: 0 } } as const

interface Loaded {
  llama: Llama
  model: LlamaModel
  context: LlamaContext
  /**
   * One session for the whole process, reset between turns. A context owns a
   * small fixed pool of sequences and disposing a session does not reliably
   * hand its sequence back — taking a fresh one per turn failed with "No
   * sequences left" on the second question. Reusing one also skips
   * re-allocating a sequence on every utterance.
   */
  session: LlamaChatSession
}

let loaded: Loaded | null = null
let loading: Promise<Loaded> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

export function localModelPath(): string {
  const override = process.env.NIMBUS_LOCAL_MODEL
  if (override) return override
  return join(app.getPath('userData'), 'models', MODEL_FILE)
}

export function localModelAvailable(): boolean {
  return existsSync(localModelPath())
}

function scheduleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void unloadLocalModel(), IDLE_UNLOAD_MS)
}

export async function unloadLocalModel(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const current = loaded
  loaded = null
  if (!current) return
  // Disposed innermost first; a context outliving its model crashes the
  // native side rather than throwing.
  await current.context.dispose().catch(() => {})
  await current.model.dispose().catch(() => {})
  console.log('[local-llm] unloaded after idle')
}

async function load(): Promise<Loaded> {
  if (loaded) return loaded
  if (loading) return loading

  loading = (async () => {
    const path = localModelPath()
    if (!existsSync(path)) {
      throw new Error(
        'The local model is not installed yet. Open settings to download it, or choose a cloud provider.'
      )
    }

    // Imported lazily so the native binding is only touched when the local
    // provider is actually used — a cloud-only setup never pays for it.
    const { getLlama, LlamaLogLevel } = await import('node-llama-cpp')
    const started = Date.now()

    const llama = await getLlama({
      // CPU deliberately — see the note at the top of this file.
      gpu: process.env.NIMBUS_LOCAL_GPU === 'false' ? false : 'auto',
      logLevel: LlamaLogLevel.error
    })
    const model = await llama.loadModel({ modelPath: path })
    // 4096 is enough for a routed turn with conversation history and a
    // screenshot description. Larger contexts cost memory that this app has
    // already decided it would rather not hold.
    const context = await model.createContext({ contextSize: 4096 })

    const { LlamaChatSession } = await import('node-llama-cpp')
    const session = new LlamaChatSession({ contextSequence: context.getSequence() })

    console.log(`[local-llm] ready in ${Date.now() - started}ms (${MODEL_FILE})`)
    loaded = { llama, model, context, session }
    return loaded
  })()

  try {
    return await loading
  } finally {
    loading = null
  }
}

/**
 * Gemini writes schemas in SCREAMING type names; JSON Schema, which
 * llama.cpp's grammar compiler wants, uses lowercase. Converting is what lets
 * every existing caller's schema work unchanged against a local model.
 */
function toJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      converted.type = value.toLowerCase()
    } else if (key === 'properties' && value && typeof value === 'object') {
      const properties: Record<string, unknown> = {}
      for (const [name, definition] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = toJsonSchema(definition as Record<string, unknown>)
      }
      converted.properties = properties
    } else if (key === 'items' && value && typeof value === 'object') {
      converted.items = toJsonSchema(value as Record<string, unknown>)
    } else {
      converted[key] = value
    }
  }

  return converted
}

function buildPrompt(request: LlmRequest): { system: string; prompt: string } {
  const history = request.messages
    .slice(0, -1)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n')

  const last = request.messages[request.messages.length - 1]?.text ?? ''
  return {
    system: request.system ?? '',
    prompt: history ? `${history}\nUser: ${last}` : last
  }
}

/**
 * Serialises every local call. One model, one context, one sequence — two
 * prompts in flight at once would corrupt each other's state, and the overlay
 * can genuinely issue a routing call and a follow-up close together.
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work)
  // Keeps the chain alive after a rejection, so one failed turn cannot wedge
  // every turn after it.
  queue = result.catch(() => undefined)
  return result
}

/**
 * Prepares the shared session for a turn. Nimbus manages its own conversation
 * history, so the model's is cleared each time rather than allowed to grow.
 */
async function beginTurn(system: string): Promise<LlamaChatSession> {
  const { session } = await load()
  session.resetChatHistory()
  if (system) session.setChatHistory([{ type: 'system', text: system }])
  return session
}

/**
 * llama.cpp's JSON grammar drives the model into an object by emitting the
 * opening tokens itself, and those tokens are not always included in what
 * comes back: the same schema returned a clean `{"intent": ...}` for some
 * utterances and a headless `intent": ...}` for others. Rather than assume
 * which prefix went missing, the candidates are tried in order and the first
 * one that actually parses wins.
 */
function repairJson(text: string): string {
  const trimmed = text.trim()
  const candidates = [trimmed, `{"${trimmed}`, `{${trimmed}`, `["${trimmed}`, `[${trimmed}`]

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // Try the next shape.
    }
  }
  // Nothing parsed — hand back the original so the caller's own error path
  // reports what the model actually said.
  return trimmed
}

export async function localComplete(request: LlmRequest): Promise<string> {
  if (request.image) {
    // Vision needs the mmproj projector loaded alongside the model. The
    // weights support it; this path does not yet, and silently answering a
    // screen question without looking at the screen would be worse than
    // saying so.
    throw new Error('The local model cannot read images yet. Switch to a cloud provider for that.')
  }

  const { system, prompt } = buildPrompt(request)

  return enqueue(async () => {
    const session = await beginTurn(system)
    const options: Record<string, unknown> = {
      ...NO_THINKING,
      temperature: request.temperature ?? 0.7
    }

    if (request.jsonSchema) {
      const { llama } = await load()
      // Constrained decoding: the grammar makes invalid JSON unrepresentable
      // rather than merely discouraged. This is a stronger guarantee than any
      // of the cloud providers' JSON modes.
      options.grammar = await llama.createGrammarForJsonSchema(
        // Converted from Gemini's schema dialect above; the grammar compiler's
        // type is far narrower than what callers hand us.
        toJsonSchema(request.jsonSchema) as Parameters<typeof llama.createGrammarForJsonSchema>[0]
      )
    }

    const answer = await session.prompt(prompt, options)
    scheduleUnload()
    return request.jsonSchema ? repairJson(answer) : answer
  })
}

export async function localStreamComplete(
  request: LlmRequest,
  onChunk: (text: string) => void
): Promise<string> {
  const { system, prompt } = buildPrompt(request)

  return enqueue(async () => {
    const session = await beginTurn(system)
    const answer = await session.prompt(prompt, {
      ...NO_THINKING,
      temperature: request.temperature ?? 0.7,
      onResponseChunk: (chunk) => {
        // Reasoning segments are suppressed above, but guard anyway so a
        // model that ignores the budget can't leak its scratchpad into the
        // spoken answer.
        if (chunk.type === 'segment' && chunk.segmentType === 'thought') return
        if (chunk.text) onChunk(chunk.text)
      }
    })

    scheduleUnload()
    return answer
  })
}
