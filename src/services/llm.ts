import { buildModel, withModelFallback } from './gemini-client'
import { httpFetch } from './http'
import type { AiProvider } from '../shared/types'

/**
 * One way to ask a question, whichever provider is configured.
 *
 * Everything upstream — intent routing, research synthesis, screen reading —
 * speaks this interface, so switching provider is a setting rather than a
 * rewrite. The prompts themselves are provider-independent already; only the
 * transport differs.
 *
 * Structured output is the one place the three genuinely diverge. Gemini
 * constrains generation to a schema, which is stronger than anything the
 * others expose, so it keeps using that. OpenAI is asked for JSON mode and
 * Anthropic is asked in the prompt, with the shape described either way — a
 * weaker guarantee, which is why every caller already tolerates a parse
 * failure by falling back to a plain chat answer.
 */

export interface LlmMessage {
  role: 'user' | 'model'
  text: string
}

export interface LlmRequest {
  system?: string
  /** The conversation so far, ending with what to answer now. */
  messages: LlmMessage[]
  /** Ask for JSON matching this Gemini-style schema. */
  jsonSchema?: Record<string, unknown>
  /** An image to look at, for screen questions. */
  image?: { base64: string; mimeType: string }
  temperature?: number
}

export function activeProvider(): AiProvider {
  const configured = process.env.NIMBUS_PROVIDER
  if (configured === 'openai' || configured === 'anthropic') return configured
  return 'gemini'
}

/** Default model per provider when the user hasn't picked one. */
const DEFAULT_MODEL: Record<AiProvider, string> = {
  gemini: '',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-5'
}

function modelFor(provider: AiProvider): string {
  return process.env.NIMBUS_MODEL || DEFAULT_MODEL[provider]
}

function requireKey(name: string, label: string): string {
  const key = process.env[name]
  if (!key) throw new Error(`${label} is not set. Add it in settings or your .env file.`)
  return key
}

// ---------------------------------------------------------------------------
// Gemini — keeps the existing dual-model race, which is tuned to its free tier
// ---------------------------------------------------------------------------

function geminiParts(request: LlmRequest): Array<Record<string, unknown>> {
  const last = request.messages[request.messages.length - 1]
  const parts: Array<Record<string, unknown>> = [{ text: last?.text ?? '' }]
  if (request.image) {
    parts.push({ inlineData: { mimeType: request.image.mimeType, data: request.image.base64 } })
  }
  return parts
}

function geminiConfig(request: LlmRequest): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {}
  if (request.temperature !== undefined) config.temperature = request.temperature
  if (request.jsonSchema) {
    config.responseMimeType = 'application/json'
    config.responseSchema = request.jsonSchema
  }
  return Object.keys(config).length > 0 ? config : undefined
}

/**
 * Earlier turns become Gemini `contents`; the final message is sent as the
 * prompt. Keeping them separate matters for the image case, where the picture
 * has to travel with the current question rather than the history.
 */
function geminiRequest(request: LlmRequest): Record<string, unknown> {
  const history = request.messages.slice(0, -1)
  const parts = geminiParts(request)
  if (history.length === 0) return { contents: [{ role: 'user', parts }] }
  return {
    contents: [
      ...history.map((message) => ({ role: message.role, parts: [{ text: message.text }] })),
      { role: 'user', parts }
    ]
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function openAiMessages(request: LlmRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  if (request.system) messages.push({ role: 'system', content: request.system })

  request.messages.forEach((message, index) => {
    const isLast = index === request.messages.length - 1
    const role = message.role === 'model' ? 'assistant' : 'user'
    if (isLast && request.image) {
      messages.push({
        role,
        content: [
          { type: 'text', text: message.text },
          {
            type: 'image_url',
            image_url: { url: `data:${request.image.mimeType};base64,${request.image.base64}` }
          }
        ]
      })
      return
    }
    messages.push({ role, content: message.text })
  })
  return messages
}

function openAiBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
  return {
    model: modelFor('openai'),
    messages: openAiMessages(request),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
    stream
  }
}

async function openAiCall(request: LlmRequest, stream: boolean): Promise<Response> {
  const key = requireKey('OPENAI_API_KEY', 'The OpenAI API key')
  const res = await httpFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    label: 'OpenAI',
    timeoutMs: 45000,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(openAiBody(request, stream))
  })
  if (!res.ok) throw new Error(await providerError('OpenAI', res))
  return res
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function anthropicBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
  const messages = request.messages.map((message, index) => {
    const isLast = index === request.messages.length - 1
    const role = message.role === 'model' ? 'assistant' : 'user'
    if (isLast && request.image) {
      return {
        role,
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: request.image.mimeType,
              data: request.image.base64
            }
          },
          { type: 'text', text: message.text }
        ]
      }
    }
    return { role, content: message.text }
  })

  // Anthropic has no JSON mode, so the instruction carries it. Callers already
  // handle a parse failure, so a stray sentence degrades rather than breaks.
  const system = request.jsonSchema
    ? `${request.system ?? ''}\n\nReply with a single JSON object and nothing else — no prose, no code fences. It must match this schema:\n${JSON.stringify(request.jsonSchema)}`.trim()
    : request.system

  return {
    model: modelFor('anthropic'),
    max_tokens: 2048,
    ...(system ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    messages,
    stream
  }
}

