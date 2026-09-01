// Quiet UI tones synthesized at runtime — no audio assets to ship. Sine
// fundamentals and faint triangle overtones match the orb's soft, contained
// energy without turning each voice turn into a notification jingle.

let sharedCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext()
  }
  // A global hotkey isn't a user gesture, so the context can start suspended.
  if (sharedCtx.state === 'suspended') void sharedCtx.resume().catch(() => {})
  return sharedCtx
}

interface NoteOptions {
  hz: number
  startOffsetMs: number
  durationMs: number
  type?: OscillatorType
  gain?: number
  /** Slide to this frequency over the note — used for pew/drop effects. */
  glideToHz?: number
}

function note({
  hz,
  startOffsetMs,
  durationMs,
  type = 'sine',
  gain = 0.05,
  glideToHz
}: NoteOptions): void {
  const ctx = getCtx()
  const start = ctx.currentTime + startOffsetMs / 1000
  const duration = durationMs / 1000

  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(hz, start)
  if (glideToHz) {
    osc.frequency.exponentialRampToValueAtTime(glideToHz, start + duration)
  }

  const envelope = ctx.createGain()
  // A soft onset and natural tail: audible enough to confirm the state change,
  // short enough to stay out of the microphone calibration window.
  envelope.gain.setValueAtTime(0.0001, start)
  envelope.gain.linearRampToValueAtTime(gain, start + Math.min(0.022, duration * 0.2))
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  osc.connect(envelope)
  envelope.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/**
 * Nimbus opening: one warm A with a quiet fifth and a little light above it.
 * It blooms with the orb, but is over in under half a second so the following
 * listening cue does not become a four-note melody.
 */
export function playOpenChime(): void {
  note({ hz: 220, startOffsetMs: 0, durationMs: 480, gain: 0.025 })
  note({ hz: 329.63, startOffsetMs: 70, durationMs: 380, gain: 0.018 })
  note({ hz: 659.25, startOffsetMs: 110, durationMs: 250, type: 'triangle', gain: 0.006 })
}

/**
 * Nimbus closing: the same fifth settling back into its warm root.
 */
export function playCloseChime(): void {
  note({ hz: 329.63, startOffsetMs: 0, durationMs: 300, gain: 0.016 })
  note({ hz: 220, startOffsetMs: 65, durationMs: 360, gain: 0.022 })
}

/**
 * Listening begins with a very short rising fifth. It finishes before the
 * microphone starts calibrating at 300ms, so Nimbus no longer measures its
 * own sound as room noise.
 */
export function playListenStartChime(): void {
  note({ hz: 440, startOffsetMs: 0, durationMs: 220, gain: 0.026 })
  note({ hz: 659.25, startOffsetMs: 55, durationMs: 160, gain: 0.016 })
}

/**
 * Done listening: the same fifth inverted, softer than the start.
 */
export function playListenEndChime(): void {
  note({ hz: 659.25, startOffsetMs: 0, durationMs: 160, gain: 0.016 })
  note({ hz: 440, startOffsetMs: 45, durationMs: 190, gain: 0.012 })
}
