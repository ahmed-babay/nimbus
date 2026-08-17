import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CountUp, EASE, FillBar, Stagger, StaggerItem } from './Motion'
import { Dropdown } from './Dropdown'
import type {
  AiProvider,
  LocalModelKind,
  LocalModelStatus,
  ProviderModel,
  QuotaLine,
  SecretName,
  SecretStatus
} from '@shared/types'

/** What each downloadable model is called and costs, in the user's terms. */
const LOCAL_MODELS: Record<
  LocalModelKind,
  { name: string; size: string; why: string; ready: string }
> = {
  llm: {
    name: 'Qwen3.5 0.8B',
    size: '532 MB',
    why: 'Answers and routing, with no key and no network.',
    ready: 'runs offline'
  },
  stt: {
    name: 'Whisper base',
    size: '290 MB',
    why: 'Hears you without an API key. Works with any answer provider.',
    ready: 'GPU, offline'
  },
  tts: {
    name: 'Kokoro 82M',
    size: '330 MB',
    why: 'Speaks without a network call, at a steadier pace than Edge.',
    ready: 'GPU, offline'
  }
}

/**
 * One downloadable on-device model: its state, its progress, its button.
 *
 * Each model owns its own state rather than sharing the panel's, because they
 * are independent — someone can run answers in the cloud and still want the
 * microphone to work without a key.
 */
