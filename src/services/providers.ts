import { httpFetch } from './http'
import type { AiProvider, ProviderModel } from '../shared/types'

/**
 * Which model providers Nimbus can talk to, and how to ask each one what
 * models the key actually has access to.
 *
 * Listing rather than hardcoding, because a hardcoded list is wrong within
 * weeks and wrong in a way the user can't fix: their account may have models
 * this build has never heard of, or lack ones it assumes. Every provider
 * exposes the list, so ask.
 */

export const PROVIDERS: Record<AiProvider, { label: string; keyName: string; docs: string }> = {
  gemini: {
    label: 'Google Gemini',
    keyName: 'GEMINI_API_KEY',
    docs: 'aistudio.google.com/apikey'
  },
  openai: {
    label: 'OpenAI',
    keyName: 'OPENAI_API_KEY',
    docs: 'platform.openai.com/api-keys'
  },
  anthropic: {
    label: 'Anthropic',
    keyName: 'ANTHROPIC_API_KEY',
    docs: 'console.anthropic.com/settings/keys'
  }
}

/** Models that exist but can't answer a prompt, so are noise in a picker. */
const UNUSABLE = /(embedding|aqa|tts|image-generation|whisper|dall-e|moderation|imagen|veo)/i

async function listGemini(key: string): Promise<ProviderModel[]> {
  const res = await httpFetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
    { label: 'Gemini models', timeoutMs: 10000 }
  )
  if (!res.ok) throw new Error(await describeFailure(res))

  const json = (await res.json()) as {
    models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>
  }
  return (json.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => ({
      id: (model.name ?? '').replace(/^models\//, ''),
      label: model.displayName || (model.name ?? '').replace(/^models\//, '')
    }))
    .filter((model) => model.id && !UNUSABLE.test(model.id))
}

async function listOpenAi(key: string): Promise<ProviderModel[]> {
  const res = await httpFetch('https://api.openai.com/v1/models', {
    label: 'OpenAI models',
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: 10000
  })
  if (!res.ok) throw new Error(await describeFailure(res))

  const json = (await res.json()) as { data?: Array<{ id?: string }> }
  return (json.data ?? [])
    .map((model) => ({ id: model.id ?? '', label: model.id ?? '' }))
    .filter((model) => model.id && !UNUSABLE.test(model.id))
    .sort((a, b) => a.id.localeCompare(b.id))
}

async function listAnthropic(key: string): Promise<ProviderModel[]> {
  const res = await httpFetch('https://api.anthropic.com/v1/models?limit=100', {
    label: 'Anthropic models',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    timeoutMs: 10000
  })
  if (!res.ok) throw new Error(await describeFailure(res))

  const json = (await res.json()) as {
    data?: Array<{ id?: string; display_name?: string }>
  }
  return (json.data ?? [])
    .map((model) => ({ id: model.id ?? '', label: model.display_name || model.id || '' }))
    .filter((model) => model.id)
}

async function describeFailure(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) return 'That key was rejected.'
  if (res.status === 429) return 'Rate limited — try again in a moment.'
  const body = await res.text().catch(() => '')
  return `Could not list models (${res.status}). ${body.slice(0, 120)}`
}

/** The models this key can actually use, newest-looking first where known. */
export async function listModels(provider: AiProvider): Promise<ProviderModel[]> {
  const key = process.env[PROVIDERS[provider].keyName]
  if (!key) throw new Error(`No ${PROVIDERS[provider].label} key is set.`)

  switch (provider) {
    case 'openai':
      return listOpenAi(key)
    case 'anthropic':
      return listAnthropic(key)
    default:
      return listGemini(key)
  }
}
