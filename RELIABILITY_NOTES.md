# Voice and interface reliability pass

## Sound and presence update

Nimbus now has five locally synthesized cues: arrival, listening, recording received, interruption, and departure. Canceled recordings and silence timeouts do not play the received cue. Settings includes sound previews and persistent toggles for sound effects and thinking acknowledgments.

Slow questions can receive a short “Let me check.” through the configured speech pipeline. Acknowledgment synthesis starts after 1.4 seconds, with a random phrase that excludes the last spoken cue; audio is cached per phrase during the session. It is canceled when the answer arrives, the turn is replaced, voice is muted, or the overlay closes. It does not artificially delay fast answers or claim that a search happened. This improves feedback during the wait; it does not make model inference faster. Short localized cues are included for English, German, Arabic, French and Spanish; other configured languages skip the cue.

The default voices are now Kokoro Michael locally and Brian Neural on the existing Edge fallback. Explicit environment overrides remain respected. Brian was verified in the live voice catalog and successfully synthesized a short sample during this update. The native emergency fallback uses a natural pitch and a slower rate.

The expanded overlay centers the storm orb above the composer, with compact presentation for answers and the command menu. The slash menu inherits the current orb palette, including selected rows and group labels. Focus music, weather and memory shortcuts expose existing capabilities. “Hear again” replays an answer; “Stop response” stops its presentation and discards late output, but does not undo actions already executed by a service.

Request IDs protect streamed text from previous turns. Generation checks protect final answers and errors, and a separate voice epoch prevents delayed TTS from reviving after a mute/unmute cycle. Muting the microphone now discards the recording. The UI distinguishes transcription from an open microphone.

Validation: 12 regression tests, TypeScript checks and the production build pass. `npm run test:ui` (after building) runs the actual Electron renderer with an isolated mock bridge: no live mic, inference, or external actions. It checks palette color and bounds, command drafts, stale answers, mute/unmute races, stopped replies and settings. It also renders the sound score through OfflineAudioContext and verifies finite, non-clipped audio. Screenshots and a five-cue WAV preview are written to `out/qa/`. This is not a recognition-accuracy benchmark or a substitute for testing on speakers and microphones.

## Changes

- Explicit genre commands such as “play jazz”, “put on lofi” and “play focus music” route without an LLM call. Ambiguous requests and named songs still use the model.
- Radio searches race two mirrors and two search styles, each with a seven-second timeout. Failed station searches produce an explanation inside Nimbus instead of falling through to YouTube.
- Browser playback requires an explicit request in the user's words; a model-generated destination alone cannot open it. Negated YouTube/browser requests are respected.
- Voice endpointing counts voiced time rather than elapsed time. Short opening phrases get 1.8 seconds of pause tolerance; the default settled pause is 1.2 seconds, plus the existing tail padding. Requests can last up to 45 seconds.
- Confident neural speech detected during microphone calibration can start the turn. The Groq fallback now receives the requested language and deterministic temperature.
- The overlay and compact dock use layered translucent surfaces. The original storm orb gains a working-state orbit and an answer ripple, with reduced-motion handling.
- The expanded overlay has a Send voice button and an editable “What Nimbus heard” section. Corrections can be resubmitted without speaking again.
- Local model setup no longer labels every hardware-selected download as the 0.8B model. Existing on-device language, recognition and synthesis support remains available; no new paid dependency was introduced.

## Verification

Run `npm test`, `npm run typecheck` and `npm run build`.

Seven regression tests cover routing, explicit browser requests, genre repair, mocked station outages, invalid stream URLs and pause timing. A live jazz lookup returned a station in 414 ms and its stream returned HTTP 200 with `audio/mpeg` during this pass. That is one connectivity observation, not an uptime guarantee. The API's [documentation](https://docs.radio-browser.info/) explicitly allows free use without guaranteeing availability.

The expanded overlay was rendered in Electron using a mocked bridge and visually inspected. That smoke check does not measure real microphone recognition or local inference quality.

## Remaining release work

This is a targeted reliability improvement, not a claim that Nimbus is commercially ready or perfectly accurate. There was no voice dataset supplied and no before/after recognition benchmark was run. Before release, record consented samples across quiet, noisy and accented speech; measure transcription errors, action correctness and latency on supported hardware.

In-app playback here is internet radio, not an on-demand catalog of specific songs. Named tracks still return the existing music result card. Local models need their initial downloads, online services need connectivity, and optional cloud providers retain their existing key and quota requirements. Desktop transparency also needs testing on the Windows versions and graphics drivers you plan to support.
