import { useEffect, useRef, useState } from 'react'

/**
 * Reveals text at a steady rate instead of in jumps.
 *
 * Gemini streams in a handful of large chunks — three or four for a short
 * answer — so rendering them as they arrive looks like the whole reply
 * appearing at once. This buffers the target text and lets the displayed
 * text catch up character by character, which is what actually reads as
 * "streaming".
 *
 * If the model gets far ahead (a long answer), the rate scales up so the
 * text never lags meaningfully behind the audio.
 */
export function useTypewriter(target: string, charsPerSecond = 45): string {
  const [displayed, setDisplayed] = useState('')
  const frameRef = useRef(0)
  const lastTimeRef = useRef(0)
  const shownRef = useRef(0)

  useEffect(() => {
    // Reset when the stream restarts (new question, or cleared).
    if (!target.startsWith(displayed)) {
      shownRef.current = 0
      setDisplayed('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  useEffect(() => {
    if (!target) {
      shownRef.current = 0
      setDisplayed('')
      return
    }

    const step = (time: number): void => {
      if (!lastTimeRef.current) lastTimeRef.current = time
      const elapsed = (time - lastTimeRef.current) / 1000
      lastTimeRef.current = time

      const remaining = target.length - shownRef.current
      if (remaining > 0) {
        // Catch-up: the further behind, the faster it types, so a long answer
        // doesn't crawl for ten seconds after the model has finished.
        const speed = charsPerSecond * (1 + Math.min(3, remaining / 120))
        shownRef.current = Math.min(target.length, shownRef.current + speed * elapsed)
        setDisplayed(target.slice(0, Math.floor(shownRef.current)))
      }

      frameRef.current = requestAnimationFrame(step)
    }

    frameRef.current = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frameRef.current)
      lastTimeRef.current = 0
    }
  }, [target, charsPerSecond])

  return displayed
}
