// Chiptune UI sounds, synthesized at runtime — no audio assets to ship.
// Square and triangle oscillators with hard, short envelopes and no filter
// sweep: the raw, quantised character of a coin-op cabinet rather than the
// smooth synth pads a lowpass would give.

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
  type = 'square',
  gain = 0.09,
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
  // Near-instant attack and an abrupt tail — 8-bit hardware had no room for
  // gentle curves, and the snap is most of the character.
  envelope.gain.setValueAtTime(0.0001, start)
  envelope.gain.linearRampToValueAtTime(gain, start + 0.006)
  envelope.gain.setValueAtTime(gain, start + duration * 0.7)
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  osc.connect(envelope)
  envelope.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/**
 * Rising arpeggio — the classic power-up / "insert coin" flourish.
 * C5-E5-G5-C6 on a square wave, one step every 55ms.
 */
export function playListenStartChime(): void {
  const steps = [523.25, 659.25, 783.99, 1046.5]
  steps.forEach((hz, i) => {
    note({ hz, startOffsetMs: i * 55, durationMs: 70, gain: 0.085 })
  })
  // Triangle doubling an octave up adds sparkle without extra loudness.
  note({ hz: 2093, startOffsetMs: 165, durationMs: 90, type: 'triangle', gain: 0.045 })
}

/** Descending two-step blip — turn taken, cabinet acknowledging input. */
export function playListenEndChime(): void {
  note({ hz: 659.25, startOffsetMs: 0, durationMs: 65, gain: 0.075 })
  note({ hz: 392, startOffsetMs: 60, durationMs: 110, gain: 0.075, glideToHz: 294 })
}
