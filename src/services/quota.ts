import { httpFetch } from './http'
import { localSttInstalled } from './local-stt'
import { localTtsInstalled, localTtsSupportsLanguage } from './local-tts'
import type { QuotaLine } from '../shared/types'

/**
 * What's left of the free tiers.
 *
 * Nimbus is built entirely on free allowances, which means the interesting
 * failure isn't an error — it's the day a monthly budget quietly runs out
 * mid-question. This is the panel that makes that visible before it happens.
 *
 * Only Tavily can actually be measured: it publishes a usage endpoint. The
 * others are reported honestly for what they are rather than padded with
 * invented numbers — Gemini's free tier exposes no usage API, and anything on
 * this machine has no quota to run out of.
 */

const USAGE_URL = 'https://api.tavily.com/usage'

interface TavilyUsage {
  account?: {
    current_plan?: string
    plan_usage?: number
    plan_limit?: number
  }
}

async function tavilyQuota(): Promise<QuotaLine> {
  const base = { service: 'Tavily', purpose: 'Web search and research' } as const
  const key = process.env.TAVILY_API_KEY
  if (!key) {
    return { ...base, state: 'missing', detail: 'No key set — web search is unavailable.' }
  }

  try {
    const res = await httpFetch(USAGE_URL, {
      label: 'Tavily usage',
      timeoutMs: 8000,
      retries: 0,
      headers: { Authorization: `Bearer ${key}` }
    })
    if (!res.ok) {
      return {
        ...base,
        state: 'error',
        detail: res.status === 401 ? 'The key was rejected.' : `Couldn't read usage (${res.status}).`
      }
    }

    const json = (await res.json()) as TavilyUsage
    const used = json.account?.plan_usage ?? 0
    const limit = json.account?.plan_limit ?? 0
    const plan = json.account?.current_plan ?? 'free'

    // No published limit means an unmetered plan; a progress bar against a
    // limit of zero would read as "full" rather than "unlimited".
    if (!limit) {
      return { ...base, state: 'unmeasured', detail: `${used} searches used on the ${plan} plan.` }
    }

    return {
      ...base,
      state: 'ok',
      used,
      limit,
      detail: `${limit - used} of ${limit} left this month on the ${plan} plan.`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.'
    return { ...base, state: 'error', detail: message }
  }
}

async function speechQuota(): Promise<QuotaLine[]> {
  const [stt, tts] = await Promise.all([localSttInstalled(), localTtsInstalled()])

  return [
    {
      service: 'Speech to text',
      purpose: 'Hearing you',
      state: stt ? 'local' : process.env.GROQ_API_KEY ? 'unmeasured' : 'missing',
      detail: stt
        ? 'On this device — no quota, no network.'
        : process.env.GROQ_API_KEY
          ? 'Using Groq. Its free tier is generous but not published per-key.'
          : 'No on-device model and no Groq key — Nimbus cannot hear you.'
    },
    {
      service: 'Text to speech',
      purpose: 'Speaking to you',
      state: tts && localTtsSupportsLanguage() ? 'local' : 'unmeasured',
      detail:
        tts && localTtsSupportsLanguage()
          ? 'On this device — no quota, no network.'
          : "Using Edge's free voice. No key and no published limit."
    }
  ]
}

function answerQuota(): QuotaLine {
  const base = { service: 'Answers', purpose: 'Routing and replies' } as const

  if (process.env.GEMINI_API_KEY) {
    return {
      ...base,
      state: 'unmeasured',
      // Gemini publishes per-minute and per-day caps but no endpoint to read
      // consumption, so a number here would be a guess.
      detail: 'Gemini free tier. Google publishes no usage endpoint to read.'
    }
  }
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
    return { ...base, state: 'unmeasured', detail: 'A paid provider key is set.' }
  }
  return { ...base, state: 'local', detail: 'On this device, if the model is installed.' }
}

/** Everything, gathered at once so the panel doesn't fill in line by line. */
export async function readQuotas(): Promise<QuotaLine[]> {
  const [tavily, speech] = await Promise.all([tavilyQuota(), speechQuota()])
  return [tavily, answerQuota(), ...speech]
}