async function anthropicCall(request: LlmRequest, stream: boolean): Promise<Response> {
  const key = requireKey('ANTHROPIC_API_KEY', 'The Anthropic API key')
  const res = await httpFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    label: 'Anthropic',
    timeoutMs: 45000,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(anthropicBody(request, stream))
  })
  if (!res.ok) throw new Error(await providerError('Anthropic', res))
  return res
}

async function providerError(label: string, res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) {
    return `The ${label} key was rejected. Check it in settings.`
  }
  if (res.status === 429) return `${label} rate limit reached. Give it a moment.`
  const body = await res.text().catch(() => '')
  return `${label} request failed (${res.status}). ${body.slice(0, 160)}`
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** A complete answer, as text. */
export async function complete(request: LlmRequest): Promise<string> {
  const provider = activeProvider()

  if (provider === 'gemini') {
    const config = geminiConfig(request)
    const result = await withModelFallback((name) =>
      buildModel(name, request.system, config as never).generateContent(
        geminiRequest(request) as never
      )
    )
    return result.response.text().trim()
  }

  if (provider === 'openai') {
    const res = await openAiCall(request, false)
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return (json.choices?.[0]?.message?.content ?? '').trim()
  }

  const res = await anthropicCall(request, false)
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
  return (json.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim()
}

/** Reads an SSE body, handing each `data:` payload to `onEvent`. */
async function readSse(res: Response, onEvent: (payload: string) => void): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('The provider returned no stream.')
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Events are separated by a blank line; a chunk can split one in half.
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (line.startsWith('data:')) onEvent(line.slice(5).trim())
      }
    }
  }
}

/**
 * Streams an answer, calling `onChunk` as tokens arrive and returning the
 * whole thing. Streaming is what lets the overlay show an answer building up
 * rather than sitting on "Thinking…".
 */
export async function streamComplete(
  request: LlmRequest,
  onChunk: (chunk: string) => void
): Promise<string> {
  const provider = activeProvider()
  let full = ''

  if (provider === 'gemini') {
    const config = geminiConfig(request)
    const { stream } = await withModelFallback((name) =>
      buildModel(name, request.system, config as never).generateContentStream(
        geminiRequest(request) as never
      )
    )
    for await (const part of stream) {
      const chunk = part.text()
      if (!chunk) continue
      full += chunk
      onChunk(chunk)
    }
    return full.trim()
  }

  if (provider === 'openai') {
    const res = await openAiCall(request, true)
    await readSse(res, (payload) => {
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const chunk = json.choices?.[0]?.delta?.content
        if (chunk) {
          full += chunk
          onChunk(chunk)
        }
      } catch {
        // A partial or keep-alive frame — skip it rather than failing the turn.
      }
    })
    return full.trim()
  }

  const res = await anthropicCall(request, true)
  await readSse(res, (payload) => {
    try {
      const json = JSON.parse(payload) as {
        type?: string
        delta?: { type?: string; text?: string }
      }
      if (json.type === 'content_block_delta' && json.delta?.text) {
        full += json.delta.text
        onChunk(json.delta.text)
      }
    } catch {
      /* keep-alive or partial frame */
    }
  })
  return full.trim()
}
