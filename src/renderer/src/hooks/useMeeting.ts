import { useCallback, useRef, useState } from 'react'
import { useAudioCapture, type CapturedPiece } from './useAudioCapture'
import type { MeetingExportFormat, MeetingLine, MeetingSummary } from '@shared/types'

/**
 * Records a meeting without taking part in it.
 *
 * Both sides are captured as separate streams — your microphone and the
 * computer's own output — which is what makes the transcript a dialogue
 * rather than a wall of text. Nimbus stays silent throughout: no wake word,
 * no answers, no chime.
 *
 * The recording is held in memory and only written to disk when the user asks
 * for it, at a path they choose. Nothing about a meeting is kept without
 * being asked for.
 */

export type MeetingPhase = 'idle' | 'recording' | 'stopped'

export interface MeetingControls {
  phase: MeetingPhase
  lines: MeetingLine[]
  startedAt: number
  /** Pieces still being transcribed, so the UI can say it isn't finished. */
  pending: number
  summary: MeetingSummary | null
  summarizing: boolean
  savedPath: string
  error: string
  start: () => Promise<void>
  stop: () => void
  save: (format: MeetingExportFormat) => Promise<void>
  /** Whisper language for this meeting; empty lets it guess. */
  language: string
  setLanguage: (code: string) => void
  summarize: () => Promise<void>
  reset: () => void
}

export function useMeeting(): MeetingControls {
  const [phase, setPhase] = useState<MeetingPhase>('idle')
  const [lines, setLines] = useState<MeetingLine[]>([])
  const [startedAt, setStartedAt] = useState(0)
  const [pending, setPending] = useState(0)
  const [summary, setSummary] = useState<MeetingSummary | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [savedPath, setSavedPath] = useState('')
  const [error, setError] = useState('')
  const [language, setLanguageState] = useState('')

  // Continuation context per speaker. Keeping them apart matters: feeding
  // your own last sentence as context for their audio would push the
  // transcription towards words that were never said on that side.
  const previousRef = useRef<Record<string, string>>({ you: '', them: '' })

  // Read from a ref inside the piece handler rather than closed over: the
  // handler is created once and a language chosen after the recording started
  // would otherwise never reach it.
  const languageRef = useRef('')

  const handlePiece = useCallback((piece: CapturedPiece) => {
    const speaker: MeetingLine['speaker'] = piece.source === 'microphone' ? 'you' : 'them'
    const previous = previousRef.current[speaker] ?? ''

    setPending((count) => count + 1)
    void window.nimbus
      .meetingPiece(piece.pcm.buffer as ArrayBuffer, previous, languageRef.current)
      .then((text) => {
        if (!text) return
        previousRef.current[speaker] = text
        setLines((current) => {
          const next = [...current, { speaker, text, offsetMs: piece.offsetMs }]
          // Ordered by when it was said, not when transcription came back.
          next.sort((a, b) => a.offsetMs - b.offsetMs)
          return next
        })
      })
      .catch(() => {
        // One lost sentence is not worth interrupting a recording for.
      })
      .finally(() => setPending((count) => Math.max(0, count - 1)))
  }, [])

  const capture = useAudioCapture({
    onPiece: handlePiece,
    onError: (message) => {
      setError(message)
      setPhase('stopped')
    }
  })

  const setLanguage = useCallback((code: string) => {
    languageRef.current = code
    setLanguageState(code)
  }, [])

  const start = useCallback(async () => {
    setError('')
    setLines([])
    setSummary(null)
    setSavedPath('')
    previousRef.current = { you: '', them: '' }
    setStartedAt(Date.now())
    setPhase('recording')
    // Microphone and system audio together — one without the other gives half
    // a conversation.
    await capture.start(['microphone', 'system'])
  }, [capture])

  const stop = useCallback(() => {
    capture.stop()
    setPhase('stopped')
  }, [capture])

  const save = useCallback(
    async (format: MeetingExportFormat) => {
      setError('')
      setSavedPath('')
      const result = await window.nimbus.saveMeeting(lines, startedAt, format, summary)
      if (result.ok && result.path) setSavedPath(result.path)
      else if (result.error) setError(result.error)
    },
    [lines, startedAt, summary]
  )

  const summarize = useCallback(async () => {
    setError('')
    setSummarizing(true)
    try {
      setSummary(await window.nimbus.summarizeMeeting(lines, startedAt))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not summarise the meeting.')
    } finally {
      setSummarizing(false)
    }
  }, [lines, startedAt])

  const reset = useCallback(() => {
    capture.stop()
    setPhase('idle')
    setLines([])
    setSummary(null)
    setSavedPath('')
    setError('')
  }, [capture])

  return {
    phase,
    lines,
    startedAt,
    pending,
    summary,
    summarizing,
    savedPath,
    error,
    start,
    stop,
    save,
    language,
    setLanguage,
    summarize,
    reset
  }
}