function LocalModelRow({
  kind,
  onMessage
}: {
  kind: LocalModelKind
  onMessage: (message: { text: string; bad?: boolean } | null) => void
}): React.JSX.Element {
  const info = LOCAL_MODELS[kind]
  const [status, setStatus] = useState<LocalModelStatus | null>(null)
  const [received, setReceived] = useState(0)
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(false)

  const refresh = (): void => {
    void window.nimbus.getLocalModelStatus(kind).then(setStatus)
  }

  useEffect(refresh, [kind])

  useEffect(() => {
    // Progress arrives from the main process, which owns the download, so it
    // keeps running even if this panel is closed and reopened mid-way.
    return window.nimbus.onLocalModelProgress((progress) => {
      if (progress.kind !== kind) return
      setReceived(progress.receivedBytes)
      setTotal(progress.totalBytes)
      if (progress.done) {
        setBusy(false)
        refresh()
        if (progress.error) onMessage({ text: progress.error, bad: true })
      }
    })
  }, [kind, onMessage])

  const start = async (): Promise<void> => {
    setBusy(true)
    onMessage(null)
    const result = await window.nimbus.downloadLocalModel(kind)
    setBusy(false)
    refresh()
    if (!result.ok && result.error) onMessage({ text: result.error, bad: true })
    else if (result.ok) onMessage({ text: `${info.name} installed.` })
  }

  return (
    <div className="mt-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1.5">
      {status?.installed ? (
        <div className="flex items-center gap-1.5 text-[10.5px]">
          <span className="text-nimbus-positive">●</span>
          <span className="text-nimbus-text">{info.name} ready</span>
          <span className="ml-auto text-[9.5px] text-nimbus-text-dim">
            {status.sizeBytes > 0 && `${(status.sizeBytes / 1e9).toFixed(2)} GB · `}
            {info.ready}
          </span>
        </div>
      ) : busy ? (
        <>
          <div className="flex items-center gap-1.5 text-[10.5px] text-nimbus-text">
            <span>Downloading {info.name}…</span>
            <span className="ml-auto text-[9.5px] tabular-nums text-nimbus-text-dim">
              {total ? `${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` : '…'}
            </span>
          </div>
          <div className="mt-1">
            <FillBar fraction={total ? received / total : 0.05} />
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] text-nimbus-text">{info.name} not installed</div>
            <div className="text-[9.5px] text-nimbus-text-dim">
              One-off {info.size} download. {info.why}
            </div>
          </div>
          <button
            onClick={() => void start()}
            className="shrink-0 rounded-lg border border-nimbus-accent/50 bg-nimbus-accent/15 px-2 py-1 text-[10px] text-nimbus-text transition-colors hover:bg-nimbus-accent/25"
          >
            Download
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * What's left of the free tiers.
 *
 * Nimbus runs entirely on free allowances, so the failure worth warning about
 * isn't an error — it's a monthly budget running out mid-question. Only Tavily
 * publishes usage; the rest say plainly that they can't be measured rather
 * than showing a bar built from a guess.
 */
function QuotaPanel(): React.JSX.Element {
  const [lines, setLines] = useState<QuotaLine[] | null>(null)

  useEffect(() => {
    void window.nimbus.getQuotas().then(setLines)
  }, [])

  if (!lines) {
    return <p className="mt-1.5 text-[10px] text-nimbus-text-dim">Checking…</p>
  }

  return (
    <Stagger className="mt-1.5 space-y-1.5">
      {lines.map((line) => {
        const measured = line.state === 'ok' && line.limit
        const fraction = measured ? Math.min(1, (line.used ?? 0) / (line.limit ?? 1)) : 0
        // Colour tracks how close the budget is to gone, not how much is used,
        // so the panel is quiet until it matters.
        const bar =
          fraction > 0.9
            ? 'bg-nimbus-negative'
            : fraction > 0.7
              ? 'bg-nimbus-yellow'
              : 'bg-nimbus-positive'

        return (
          <StaggerItem
            key={line.service}
            className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1.5"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10.5px] text-nimbus-text">{line.service}</span>
              <span className="text-[9.5px] text-nimbus-text-dim">{line.purpose}</span>
              <span className="ml-auto text-[9.5px] tabular-nums text-nimbus-text-dim">
                {measured
                  ? <><CountUp value={line.used ?? 0} /> {`/ ${line.limit}`}</>
                  : line.state === 'local'
                    ? 'on device'
                    : line.state === 'missing'
                      ? 'not set up'
                      : line.state === 'error'
                        ? 'unavailable'
                        : 'no limit published'}
              </span>
            </div>
            {measured && <div className="mt-1"><FillBar fraction={fraction} className={bar} /></div>}
            <div className="mt-0.5 text-[9.5px] text-nimbus-text-dim">{line.detail}</div>
          </StaggerItem>
        )
      })}
    </Stagger>
  )
}

/**
 * A section that starts closed.
 *
 * Settings grew a provider picker, three model downloads, a quota panel and
 * eight key fields, which together are taller than the screen — and a panel
 * you have to scroll to find anything in is a panel nobody reads. Everything
 * except the provider choice now folds away, so the whole thing fits and you
 * open only the part you came for.
 */
function Section({
  title,
  hint,
  children,
  defaultOpen = false
}: {
  title: string
  hint?: string
  children: React.ReactNode
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="mt-2 border-t border-white/[0.07] pt-2">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <motion.span
          className="text-[9px] text-nimbus-text-dim"
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.2, ease: EASE }}
        >
          ▶
        </motion.span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-nimbus-accent">
          {title}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            // Height rather than opacity alone: the point is that the closed
            // sections take up no room.
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            {hint && <p className="mt-1 text-[10px] text-nimbus-text-dim">{hint}</p>}
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

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
  local: 'On this device',
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
const WIRED_PROVIDERS: AiProvider[] = ['local', 'gemini', 'openai', 'anthropic']

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

      {/* The on-device model needs a one-off download rather than a key, so it
          gets its own panel instead of an empty key field. */}
      {provider === 'local' && <LocalModelRow kind="llm" onMessage={setMessage} />}

      {lockedByEnv ? (
        <p className="mt-1.5 text-[10px] text-nimbus-text-dim">
          Pinned by your .env file (NIMBUS_PROVIDER / NIMBUS_MODEL).
        </p>
      ) : provider === 'local' ? (
        <p className="mt-1.5 text-[10px] text-nimbus-text-dim">
          Answers, routing and reminders run here. Web research still uses a cloud model when
          one is set up.
        </p>
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <Dropdown
            value={model}
            onChange={chooseModel}
            placeholder="Default for this provider"
            options={[
              { value: '', label: 'Default for this provider' },
              ...models.map((entry) => ({ value: entry.id, label: entry.label, hint: entry.id })),
              // A previously chosen model survives even before the list loads,
              // so opening settings never silently resets it.
              ...(model && !models.some((entry) => entry.id === model)
                ? [{ value: model, label: model, hint: 'Chosen earlier' }]
                : [])
            ]}
          />
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

      {/* Its own section rather than part of the provider block: local speech
          recognition is independent of who answers, and is worth installing
          even when answers come from the cloud. */}
      <Section
        title="Speech"
        hint="Installed, these replace the Groq key and the Edge voice — and keep what you say, and what Nimbus says back, on this machine."
      >
        <LocalModelRow kind="stt" onMessage={setMessage} />
        <LocalModelRow kind="tts" onMessage={setMessage} />
      </Section>

      <Section title="What's left this month">
        <QuotaPanel />
      </Section>

      <Section
        title="API keys"
        hint="Stored encrypted by Windows, and only used when the key isn't already in .env."
      >
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
      </Section>

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
