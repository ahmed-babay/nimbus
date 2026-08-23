import { app } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Llama, LlamaChatSession, LlamaContext, LlamaModel } from 'node-llama-cpp'
import type { LlmRequest } from './llm'

/** The shape node-llama-cpp wants for prior turns. */
type ChatTurn =
  | { type: 'system'; text: string }
  | { type: 'user'; text: string }
  | { type: 'model'; response: string[] }

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
 * Deep research still goes to a cloud model. Synthesising twenty thousand
 * characters of search results is the one task where a small model's fluent,
 * shallow and occasionally wrong answer costs the most, and it is also more
 * reading than the on-device context window holds.
 */

/**
 * The models that can run on the user's own machine, best first.
 *
 * Measured on an RTX 3070 laptop over seventeen routing utterances, through
 * the two-pass router with a JSON grammar:
 *
 *                          intent            parameters        VRAM at 8k
 *   Qwen3-VL-4B-Instruct   17/17    543ms    15/15   1,278ms      5.5 GB
 *   Qwen3.5-0.8B           16/17  1,404ms    12/15   1,663ms      2.7 GB
 *
 * The larger model is both more accurate and faster, which is not the usual
 * trade and is worth explaining. A routed turn is dominated by reading the
 * prompt, not writing the answer — 3,800 tokens in against about a hundred
 * out — and on that work the 4B keeps the GPU busy while the 0.8B is
 * latency-bound on matrices too small to fill it.
 *
 * Accuracy is the better reason. Asked "when is the next train to Frankfurt",
 * the 0.8B's parameter pass set the destination to "transit", invented a
 * starting station the user had not named — the one thing that section of the
 * prompt explicitly forbids — and copied an example out of the prompt into
 * params.topic. Those turns reach the right handler and then do the wrong
 * thing, which is worse than not answering.
 *
 * The small model stays for machines that cannot hold the large one.
 */
interface LocalModel {
  file: string
  url: string
  /**
   * Dedicated VRAM the machine needs before this is the right choice. The 4B
   * wants 5.5GB for itself at an 8k context, and Whisper and Kokoro want
   * about 1.1GB more while it is loaded.
   */
  needsVramBytes: number
  /** A file much smaller than this is a truncated download, not a model. */
  minBytes: number
}

const LOCAL_MODELS: LocalModel[] = [
  {
    file: 'Qwen3-VL-4B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3-VL-4B-Instruct-Q4_K_M.gguf',
    needsVramBytes: 7_000_000_000,
    minBytes: 2_000_000_000
  },
  {
    file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
    needsVramBytes: 0,
    minBytes: 400_000_000
  }
]

/**
 * Unloaded after this long without a question, returning the RAM and the VRAM.
 *
 * Measured with the 4B on an RTX 3070 laptop: resident it holds 4.02GB of VRAM
 * and 2.6GB of RAM, and disposing gives back 4.00GB of that — so the unload is
 * real, not nominal. Answering costs nothing beyond being resident (5.51GB
 * loaded, 5.53GB mid-answer), so the whole cost is occupancy.
 *
 * The reload is the other side, and it is dearer than it was: 12.8s for the
 * 4B against roughly 4s for the 0.8B this once held, and a warm page cache
 * barely helps because the time goes on uploading weights to the GPU rather
 * than reading them from disk. Five minutes is the compromise — long enough
 * that a conversation never pays it, short enough that a game started after
 * lunch finds the card empty.
 */
const IDLE_UNLOAD_MS = 5 * 60 * 1000

/**
 * How much the local model is given to read and write in one turn.
 *
 * A cloud model's limit is so far above anything this app sends that callers
 * were written as though there were none. The local model's is not, and it is
 * the one number that turns a working feature into a failing one: a
 * forty-minute meeting summarised in 24,000-character sections is roughly
 * 7,000 English tokens, or nearer 10,000 in German, against a window that has
 * to hold the system prompt and the answer as well.
 *
 * Callers ask for the budget rather than assuming one — see
 * `localInputBudgetChars`.
 *
 * Sized against the router prompt, which is the largest thing sent on a normal
 * turn at about 3,800 tokens, plus history and the answer. Every extra 1,024
 * tokens costs real VRAM on a card shared with the desktop — measured on the
 * 4B, 8,192 wanted 4.03GB against 3.73GB at 6,144 — and nothing in a routed
 * turn used the difference.
 */
const CONTEXT_TOKENS = 6144

/**
 * Flash attention, which is smaller *and* faster here — not the usual trade.
 *
 * Measured on the 4B at an 8k context: 4.31GB of VRAM and 2,674ms per intent
 * without it, 4.03GB and 1,656ms with. The KV cache is never materialised in
 * full, so the memory it would have occupied is never allocated and the reads
 * that would have walked it never happen.
 *
 * "auto" rather than true: llama.cpp turns it off for the few model
 * architectures whose attention it cannot fuse, and a model that refuses to
 * load is worse than one that uses more memory.
 */
const FLASH_ATTENTION = 'auto' as const

