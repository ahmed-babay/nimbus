import { useEffect, useState } from 'react'
import type { AiProvider, ProviderModel, SecretName, SecretStatus } from '@shared/types'

/** Shown next to each field so it's clear what a key is actually for. */
const KEY_INFO: Record<SecretName, { label: string; why: string; where: string }> = {
  GEMINI_API_KEY: {
    label: 'Google Gemini',
    why: 'Answers, routing and screen reading',
    where: 'aistudio.google.com/apikey'
  },
  OPENAI_API_KEY: {
    label: 'OpenAI',
    why: 'Alternative answer model',
    where: 'platform.openai.com/api-keys'
  },
  ANTHROPIC_API_KEY: {
    label: 'Anthropic',
    why: 'Alternative answer model',
    where: 'console.anthropic.com/settings/keys'
  },
  GROQ_API_KEY: {
    label: 'Groq',
    why: 'Speech recognition (Whisper)',
    where: 'console.groq.com/keys'
  },
  TAVILY_API_KEY: {
    label: 'Tavily',
    why: 'Web search and news',
    where: 'app.tavily.com'
  },
  OPENWEATHER_API_KEY: {
    label: 'OpenWeatherMap',
    why: 'Weather',
    where: 'openweathermap.org/api'
  },
  GNEWS_API_KEY: {
    label: 'GNews',
    why: 'Optional — nicer news images',
    where: 'gnews.io'
  },
  GITHUB_TOKEN: {
    label: 'GitHub',
    why: 'Optional — raises the trending-repos rate limit',
    where: 'github.com/settings/tokens'
  }
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic'
}

/**
 * Providers whose answer path is implemented. All three go through
 * `src/services/llm.ts`, so switching is a setting rather than a rewrite.
 *
 * Only Gemini has been exercised end to end here; OpenAI and Anthropic are
 * built to their documented APIs and verified as far as authentication, but
 * have not been run against a live paid key. Failures surface as a spoken
 * error rather than a wrong answer.
 */
const WIRED_PROVIDERS: AiProvider[] = ['gemini', 'openai', 'anthropic']

/**
 * Lets someone run Nimbus without ever creating a `.env` file.
 *
 * Keys entered here are encrypted with the OS keychain and only fill gaps —
 * anything already in the environment wins and is shown as locked, so opening
 * this panel on a configured machine can't quietly shadow a working key.
 */
