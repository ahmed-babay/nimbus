/** A late synthesis result must never speak over the answer or a closed app. */
export function deferFeedback<T>(options: {
  prepare: () => Promise<T>
  play: (value: T) => () => void
  schedule?: (run: () => void) => () => void
}): () => void {
  let cancelled = false
  let stop: (() => void) | undefined
  const schedule = options.schedule ?? ((run) => {
    const timer = setTimeout(run, 1400)
    return () => clearTimeout(timer)
  })
  const clear = schedule(() => {
    if (cancelled) return
    void options.prepare().then(value => {
      if (!cancelled) stop = options.play(value)
    }).catch(() => { /* Feedback is optional; the answer owns error reporting. */ })
  })
  return () => { cancelled = true; clear(); stop?.(); stop = undefined }
}
