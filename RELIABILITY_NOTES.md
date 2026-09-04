# Voice and interface reliability pass

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