/**
 * Characters of *input* a caller may send in one turn.
 *
 * Deliberately pessimistic on both counts. Three characters per token is
 * roughly what German with compound nouns and place names costs — English is
 * nearer four, so English simply gets extra headroom rather than a different
 * rule. A third of the window is then held back for the system prompt and the
 * model's own answer, which for a summary is not small.
 */
export function localInputBudgetChars(): number {
  return Math.floor(CONTEXT_TOKENS * 3 * 0.66)
}

/**
 * Qwen3.5 reasons before answering unless told not to, and on a 0.8B model
 * that is a disaster for an assistant: a plain "what is the capital of
 * Germany" spent its entire token budget thinking and returned an empty
 * string. Every call here disables it.
 *
 * Kept for whichever model is loaded. The 4B is an instruct build and does not
 * reason unprompted, so this is a no-op there — but it costs nothing, and the
 * small model is still what a machine without the VRAM for the large one runs.
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

function pathFor(model: LocalModel): string {
  return join(app.getPath('userData'), 'models', model.file)
}

/**
 * True when the file is there and large enough to be the whole model. A
 * download cut off by a closed laptop leaves a file that loads far enough to
 * fail confusingly, so size is checked rather than existence.
 */
function isInstalled(model: LocalModel): boolean {
  try {
    return statSync(pathFor(model)).size >= model.minBytes
  } catch {
    return false
  }
}

/** The best model actually on disk, or null. */
function installedModel(): LocalModel | null {
  return LOCAL_MODELS.find(isInstalled) ?? null
}

/**
 * Which model this machine should fetch.
 *
 * `getVramState().total` is every device summed — on this laptop it reports
 * 16.86GB across a discrete 3070 and the shared pool the integrated Intel
 * chip draws from, which would happily talk a 6GB card into the 4B. Taking
 * the unified portion out leaves 8.41GB, which is the card. A machine with
 * only integrated graphics is then correctly measured as having almost no
 * dedicated memory of its own and gets the small model.
 */
export async function chooseModelToDownload(): Promise<LocalModel> {
  const smallest = LOCAL_MODELS[LOCAL_MODELS.length - 1]
  try {
    const { getLlama, LlamaLogLevel } = await import('node-llama-cpp')
    const llama = await getLlama({ gpu: 'auto', logLevel: LlamaLogLevel.error })
    const vram = await llama.getVramState()
    const dedicated = Math.max(0, vram.total - (vram.unifiedSize ?? 0))
    const chosen = LOCAL_MODELS.find((model) => dedicated >= model.needsVramBytes) ?? smallest
    console.log(
      `[local-llm] ${(dedicated / 1e9).toFixed(1)}GB dedicated VRAM -> ${chosen.file}`
    )
    return chosen
  } catch (error) {
    // No GPU, no driver, or the binding wouldn't load. All of those mean the
    // large model would run on the CPU, where it is the wrong choice anyway.
    console.warn('[local-llm] could not measure VRAM, taking the small model:', error)
    return smallest
  }
}

/**
 * Where the model is. The installed one if there is one, so a machine that
 * already has the small model keeps using it rather than reporting itself
 * empty and asking for a 2.3GB download it may not want.
 */
export function localModelPath(): string {
  const override = process.env.NIMBUS_LOCAL_MODEL
  if (override) return override
  return pathFor(installedModel() ?? LOCAL_MODELS[0])
}

