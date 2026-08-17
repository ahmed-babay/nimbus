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
  envelope.gain.linearRampToValueAtTime(gain, start + 0.045)
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  osc.connect(envelope)
  envelope.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/**
 * Nimbus opening: a low root blooming into a fifth and an octave.
 *
 * Deliberately the slowest of the three. This one plays when the overlay is
 * summoned and nothing is expected of you yet, so it can take its time — the
 * notes arrive a third of a second apart and ring for well over a second,
 * which is what makes it read as a room lighting up rather than an alert.
 *
 * G3-D4-G4: root, fifth, octave. The same intervals the other two chimes use,
 * an octave lower, so all three are recognisably one instrument.
 */
export function playOpenChime(): void {
  note({ hz: 196.0, startOffsetMs: 0, durationMs: 1400, gain: 0.045 })
  note({ hz: 293.66, startOffsetMs: 300, durationMs: 1250, gain: 0.038 })
  note({ hz: 392.0, startOffsetMs: 600, durationMs: 1100, gain: 0.03 })
  // Barely audible shimmer on top; you notice its absence, not its presence.
  note({ hz: 783.99, startOffsetMs: 620, durationMs: 900, type: 'triangle', gain: 0.01 })
}

/**
 * Listening: two sine tones a fifth apart, unhurried.
 *
 * A perfect fifth (D5 over G4) is the most consonant interval there is after
 * the octave, which is why it reads as neutral and considered rather than
 * cheerful. They overlap by design — a sequence of separate notes is a jingle,
 * two notes blooming together is a chime.
 *
 * The spacing was widened after the first pass still felt hurried: 70ms
 * between the notes is close enough to hear as one event, and at that speed
 * a chime reads as a notification. At 200ms you hear the second note arrive,
 * which is the difference between being pinged and being greeted.
 *
 * The quiet octave above is the part you don't consciously hear: it adds the
 * shimmer that separates a real instrument from a test tone, at a level low
 * enough that removing it sounds dull rather than different.
 */
export function playListenStartChime(): void {
  note({ hz: 392.0, startOffsetMs: 0, durationMs: 1000, gain: 0.048 })
  note({ hz: 587.33, startOffsetMs: 200, durationMs: 950, gain: 0.04 })
  note({ hz: 1174.66, startOffsetMs: 210, durationMs: 700, type: 'triangle', gain: 0.011 })
}

/**
 * Done listening: the same fifth, inverted and quieter.
 *
 * Deliberately the same two pitches as the start rather than a new motif, so
 * the pair sounds like one instrument opening and closing rather than two
 * unrelated alerts. Softer, because acknowledging the end of a turn should be
 * felt more than heard — but no shorter, since a clipped ending is exactly
 * what made the arcade version sound like a buzzer.
 */
export function playListenEndChime(): void {
  note({ hz: 587.33, startOffsetMs: 0, durationMs: 780, gain: 0.034 })
  note({ hz: 392.0, startOffsetMs: 180, durationMs: 900, gain: 0.028 })
}
