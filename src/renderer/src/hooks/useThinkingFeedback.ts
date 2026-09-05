import { useEffect, useRef } from 'react'
import { deferFeedback } from '../lib/deferred-feedback'
import { useExperiencePreference } from '../lib/experience-preferences'

const PHRASES: Record<string, string> = {
  english: 'Hmm, one moment.', german: 'Einen Moment.',
  arabic: 'لحظة من فضلك.', french: 'Un instant.', spanish: 'Un momento.'
}

export function useThinkingFeedback(active: boolean, voiceEnabled: boolean, language = 'English', turnSequence = 0): () => void {
  const enabled = useExperiencePreference('acknowledgments')
  const cancelRef = useRef<() => void>(() => {})
  const contextRef = useRef<AudioContext | null>(null)
  const cache = useRef<{ phrase: string; audio: ArrayBuffer } | null>(null)
  const phrase = PHRASES[language.toLowerCase()]
  useEffect(() => {
    if (!active || !voiceEnabled || !enabled || !phrase) return
    let disposed = false
    const cancel = deferFeedback({
      prepare: async () => {
        let audio = cache.current?.phrase === phrase ? cache.current.audio : null
        if (!audio) {
          const result = await window.nimbus.synthesizeSpeech(phrase)
          if (!result.audio?.byteLength) throw new Error('No feedback audio')
          audio = result.audio
          cache.current = { phrase, audio }
        }
        if (disposed) throw new Error('Turn ended')
        const ctx = contextRef.current ?? new AudioContext()
        contextRef.current = ctx
        if (ctx.state === 'suspended') await ctx.resume()
        return { ctx, buffer: await ctx.decodeAudioData(audio.slice(0)) }
      },
      play: ({ ctx, buffer }) => {
        const source = ctx.createBufferSource()
        const gain = ctx.createGain()
        gain.gain.value = .72
        source.buffer = buffer
        source.connect(gain).connect(ctx.destination)
        source.onended = () => { source.disconnect(); gain.disconnect() }
        source.start()
        return () => { try { source.stop() } catch { /* already ended */ } }
      }
    })
    cancelRef.current = cancel
    return () => { disposed = true; cancel(); cancelRef.current = () => {} }
  }, [active, voiceEnabled, enabled, phrase, turnSequence])
  useEffect(() => () => { void contextRef.current?.close().catch(() => {}) }, [])
  return () => cancelRef.current()
}
