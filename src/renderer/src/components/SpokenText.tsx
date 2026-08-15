import { useEffect, useMemo, useRef, type RefObject } from 'react'

interface SpokenTextProps {
  text: string
  /** 0..1 progress through the spoken audio. */
  progressRef: RefObject<number>
}

/**
 * Reveals the answer word by word in time with the audio, so the text tracks
 * what's actually being said rather than appearing all at once. Progress comes
 * from the AudioContext clock via a ref, and words are updated with direct
 * style writes on an animation frame — no React re-render per word.
 */
export function SpokenText({ text, progressRef }: SpokenTextProps) {
  const containerRef = useRef<HTMLParagraphElement>(null)
  const words = useMemo(() => text.split(/(\s+)/), [text])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const spans = Array.from(container.querySelectorAll<HTMLElement>('[data-word]'))
    if (spans.length === 0) return

    let frame = 0
    const tick = (): void => {
      const progress = progressRef.current
      // Slightly ahead of the audio so the word being spoken is already
      // visible rather than lagging behind the voice.
      const spokenCount = Math.ceil(progress * spans.length + 0.5)
      for (let i = 0; i < spans.length; i++) {
        const revealed = i < spokenCount
        spans[i].style.opacity = revealed ? '1' : '0.28'
      }
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [progressRef, words])

  return (
    <p ref={containerRef} className="text-[13px] leading-relaxed text-nimbus-text">
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
