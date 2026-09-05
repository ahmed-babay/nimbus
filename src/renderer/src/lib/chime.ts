import { scheduleSound, type SoundCue } from './sound-design'
import { experienceEnabled } from './experience-preferences'

let context: AudioContext | null = null
let suppressListenStartUntil = 0

/** Synthesized locally: no files to load, no API, no network latency. */
export function playCue(cue: SoundCue): void {
  if (!experienceEnabled('sounds')) return
  try {
    if (!context || context.state === 'closed') context = new AudioContext()
    const ctx = context
    const schedule = (): void => {
      if (experienceEnabled('sounds')) scheduleSound(ctx, cue)
    }
    if (ctx.state === 'suspended') void ctx.resume().then(schedule).catch(() => {})
    else schedule()
  } catch { /* Audio hardware failure must never prevent opening or closing. */ }
}

export function playOpenChime(): void {
  suppressListenStartUntil = Date.now() + 2000
  playCue('open')
}
export function playCloseChime(): void { playCue('close') }
export function playListenStartChime(): void {
  if (Date.now() < suppressListenStartUntil) { suppressListenStartUntil = 0; return }
  playCue('listen')
}
export function playListenEndChime(): void { playCue('received') }
export function playInterruptChime(): void { playCue('interrupt') }