export function localModelAvailable(): boolean {
  if (process.env.NIMBUS_LOCAL_MODEL) return existsSync(process.env.NIMBUS_LOCAL_MODEL)
  return installedModel() !== null
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

/**
 * Told how far along a load is, so the overlay can say so.
 *
 * Loading takes seconds, not milliseconds, and it happens on the first
 * question after a cold start or an idle unload. Without this the overlay sat
 * silent through all of it and then — if the rest of the turn pushed past the
 * 25-second deadline — blamed the network. A bar is the honest version.
 */
export type LoadListener = (state: { active: boolean; progress: number }) => void

let loadListener: LoadListener | null = null

export function onLocalModelLoad(listener: LoadListener | null): void {
  loadListener = listener
}

function reportLoad(active: boolean, progress: number): void {
  try {
    loadListener?.({ active, progress })
  } catch {
    // A listener that throws must not take the load down with it.
  }
}

/**
 * True while weights are being read, so a caller can decide whether to wait.
 * `warmLocalModel` uses it to avoid stacking a second load on the first.
 */
export function localModelLoading(): boolean {
  return loading !== null
}

export function localModelReady(): boolean {
  return loaded !== null
}

/**
 * Starts loading without asking anything, and resolves when it is usable.
 *
 * Called when the overlay opens rather than when the first question arrives:
 * the user then spends a second or two speaking and another being transcribed,
 * and the load happens underneath that instead of after it. On a warm model
 * this returns immediately and costs nothing.
 */
export async function warmLocalModel(): Promise<void> {
  // Read straight from the environment rather than calling activeProvider,
  // which lives in llm.ts and imports this module — a value import back would
  // make the cycle real rather than type-only.
  if (process.env.NIMBUS_PROVIDER !== 'local') return
  if (loaded || loading || !localModelAvailable()) return
  try {
    await load()
  } catch (error) {
    // Nothing is waiting on this yet — the real question will report the
    // failure properly when it arrives.
    console.warn('[local-llm] warm-up failed:', error)
  }
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
    reportLoad(true, 0)

    const llama = await getLlama({
      // CPU deliberately — see the note at the top of this file.
      gpu: process.env.NIMBUS_LOCAL_GPU === 'false' ? false : 'auto',
      logLevel: LlamaLogLevel.error
    })
    const model = await llama.loadModel({
      modelPath: path,
      // Fit the layers to the VRAM that is actually free, and tell it the
      // context we are really going to create.
      //
      // The default is "auto", which sizes itself against a context of "auto"
      // — not against the one asked for a line later. Asking for 8,192 after
      // it had planned for something smaller is how the card ends up
      // oversubscribed, and an oversubscribed card on Windows does not fail:
      // it starts moving GPU memory over PCIe, and the whole desktop stutters
      // with it. Sharing 8GB with the compositor, a browser and two speech
      // models leaves no room for that guess to be wrong.
      gpuLayers: { fitContext: { contextSize: CONTEXT_TOKENS } },
      // Reading the weights is nearly all of the wait, so its progress is
      // most of the bar. The context that follows gets the last tenth.
      onLoadProgress: (fraction) => reportLoad(true, Math.min(0.9, fraction * 0.9))
    })
    const context = await model.createContext({
      contextSize: CONTEXT_TOKENS,
      flashAttention: FLASH_ATTENTION
    })
    reportLoad(true, 1)

    const { LlamaChatSession } = await import('node-llama-cpp')
    const session = new LlamaChatSession({ contextSequence: context.getSequence() })

    console.log(`[local-llm] ready in ${Date.now() - started}ms (${basename(path)})`)
    loaded = { llama, model, context, session }
    return loaded
  })()

  try {
    return await loading
  } finally {
    loading = null
    reportLoad(false, 1)
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

/**
 * Splits the request into the chat turns the model's own template expects,
 * plus the single message it should answer now.
 *
 * These used to be flattened into one user message as a "User: ... Assistant:
 * ..." transcript, which was a bad mistake: a base-style model handed a script
 * continues the script. Asked for Tesla news mid-conversation it wrote itself
 * a scene — "I am just checking my phone... the sun is setting over the city"
 * — because completing a transcript is exactly what the input asked for.
 * Real turns let the chat template mark the roles, so the model answers the
 * last message instead of writing the next line of a play.
 */
function buildTurns(request: LlmRequest): { history: ChatTurn[]; prompt: string } {
  const messages = request.messages
  const history: ChatTurn[] = []

  for (const message of messages.slice(0, -1)) {
    if (message.role === 'user') history.push({ type: 'user', text: message.text })
    else history.push({ type: 'model', response: [message.text] })
  }

  return { history, prompt: messages[messages.length - 1]?.text ?? '' }
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
async function beginTurn(system: string, history: ChatTurn[]): Promise<LlamaChatSession> {
  const { session } = await load()

  // Deliberately not `resetChatHistory()`, which throws away the sequence's
  // evaluated state: setting the history explicitly lets llama.cpp keep
  // whatever prefix still matches.
  const turns: ChatTurn[] = system ? [{ type: 'system', text: system }, ...history] : [...history]
  session.setChatHistory(turns as Parameters<typeof session.setChatHistory>[0])

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

/**
 * Refuses a request carrying an image, for both entry points.
 *
 * Vision needs the mmproj projector loaded alongside the weights. The model
 * itself can see — Qwen3-VL is a vision model and its projector is published —
 * but node-llama-cpp 3.20.0 has no way to load one: LlamaModelOptions has no
 * mmproj field, and llama.cpp's vision support lives behind libmtmd, which
 * these bindings do not expose. Running llama.cpp's own server binary as a
 * child process would work, and is how the speech models are already isolated,
 * at the cost of shipping that binary.
 *
 * This lived only in `localComplete` and that was the whole bug: screen
 * questions are asked with a stream handler, so they went through
 * `localStreamComplete`, which dropped the image and answered from the
 * question text alone. Asked "what does this say", the model replied "Yes, I
 * can see the screenshot you sent" and invented an error dialog, while the
 * actual capture was a flight itinerary. A confident answer about a screen
 * nobody looked at is far worse than a refusal, so both paths refuse.
 */
function refuseImages(request: LlmRequest): void {
  if (!request.image) return
  throw new Error(
    'The on-device model cannot read images yet. Pick a cloud provider in settings for screen questions.'
  )
}

export async function localComplete(request: LlmRequest): Promise<string> {
  refuseImages(request)

  const { history, prompt } = buildTurns(request)

  return enqueue(async () => {
    const session = await beginTurn(request.system ?? '', history)
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
  refuseImages(request)

  const { history, prompt } = buildTurns(request)

  return enqueue(async () => {
    const session = await beginTurn(request.system ?? '', history)
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
