/**
 * Outbound HTTP with a deadline and a retry.
 *
 * `fetch` has no default timeout: a request to an unreachable host can hang
 * indefinitely. When that happened inside an intent handler, the IPC call
 * never settled and the overlay sat on "Thinking…" forever with no error —
 * strictly worse than failing. Every outbound call goes through here so that
 * cannot happen.
 */

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_RETRIES = 1
const RETRY_BASE_DELAY_MS = 400

export interface HttpOptions extends RequestInit {
  timeoutMs?: number
  /** Extra attempts after the first. Only transient failures are retried. */
  retries?: number
  /** Shown in logs so a hanging dependency is identifiable. */
  label?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Timeouts and network drops are worth another go; a 4xx never is. */
function isTransient(error: unknown, response?: Response): boolean {
  if (response) return response.status === 429 || response.status >= 500
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError'
}

export async function httpFetch(url: string, options: HttpOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    label = new URL(url).hostname,
    ...init
  } = options

  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })

      if (attempt < retries && isTransient(undefined, response)) {
        console.warn(`[http] ${label} returned ${response.status}, retrying`)
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt < retries && isTransient(error)) {
        const reason = error instanceof Error ? error.name : 'error'
        console.warn(`[http] ${label} ${reason}, retrying (${attempt + 1}/${retries})`)
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
        continue
      }
      break
    }
  }

  const reason = lastError instanceof Error ? lastError.name : 'failed'
  if (reason === 'TimeoutError') {
    throw new Error(`${label} didn't respond in time. Check your connection and try again.`)
  }
  throw new Error(`Couldn't reach ${label}. Check your connection and try again.`)
}

/**
 * Hard ceiling on any operation, so a dependency without its own timeout
 * still can't leave the UI waiting forever.
 *
 * This lives in http.ts but it is not only used for HTTP, and it used to say
 * "Check your connection and try again" whatever it wrapped. That sent people
 * to look at their wifi over a first question on the on-device model, where
 * the whole 25 seconds had gone on loading twelve seconds of weights onto the
 * GPU with the network never touched. Blaming the network for local work is
 * worse than saying nothing, so the advice is now the caller's to give.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  advice = 'Check your connection and try again.'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} took too long. ${advice}`.trim())),
          ms
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
