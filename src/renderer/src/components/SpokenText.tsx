import { useEffect, useMemo, useRef, type RefObject } from 'react'

interface SpokenTextProps {
  text: string
  /** 0..1 progress through the spoken audio. */
  progressRef: RefObject<number>
  /**
   * Fraction of `text` that actually gets spoken. Long answers are capped for
   * TTS, so the tail is never read aloud — it stays fully visible instead of
   * waiting for a reveal that will never reach it.
   */
  spokenRatio?: number
  className?: string
}

/**
 * Reveals the answer word by word in time with the audio, so the text tracks
 * what's actually being said rather than appearing all at once. Progress comes
 * from the AudioContext clock via a ref, and words are updated with direct
 * style writes on an animation frame — no React re-render per word.
 */
export function SpokenText({
  text,
  progressRef,
  spokenRatio = 1,
  className = 'text-[13px] leading-relaxed text-nimbus-text'
}: SpokenTextProps) {
  const containerRef = useRef<HTMLParagraphElement>(null)
  const words = useMemo(() => text.split(/(\s+)/), [text])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const spans = Array.from(container.querySelectorAll<HTMLElement>('[data-word]'))
    if (spans.length === 0) return

    let frame = 0
    let lastCount = -1

    // Words past this index are never spoken, so they're always shown.
    const spokenSpans = Math.max(1, Math.round(spans.length * spokenRatio))

    const tick = (): void => {
      const progress = progressRef.current
      // Slightly ahead of the audio so the word being spoken is already
      // visible rather than lagging behind the voice.
      const spokenCount = Math.ceil(progress * spokenSpans + 0.5)

      // Only touch the DOM when the revealed count actually changes.
      if (spokenCount !== lastCount) {
        lastCount = spokenCount
        for (let i = 0; i < spans.length; i++) {
          const revealed = i < spokenCount || i >= spokenSpans
          spans[i].style.opacity = revealed ? '1' : '0.28'
        }
      }

      // Keep running for as long as the text is mounted. Stopping at
      // progress >= 1 meant a turn that began with progress left at 1 from
      // the previous answer revealed everything at once and never restarted
      // when playback actually began.
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [progressRef, words, spokenRatio])

  return (
    <p ref={containerRef} className={className}>
      {words.map((word, i) =>
        /^\s+$/.test(word) ? (
          <span key={i}>{word}</span>
        ) : (
          <span
            key={i}
            data-word
            style={{ opacity: 0.28, transition: 'opacity 140ms ease-out' }}
          >
            {word}
          </span>
        )
      )}
    </p>
  )
}