export function KeySettings() {
  const [secrets, setSecrets] = useState<SecretStatus[]>([])
  const [drafts, setDrafts] = useState<Partial<Record<SecretName, string>>>({})
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null)

  const [provider, setProvider] = useState<AiProvider>('gemini')
  const [model, setModel] = useState('')
  const [lockedByEnv, setLockedByEnv] = useState(false)
  const [models, setModels] = useState<ProviderModel[]>([])
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [modelsError, setModelsError] = useState('')

  const refresh = (): void => {
    void window.nimbus.getSecrets().then(setSecrets)
  }

  useEffect(() => {
    refresh()
    void window.nimbus.getAiChoice().then((choice) => {
      setProvider(choice.provider)
      setModel(choice.model)
      setLockedByEnv(choice.lockedByEnv)
    })
  }, [])

  const save = async (name: SecretName): Promise<void> => {
    const value = drafts[name] ?? ''
    const result = await window.nimbus.setSecret(name, value)
    if (!result.ok) {
      setMessage({ text: result.error ?? 'Could not save that key.', bad: true })
      return
    }
    setDrafts((current) => ({ ...current, [name]: '' }))
    setMessage({ text: value.trim() ? `${KEY_INFO[name].label} key saved.` : 'Key cleared.' })
    refresh()
  }

  const loadModels = async (which: AiProvider): Promise<void> => {
    setModelsState('loading')
    setModelsError('')
    try {
      setModels(await window.nimbus.listModels(which))
      setModelsState('idle')
    } catch (err) {
      setModels([])
      setModelsState('error')
      setModelsError(err instanceof Error ? err.message : 'Could not list models.')
    }
  }

  const chooseProvider = (which: AiProvider): void => {
    setProvider(which)
    setModel('')
    setModels([])
    setModelsState('idle')
    void window.nimbus.setAiChoice({ provider: which, model: '' })
  }

  const chooseModel = (id: string): void => {
    setModel(id)
    void window.nimbus.setAiChoice({ provider, model: id })
    setMessage({ text: id ? `Using ${id}.` : 'Using the default model.' })
  }

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-nimbus-accent">
        Answer model
      </div>

      <div className="mt-1.5 flex gap-1">
        {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((which) => {
          const wired = WIRED_PROVIDERS.includes(which)
          return (
            <button
              key={which}
              disabled={lockedByEnv || !wired}
              title={wired ? undefined : 'Not available yet'}
              onClick={() => chooseProvider(which)}
              className={`flex-1 rounded-lg border px-2 py-1 text-[10.5px] transition-colors disabled:opacity-40 ${
                provider === which
                  ? 'border-nimbus-accent/60 bg-nimbus-accent/15 text-nimbus-text'
                  : 'border-white/[0.07] text-nimbus-text-dim hover:bg-white/[0.05]'
              }`}
            >
              {PROVIDER_LABELS[which]}
            </button>
          )
        })}
      </div>

      {lockedByEnv ? (
        <p className="mt-1.5 text-[10px] text-nimbus-text-dim">
          Pinned by your .env file (NIMBUS_PROVIDER / NIMBUS_MODEL).
        </p>
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <select
            value={model}
            onChange={(event) => chooseModel(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-white/[0.07] bg-nimbus-bg px-2 py-1 text-[11px] text-nimbus-text outline-none"
          >
            <option value="">Default for this provider</option>
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
            {/* A previously chosen model survives even before the list loads,
                so opening settings never silently resets it. */}
            {model && !models.some((entry) => entry.id === model) && (
              <option value={model}>{model}</option>
            )}
          </select>
          <button
            onClick={() => void loadModels(provider)}
            className="shrink-0 rounded-lg border border-nimbus-border px-2 py-1 text-[10px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
          >
            {modelsState === 'loading' ? 'Loading…' : 'Load models'}
          </button>
        </div>
      )}
      {modelsState === 'error' && (
        <p className="mt-1 text-[10px] text-nimbus-negative">{modelsError}</p>
      )}

      <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-nimbus-accent">
        API keys
      </div>
      <p className="mt-1 text-[10px] text-nimbus-text-dim">
        Stored encrypted by Windows, and only used when the key isn&apos;t already in .env.
      </p>

      <ul className="mt-1.5 space-y-2">
        {secrets.map((secret) => {
          const info = KEY_INFO[secret.name]
          const locked = secret.source === 'env'
          return (
            <li key={secret.name}>
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] text-nimbus-text">{info.label}</span>
                <span
                  className={`text-[9px] uppercase tracking-wide ${
                    secret.set ? 'text-nimbus-positive' : 'text-nimbus-text-dim'
                  }`}
                >
                  {locked ? '.env' : secret.set ? 'saved' : 'not set'}
                </span>
                <span className="ml-auto truncate text-[9.5px] text-nimbus-text-dim">
                  {info.why}
                </span>
              </div>
              {locked ? (
                <div className="mt-0.5 text-[10px] text-nimbus-text-dim">
                  Set in .env — edit the file to change it.
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    type="password"
                    value={drafts[secret.name] ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [secret.name]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      // Enter saves; Escape must not reach the global handler
                      // and close the overlay mid-paste.
                      if (event.key === 'Enter') void save(secret.name)
                      if (event.key === 'Escape') event.stopPropagation()
                    }}
                    placeholder={secret.hint ?? `Paste key — ${info.where}`}
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-white/[0.07] bg-nimbus-bg px-2 py-1 text-[11px] text-nimbus-text outline-none placeholder:text-nimbus-text-dim/60 focus:border-nimbus-accent/50"
                  />
                  <button
                    onClick={() => void save(secret.name)}
                    className="shrink-0 rounded-lg border border-nimbus-border px-2 py-1 text-[10px] text-nimbus-accent-bright transition-colors hover:bg-nimbus-accent/20"
                  >
                    {drafts[secret.name]?.trim() ? 'Save' : secret.set ? 'Clear' : 'Save'}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {message && (
        <p
          className={`mt-2 text-[10px] ${message.bad ? 'text-nimbus-negative' : 'text-nimbus-positive'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
