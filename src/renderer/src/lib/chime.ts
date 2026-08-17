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
  // Near-instant attack and an abrupt tail — 8-bit hardware had no room for
  // gentle curves, and the snap is most of the character.
  // Slow in, slow out. The arcade version snapped on in 6ms and cut off,
  // which is what made it read as a coin-op blip; an attack you cannot hear
  // start and a long tail is what makes a chime sound expensive instead.
  envelope.gain.setValueAtTime(0.0001, start)
  envelope.gain.linearRampToValueAtTime(gain, start + 0.028)
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  osc.connect(envelope)
  envelope.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/**
 * Listening: two sine tones a fifth apart, overlapping rather than stepped.
 *
 * A perfect fifth (D5 over G4) is the most consonant interval there is after
 * the octave, which is exactly why it reads as neutral and considered rather
 * than cheerful. They overlap by design — a sequence of separate notes is a
 * jingle, two notes blooming together is a chime.
 *
 * The quiet octave above is the part you don't consciously hear: it adds the
 * shimmer that separates a real instrument from a test tone, at a level low
 * enough that removing it sounds dull rather than different.
 */
export function playListenStartChime(): void {
  note({ hz: 392.0, startOffsetMs: 0, durationMs: 620, gain: 0.05 })
  note({ hz: 587.33, startOffsetMs: 70, durationMs: 620, gain: 0.042 })
  note({ hz: 1174.66, startOffsetMs: 70, durationMs: 480, type: 'triangle', gain: 0.012 })
}

/**
 * Done listening: the same fifth, inverted and quieter.
 *
 * Deliberately the same two pitches as the start rather than a new motif, so
 * the pair sounds like one instrument opening and closing rather than two
 * unrelated alerts. Shorter and softer because acknowledging the end of a turn
 * should be felt more than heard.
 */
export function playListenEndChime(): void {
  note({ hz: 587.33, startOffsetMs: 0, durationMs: 380, gain: 0.038 })
  note({ hz: 392.0, startOffsetMs: 55, durationMs: 460, gain: 0.032 })
}
