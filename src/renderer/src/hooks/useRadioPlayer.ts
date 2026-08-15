import { useCallback, useEffect, useRef, useState } from 'react'

export interface RadioPlayerControls {
  isPlaying: boolean
  isLoading: boolean
  error: string | null
  play: (streamUrl: string) => void
  toggle: () => void
  stop: () => void
  /** Pause without dropping the stream, so it can resume instantly. */
  pause: () => void
  resume: () => void
}

/**
 * Plays an internet radio stream inside the overlay with a single long-lived
 * <audio> element. Kept outside React's tree (created imperatively) so
 * playback survives re-renders and card swaps — remounting an <audio> tag
 * would restart the stream every time state changed.
 */
export function useRadioPlayer(): RadioPlayerControls {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const getAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const audio = new Audio()
      audio.preload = 'none'
      audio.volume = 0.85
      audio.addEventListener('playing', () => {
        setIsPlaying(true)
        setIsLoading(false)
        setError(null)
      })
      audio.addEventListener('pause', () => setIsPlaying(false))
      audio.addEventListener('waiting', () => setIsLoading(true))
      audio.addEventListener('error', () => {
        setIsLoading(false)
        setIsPlaying(false)
        setError("That station wouldn't play.")
      })
      audioRef.current = audio
    }
    return audioRef.current
  }, [])

  const play = useCallback(
    (streamUrl: string) => {
      const audio = getAudio()
      if (audio.src !== streamUrl) {
        audio.src = streamUrl
      }
      setIsLoading(true)
      setError(null)
      void audio.play().catch(() => {
        setIsLoading(false)
        setError("That station wouldn't play.")
      })
    },
    [getAudio]
  )

  const stop = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    // Dropping the source releases the connection; pausing alone leaves the
    // stream open and buffering in the background.
    audio.removeAttribute('src')
    audio.load()
    setIsPlaying(false)
    setIsLoading(false)
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const resume = useCallback(() => {
    const audio = audioRef.current
    if (!audio?.src) return
    setIsLoading(true)
    void audio.play().catch(() => setIsLoading(false))
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !audio.src) return
    if (audio.paused) {
      setIsLoading(true)
      void audio.play().catch(() => setIsLoading(false))
    } else {
      audio.pause()
    }
  }, [])

  useEffect(() => stop, [stop])

  return { isPlaying, isLoading, error, play, toggle, stop, pause, resume }
}
