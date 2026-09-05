import { useEffect, useRef } from 'react'
import { deferFeedback } from '../lib/deferred-feedback'
import { useExperiencePreference } from '../lib/experience-preferences'
import { chooseAcknowledgment } from '../lib/acknowledgment-phrases'

export function useThinkingFeedback(active: boolean, voiceEnabled: boolean, language = 'English', turnSequence = 0): () => void {
  const enabled = useExperiencePreference('acknowledgments')
  const cancelRef = useRef<() => void>(() => {})
  const contextRef = useRef<AudioContext | null>(null)
  const cache = useRef(new Map<string, ArrayBuffer>())
  const lastSpoken = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!active || !voiceEnabled || !enabled) return
    let disposed = false
    const cancel = deferFeedback({
      prepare: async () => {
        const phrase = chooseAcknowledgment(language, lastSpoken.current)
        if (!phrase) throw new Error('No acknowledgment for this language')
        let audio = cache.current.get(phrase)
        if (!audio) {
          const result = await window.nimbus.synthesizeSpeech(phrase)
          if (!result.audio?.byteLength) throw new Error('No feedback audio')
          audio = result.audio
          cache.current.set(phrase, audio)
        }
        if (disposed) throw new Error('Turn ended')
        const ctx = contextRef.current ?? new AudioContext()
        contextRef.current = ctx
        if (ctx.state === 'suspended') await ctx.resume()
        return { ctx, phrase, buffer: await ctx.decodeAudioData(audio.slice(0)) }
      },
      play: ({ ctx, buffer, phrase }) => {
        const source = ctx.createBufferSource()
        const gain = ctx.createGain()
        gain.gain.value = .72
        source.buffer = buffer
        source.connect(gain).connect(ctx.destination)
        source.onended = () => { source.disconnect(); gain.disconnect() }
        source.start()
        lastSpoken.current = phrase
        return () => { try { source.stop() } catch { /* already ended */ } }
      }
    })
    cancelRef.current = cancel
    return () => { disposed = true; cancel(); cancelRef.current = () => {} }
  }, [active, voiceEnabled, enabled, language, turnSequence])
  useEffect(() => () => { void contextRef.current?.close().catch(() => {}) }, [])
  return () => cancelRef.current()
}
