# Nimbus

A voice-activated Windows overlay assistant. Lives in the system tray, invisible until you
press a hotkey (default **Ctrl+Shift+Space**), then pops up as a small ambient overlay —
speak your question and it answers about weather, stocks, crypto, news, GitHub trending, or
general chat — using only free-tier / no-key APIs.

## Stack

- **Electron + React + TypeScript**, bundled with **electron-vite**
- **Tailwind CSS v4** for the frosted-glass look, **Framer Motion** for the show/hide animations
- **MediaRecorder + Groq Whisper API** (free tier) for speech-to-text — see note below on
  why this replaced the Web Speech API's SpeechRecognition
- **SpeechSynthesis** (Web Speech API, built into Chromium) for text-to-speech — this part
  works fine in Electron and needs no key
- A **global hotkey** (Electron's `globalShortcut`) opens the overlay — see note below on why
  this replaced a spoken wake word
- **Gemini API** (free tier) for intent classification (via structured JSON output, not
  prompt-guessing — see "Intent extraction" below) and spoken response generation
- **OpenWeatherMap** (weather, free key) · **Yahoo Finance** (stocks, no key) ·
  **CoinGecko** (crypto, no key) · **GNews** (news, free key) · **GitHub REST API**
  (trending repos, no key)

> **Why record + Whisper instead of the Web Speech API's SpeechRecognition?** The original
> plan used `SpeechRecognition`, which is built into Chromium — but only *works* in real
> Google Chrome. Electron ships open-source Chromium without the proprietary Google API key
> that `SpeechRecognition` needs to reach Google's servers, so it fails with a `"network"`
> error every time, regardless of your actual connection. `SpeechSynthesis` (text-to-speech)
> has no such dependency and works normally. The fix: `useVoiceInput.ts` records the mic with
> `MediaRecorder`, auto-stops on silence, and sends the audio to `src/services/whisper.ts`,
> which transcribes it via Groq's free-tier Whisper endpoint.

> **Why a hotkey instead of a spoken "Hey Nimbus"?** The original plan used Picovoice
> Porcupine for offline wake-word detection, but Picovoice discontinued Porcupine's free
> tier (June 30, 2026) — it's now a 7-day trial before a paid plan. A hotkey is a genuinely
> free, zero-setup replacement for the "wake up" trigger; voice is still used for the
> actual question once the overlay is open. If you'd rather have hands-free voice
> activation, free open-source options like [openWakeWord](https://github.com/dscripka/openWakeWord)
> (Python) or Vosk-based keyword spotting (pure Node) can be swapped in later — ask and I
> can wire one up.

## Project structure

```
nimbus/
├── src/
│   ├── main/            # Electron main process — tray, overlay window, global hotkey
│   ├── preload/          # contextBridge API exposed to the renderer as window.nimbus
│   ├── renderer/          # React overlay UI
│   │   └── src/
│   │       ├── components/   # Orb.tsx, ResponseCard.tsx
│   │       ├── hooks/         # useNimbus.ts (state machine), useVoiceInput.ts (mic recording)
│   │       └── App.tsx
│   ├── services/          # Gemini, whisper (STT), weather/stocks/crypto/news/github (run in main)
│   └── shared/            # Types + IPC channel names shared by main/renderer
├── resources/             # Tray icon
├── config.json             # Toggle integrations, hotkey, overlay timing
└── .env                    # API keys (gitignored) — copy from .env.example
```

## 1. Install dependencies

```bash
npm install
```

## 2. Get your free API keys

Copy the example env file:

```bash
cp .env.example .env
```

Then fill in `.env` with keys from each of these free services:

| Key | Where to get it | Needed for |
|---|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Chat + intent classification |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | Speech-to-text (Whisper) |
| `TAVILY_API_KEY` | [app.tavily.com](https://app.tavily.com) | Web search **and news** (1,000/month free) |
| `OPENWEATHER_API_KEY` | [openweathermap.org/api](https://openweathermap.org/api) | Weather |
| `GNEWS_API_KEY` | *(optional)* [gnews.io/register](https://gnews.io/register) | Only for per-article news thumbnails — see below |
| `GITHUB_TOKEN` | *(optional)* [github.com/settings/tokens](https://github.com/settings/tokens) | Raises GitHub's unauthenticated rate limit; trending works without it |

Stocks (Yahoo Finance) and crypto (CoinGecko) need no key at all — one less signup. Neither
does the wake trigger, since it's a hotkey configured in `config.json`.

## 3. Run it

```bash
npm run dev
```

This starts the Vite dev server for the renderer and launches Electron. There's no
taskbar or dock icon — look for the Nimbus icon in the system tray. Press
**Ctrl+Shift+Space** or right-click the tray icon → **Show Nimbus** to open the overlay.

Other scripts:

```bash
npm run build       # production build (bundling only — no installer/packaging yet)
npm run typecheck   # type-check main + renderer
```

## How a request flows through the app

1. The global hotkey (or tray icon) shows the overlay.
2. The renderer starts recording the mic (`MediaRecorder`) and shows the **listening** state,
   auto-stopping once it detects ~1.2s of silence.
3. The recorded audio is sent to the main process over IPC and transcribed via Groq's Whisper
   endpoint (`src/services/whisper.ts`).
4. `src/services/gemini.ts` asks Gemini to classify intent (`weather` / `stocks` / `crypto` /
   `news` / `github` / `chat`) and extract parameters (city, ticker, coin, etc.) from the
   transcript.
5. The matching service module in `src/services/` calls its free API.
6. Gemini turns the structured result into a short spoken sentence.
7. The renderer speaks the response with `SpeechSynthesis` and renders a `ResponseCard`
   (type-specific: weather / stock / crypto / news / github / plain text).
8. Nimbus listens again for a follow-up, so a conversation continues without re-pressing the
   hotkey. It closes when you say a dismissal ("stop", "that's it for today", "never mind",
   "bye Nimbus"), press `Esc`, or stay silent.

## Local place names

Speech recognition is bad at place names in a language other than the one the sentence is
in. Measured on real audio, with an English sentence containing German names:

| You said | Whisper heard |
|---|---|
| Luisenplatz | "Lusenplatz" |
| Herrngarten | "Herngarten" |
| Mathildenhöhe | **"Mephilden hole"** |

Nothing downstream can geocode "Mephilden hole", so this is fixed in two places, configured
once under `location` in `config.json`:

```json
"location": {
  "home": "Luisenplatz, Darmstadt",
  "region": "Darmstadt, Hesse, Germany",
  "placeLanguage": "German",
  "frequentPlaces": ["Luisenplatz", "Herrngarten", "Mathildenhöhe", "Hauptbahnhof"]
}
```

1. **The transcriber gets a vocabulary hint.** Whisper's `prompt` biases vocabulary, not
   behaviour, and the difference matters: *describing* the region ("the speaker is in
   Darmstadt, Hesse") changed nothing at all, while listing actual place names fixed
   "Luisenplatz" outright. That's what `frequentPlaces` is for — put the places you
   actually say in it.
2. **The intent router repairs what's left**, which is the reliable half. Told the region,
   it turns "Mephilden hole" into Mathildenhöhe and "Herngarten" into Herrngarten before
   anything is looked up — and it expands vague references into the place they mean, so
   "the airport" becomes Frankfurt Airport rather than, as it did before this, a metro
   station in **Copenhagen**.

Distant places still work: "how far is Cologne" resolves to Köln, not to a local business
with Cologne in its name. This affects place names only — replies stay in
`language.native`, which is stated explicitly to the model, because once the data coming
back is full of German station names an unprompted model starts answering in German.

## Living in a language that isn't yours

Set the language you think in:

```json
"language": { "native": "English" }
```

Nimbus then keeps **two** languages straight — yours, and whatever is on screen:

- **Explanations arrive in your language.** Screenshot a letter, a form or an error in any
  language and the answer comes back in yours, leading with what it actually means for you:
  what's being asked, any deadline, any amount. Names, dates, reference numbers and sums are
  quoted exactly rather than translated.
- **Replies are drafted in *their* language.** The **Reply** button on selected text writes
  back in the language of the original, matching its formality, with `[square brackets]`
  for anything only you can fill in.
- **Translate** targets your language, since the common case is a foreign document you need
  to read.

The point is the round trip. A German rent-increase notice, with `native` set to Arabic:

> **Explain** → *"هذا النص عبارة عن إشعار رسمي … زيادة الإيجار بمقدار 78 يورو … الموعد النهائي 31 يناير 2027"*
> **Reply** → *"Sehr geehrte Damen und Herren, … stimme ich der Mieterhöhung auf 858,00 EUR
> zum 1. März 2027 hiermit zu … Vorgangsnummer: MV-2027-4471"*

You understand it in your language; the reply goes back in theirs, correctly formal, without
you writing a word of it.

## Running on your own machine

Three of the four models Nimbus uses can run locally, downloaded once from settings and
then never touching the network. Each is independent — local speech recognition works
perfectly well while answers still come from Gemini.

| Piece | Model | Size | Replaces | Measured |
|---|---|---|---|---|
| Answers | Qwen3.5 0.8B | 532 MB | Gemini | see `local-llm.ts` |
| Speech to text | Whisper base | 290 MB | **a required Groq key** | 370ms for a 3s utterance |
| Text to speech | Kokoro 82M | 330 MB | Edge Read Aloud | 588–650ms per sentence |
| Wake word | — | — | — | keyword spotting, see below |

All of them run on **WebGPU**, which ships bundled with `onnxruntime-node` on every
platform — there is no CUDA toolkit for anyone to install. That choice was measured rather
than assumed, on an RTX 3070 laptop:

- **Whisper**, 13.7s of German: 4742ms on CPU, **690ms on WebGPU**, identical transcripts.
  DirectML was tried and is unusable — quantised weights fail outright and fp32 took 170s
  to load.
- **Kokoro**, one 7.3s sentence: ~10.7s on CPU (slower than saying it), **~600ms on
  WebGPU**. There is deliberately no CPU fallback, because it would be worse than the
  cloud in every case.

Speech recognition is the one that changes what Nimbus *is*: transcription used to be the
last thing that made an API key mandatory, so the overlay simply could not hear you
without one. Now the key is optional and it works on a plane.

Two quirks worth knowing if you touch this:

- **Audio is decoded in the renderer**, not the main process. Chromium has the WebM/Opus
  codec and Node does not, so `src/renderer/src/lib/pcm.ts` hands 16kHz mono samples across
  IPC rather than shipping compressed audio to a process that would need a codec bundled to
  read it.
- **Whisper guesses language badly on short clips** — three seconds of German came back as
  *"Good evening. In the today's"* because it decided the clip was English. Both callers
  now say what language to expect rather than letting it detect one.

### "Hello Nimbus"

Off unless `wakeWord.enabled` is set in `config.json`, and it is honest about what it is:
**keyword spotting, not a trained wake-word model.** A model like openWakeWord answers
exactly one question — "was that the phrase?" — and never turns nearby speech into text.
There is no pretrained model for "Nimbus", and making one means generating synthetic speech
and training a classifier offline.

So the trade is bounded instead of hidden. It refuses to run without the on-device
recogniser, so ambient audio is never uploaded anywhere; the main process returns only a
boolean, so the words never reach the renderer; and nothing is stored. It also suspends
itself while the overlay is open or Nimbus is speaking — otherwise it hears its own voice
say the name and wakes in a loop.

Matching allows one edit, so "nimbis" and "limbus" wake it while "minibus" does not. Two
edits was tried and dropped: it admits "nimble", an ordinary English word, to catch a
mishearing that was guessed at rather than observed. A false positive opens a hot
microphone mid-conversation; a false negative costs you saying the name twice.

## Settings: API keys without a .env file

Open settings from the tray and every key can be pasted in directly, so Nimbus is usable by
someone who will never create a `.env`. Two rules shape it:

- **`.env` always wins.** A key in the environment is what a developer expects to be
  running, so stored keys only fill gaps and environment-supplied ones are shown as locked.
  Opening this panel on an already-configured machine cannot silently shadow a working key.
- **Stored keys are encrypted at rest** with Electron's `safeStorage`, which on Windows is
  DPAPI tied to your user account. Plain JSON would have been *worse* than the `.env` it
  replaces: `.env` is at least gitignored and obviously secret-shaped, while a settings file
  gets copied around. A store copied to another machine simply fails to decrypt, which is
  the intended outcome.

Saving a key applies it immediately rather than at the next launch — being told to restart
after typing a key is a poor first run. The panel never displays a stored key, only a masked
fragment (`AIz••••x9Qk`) so you can tell which one is in there.

Keys are pushed into `process.env` once at startup, so every service goes on reading
`process.env.X` exactly as before and none of them needs to know settings exist.

### Choosing the answer model

The panel lists the models **your key can actually use**, fetched from the provider rather
than hardcoded — a hardcoded list is wrong within weeks, and wrong in a way you can't fix.
Embedding, TTS and image-generation models are filtered out since they can't answer a
prompt. Verified live: 34 usable Gemini models.

All three provider endpoints are implemented and reachable — a deliberately invalid key
returns "That key was rejected" from OpenAI and Anthropic alike, confirming the auth shapes.

### Switching provider

Every model call — intent routing, chat, research synthesis, screen reading — goes through
`src/services/llm.ts`, so the provider is a setting rather than a rewrite. The prompts were
already provider-independent; only the transport differs.

Structured output is the one place the three genuinely diverge. Gemini *constrains
generation* to a schema, which is stronger than anything the others expose, so it keeps
doing that. OpenAI is asked for JSON mode and Anthropic is asked in the prompt, with the
shape described either way — a weaker guarantee, which is why the JSON parse strips code
fences and every caller already degrades to a plain answer rather than failing.

Gemini keeps its two-model race (see `gemini-client.ts`): free-tier congestion shows up as a
request that takes 20-30 seconds rather than one that fails, so the fallback model is raced
alongside after 6 seconds. That tuning is specific to its free tier and doesn't apply to the
paid providers.

**What's verified, precisely:** Gemini is exercised end to end through the adapter —
classification 4/4, event extraction, streaming and non-streaming, all matching the
behaviour before the refactor. OpenAI and Anthropic are built to their documented APIs and
confirmed as far as authentication (a deliberately invalid key returns the right error from
both), but have **not** been run against a live paid key. A failure surfaces as a spoken
error, not a wrong answer.

## Finding out what it can do

Features here are reached by *saying* them, not by pressing something. That's what keeps the
app at **three global hotkeys** no matter how much it learns to do — a hotkey is only
justified when the action needs the state of the app you're currently in (the screenshot and
the text selection qualify; nothing else does). Everything added since then — briefings,
reminders, events, memory, directions — added zero shortcuts.

The cost of that is discoverability: an invisible feature is worse than an awkwardly bound
one. So there is exactly one thing to learn. **Type `/`** and every capability is listed,
filterable, grouped:

```
/ trans
  Getting around
    Next departures        “when is the next train to Frankfurt”
    Tell me when to leave  “tell me when I need to leave for Frankfurt”
  On your screen
    Ask about the screen   “what does this letter say”   Ctrl+Shift+S first
```

The detail that makes it more than a menu: picking an entry **types its example into the
input** instead of running a hidden command. You see a phrasing that works, can edit it
before sending, and learn it — so the palette is a training wheel that removes itself. Next
time you just say it.

Arrow keys move, Enter or Tab picks, Esc closes the palette *only* — it stops propagation so
the global Escape handler doesn't close the whole overlay, which is a startling answer to
backing out of a menu. Only a leading slash opens it, so "what's 8/3" types normally.

The list lives in `src/shared/capabilities.ts`. Anything not in it is, in practice, a feature
nobody will find — so it's the file to update when adding one.

## Typing instead of talking

The overlay has a text field, focused the moment it opens — press the hotkey and start
typing. Voice is unusable in an open office, a quiet house at night, or a noisy room, and
without this the app had nothing to offer in those situations.

Typed input goes through the **same router as speech**, so it works everywhere voice does:
asking a question, following up on a screenshot, or instructing a text action. Two details
that matter in practice:

- The mic closes on the **first keystroke**, before it can hear typing and submit a
  competing transcript.
- After a typed turn the mic **stays closed** — someone who chose to type usually can't
  talk, and reopening it would defeat the point. The hotkey re-enables voice.

## Act on selected text

Highlight text in **any** application — Word, VS Code, a browser, a PDF — and press
**Ctrl+Shift+A**. Nimbus grabs the selection and offers *Fix · Rewrite · Summarize ·
Explain · Translate*, then either copies the result or **pastes it back over the original
selection**.

The mic also opens, so anything the buttons don't cover you can just say:

> *"translate this to German"* · *"make it shorter and more polite"* ·
> *"turn this into bullet points"* · *"explain it like I'm five"*

The Translate **button** targets `textActions.translateTo` in `config.json` (default
English); speaking a language overrides it for that one use.

How it reads another app's selection, since there's no API for that:

1. Records which window has focus, then sends it **Ctrl+C** (via PowerShell `SendKeys`) —
   the same thing you'd do by hand.
2. Reads the clipboard, then **puts your previous clipboard contents straight back**. Using
   Nimbus never costs you whatever you had copied.
3. A sentinel value distinguishes "nothing was selected" from "the selection happened to
   match what was already on the clipboard", so it can tell you to select something first
   instead of silently acting on stale text.
4. *Replace selection* restores focus to the original window (`SetForegroundWindow`) before
   pasting, because showing the overlay took focus away.

The capture costs roughly 0.7s, which is PowerShell's start-up time — a persistent helper
process would remove it if that ever becomes annoying.

## Paperwork mode

Capture an official letter (Ctrl+Shift+S) and ask about it — "what does this letter say",
"was steht in diesem Schreiben" — and instead of prose you get the four things that actually
matter from a Behörde letter: **what it is, what it wants from you, by when, and how much.**
Those are the hardest things to find in a formal letter written in a language you don't read
well, and the most expensive to get wrong.

Verified against a rendered Stadtwerke electricity bill:

```
type      : Invoice              sender    : Stadtwerke Darmstadt AG
amount    : 284,60 EUR           reference : R-2026-88134
deadline  : 2026-08-31   ← from "bis zum 31.08.2026"
action    : Transfer the requested amount quoting the invoice number before the deadline.
also      : late interest 5pp above base rate · monthly payment auto-rises to
            96,00 EUR on 01.09.2026 · right to object in writing within six weeks
```

It picked the invoice number over the customer number, preserved the German decimal comma,
resolved the deadline to a real date, and caught all three consequential clauses — while
answering in `language.native`.

The deadline is a **button**, not a line of text: one click sets a reminder for it, because a
due date you have to re-enter by hand is a due date you forget. "Draft a reply" and "More
detail" sit next to it.

Routing is a **keyword test**, not another model call — instant, free and predictable, in
both your language and German (`Schreiben`, `Rechnung`, `Bescheid`, `Mahnung`, `Frist`…).
"What is on my screen" and "what is this error" deliberately stay on the prose path. If the
structured read fails for any reason, it falls through to the ordinary screen answer rather
than losing the capture.

### On ambient capture, deliberately not built

Two features were designed and then **cut on privacy grounds**, and the reasoning is worth
keeping:

- **Screen rewind** (a rolling buffer of screenshots so you could ask about something that
  already scrolled past)
- **Clipboard watching** (offering actions on whatever you copy)

Everything Nimbus reads today is *explicitly captured*: you press a hotkey, one frame or one
selection is taken, used for that turn, and dropped. Consent is per-capture and the blast
radius is the thing you chose. Both cut features invert that — consent once, capture forever
— and you cannot pre-approve what will be on screen or on your clipboard in two minutes.
Password managers work by putting secrets on the clipboard; a screen buffer is a new
on-disk archive of banking, messages and internal tools, and answering from it means
sending those frames to a model. The payoff was convenience. Bad trade, so: not built.

The rule this leaves: **explicit capture is fine, ambient capture of content is not.** Wake
word is the interesting edge — ambient *listening* but not ambient *disclosure*, since Vosk
runs offline and nothing leaves the machine until the wake word fires.

## Listening along: meetings and subtitles

Two modes where Nimbus listens for a long time and says nothing at all. Both are started
explicitly — `/` then **Record a meeting** or **Live subtitles** — and both stay within the
rule above: you turn them on, you can see they are running, and you turn them off.

Both need to hear what the *computer* is playing, not just the microphone, which Electron
allows through a display-media handler (`src/main/system-audio.ts`). A screen source has to
be named because an audio-only stream isn't offered, so the renderer stops the video track
the moment it arrives — no frame is ever decoded or stored.

### Recording a meeting

Nimbus captures your microphone and the system's output as **two separate streams**, and
that is the whole trick behind the dialogue transcript. Real diarisation — working out who
is who from a single mixed track — isn't available on the free tier, but a call already
arrives as two physically distinct signals: your mic is you, everything else is them.

The limitation to know about: everyone on the far end is one speaker called "Them".
Splitting three colleagues out of one mixed stream isn't possible here, and guessing would
produce a transcript that is confidently wrong about who said what.

The transcript is **collapsed while recording** — during a meeting the screen belongs to the
meeting, and live captions unrolling over the call are in the way. What stays visible is
proof of life: that it's running, how long for, and how many lines it has heard. It opens by
itself once you stop, which is when the transcript becomes the point. Nothing is written to
disk unless you press **Save to a file** and choose where. **Summarise** returns what was decided, what someone now has to
do, and what was left open — all four fields are required of the model, because with only
the summary required it returned an empty actions list for a transcript that plainly
contained three, and buried one in the prose instead.

### Live subtitles

For a film or video in a language you don't read, with no subtitle track. It listens to the
system audio, transcribes it, translates it, and puts plain white-on-dark lines at the
bottom of the screen. Nothing is spoken, the microphone is never opened, and no chime plays
— a sound effect every few seconds during a film would be unbearable.

**This is delayed subtitling, not simultaneous interpretation.** A phrase has to finish
before it can be transcribed, so a line lands roughly one phrase behind the audio plus the
round trip. Measured end to end on German broadcast speech: 280-500ms to transcribe,
45-900ms to translate.

Subtitles cut audio into much shorter pieces than meetings do (1.1s minimum, 3.5s maximum,
against 2.5s/7s), which is a deliberate trade of transcription context for lag. Measured on
the same clip, that roughly doubled the number of lines — 3 to 6 — while the delay after a
phrase ends stayed at about 800ms. That 800ms is the network round trip and it is the floor:
shortening the pieces makes text *track* the speaker instead of arriving in paragraphs, but
nothing short of running the models locally makes a line appear while the word is still being
said. The cost is slightly more fragmentation, since a sentence spoken without pauses now
gets split across two lines.

Three things were found by measurement here, and each one is load-bearing:

- **Whisper's translate endpoint doesn't translate.** Groq's `/audio/translations` returned
  German audio as German text — with an English prompt, and at temperature 0 — and
  `whisper-large-v3-turbo` rejects that endpoint outright with a 400. Translation is
  therefore a separate hop through `src/services/translate.ts`, which is also *faster* than
  the model would be and costs no model quota at all.
- **Every piece needs its own recorder.** A single MediaRecorder started with a timeslice
  puts the container header only in the first blob; every later piece is an undecodable
  fragment.
- **Cut at pauses, not on a stopwatch.** A fixed interval splits sentences mid-phrase and
  the translations come out as fragments. Recording strictly back to back also *loses* the
  audio between one recorder stopping and the next starting — four consecutive words
  vanished at one boundary in testing — so the next recorder now starts before the previous
  one stops.

Rate limits are not a problem in practice: Groq allows 7200 audio-seconds per hour, and an
hour of film costs about 4500 with the overlap.

## Ask about your screen

Press **Ctrl+Shift+S** (configurable) and the screen freezes so you can **drag a box around
the part you care about** — then ask a question about it. `Enter` takes the whole display,
`Esc` cancels without capturing anything.

Selecting a region isn't only tidier, it's cheaper and sharper. The crop happens at native
resolution *before* the downscale, so a small selection gives the model a genuinely
higher-detail view rather than an enlarged blur — and it sends far less:

| Selection | Sent to the model |
|---|---|
| Whole screen | 106 KB |
| Centre 50% | 36 KB |
| Small region | 3 KB |

Set `screenshot.selectRegion` to `false` in `config.json` to go straight back to
whole-display capture.

Nimbus captures the display your cursor is on, then listens for a question about it — *"what does this error mean?"*, *"explain this
chart"*, *"what is this dialog asking me?"*. The answer comes from Gemini's vision support,
which is part of the same free tier, so it needs no extra key.

Design decisions that matter here, since this reads your screen:

- **Capture only ever happens on that explicit hotkey.** Nothing is captured automatically,
  and no phrase triggers it.
- **Nimbus hides itself from its own screenshot.** If the overlay is already open it's
  hidden — not closed — for the capture, then restored with its conversation and state
  intact. Hiding isn't instant on screen, so there's a short repaint delay before the frame
  is grabbed; without it the overlay still appeared in the capture despite the window
  reporting itself hidden.
- **The screenshot is shown back to you** — as a thumbnail while you ask, and on the answer
  card afterwards — so it's never ambiguous what Nimbus looked at.
- **It's held only for the turn that uses it.** The image lives in a single main-process
  variable, is cleared the moment a question consumes it, and is dropped when the overlay
  closes or the normal hotkey is pressed. It's never written to disk.
- Capture happens *before* the overlay is shown, so Nimbus isn't in its own screenshot.

## Rich response cards

Answers render as visuals where the data supports it, not just spoken text:

| Query | Card |
|---|---|
| "how's Apple doing" | Price + **30-day sparkline** (green/red by trend) |
| "what's bitcoin at" | Price + **7-day sparkline**, 24h delta |
| "who is Marie Curie" | **Photo + description** from Wikipedia |
| "news about tesla" | Headlines with **thumbnails** |
| "who won the final" | Ranked results with source domains |
| "play Bohemian Rhapsody" | Video thumbnail + duration, opens in your browser |
| "next train to Frankfurt" | **Departure board** — times, line badges, platform, changes |
| "how far is Cologne" | **Map with the route drawn**, and a tab per travel mode |
| "how does a jet engine work" | **Diagrams and photos** alongside the explanation |

Two implementation notes worth knowing:

- **Charts are inline SVG** (`src/renderer/src/components/Sparkline.tsx`), not a charting
  library — nothing added to the bundle, and they inherit the theme directly. The stock
  sparkline costs no extra request: the same Yahoo call already returns the series, it was
  just being discarded.
- **Images arrive as base64 `data:` URIs**, fetched in the main process
  (`src/services/images.ts`). The overlay's CSP is locked to `'self'`, so remote `<img>`
  URLs are blocked outright — and routing through main also sidesteps hotlink protection
  and keeps the renderer from making arbitrary outbound requests. They're downscaled to
  480px and re-encoded as JPEG via Electron's built-in `nativeImage` before crossing IPC
  (a press photo went from ~427KB of base64 to ~43KB — it's displayed in an 80px strip).
  Images are time-limited and always optional: a failed image never fails the answer.

### Pictures for explanations

When an answer would be clearer with a picture, one comes with it — a labelled cutaway for
"how does a jet engine work", the cycle diagram for "what's the Krebs cycle". These come
from **Wikipedia** (`src/services/illustrate.ts`): free, no key, and unlike an image search
it returns the *explanatory* picture rather than a stock photo.

The whole trick is asking it the right thing. Wikipedia search is only as good as its
query, and the raw utterance is a bad one — "tell me about the Roman aqueducts" matched
*Chinatown (1974 film)*. So the intent classifier extracts a bare article title alongside
the intent (`params.topic`), which costs no extra model call: "why is the sky blue" becomes
**Rayleigh scattering**, "what's the Krebs cycle" becomes **citric acid cycle**. It's left
empty for jokes, arithmetic, prices and schedules, so pictures appear when they explain
something and not otherwise.

Two details:

- The fetch runs **in parallel with the answer**, so illustrations cost no extra
  wall-clock time, and a failure never blocks a reply.
- Wikipedia's diagrams are rendered SVGs — dark line art on a **transparent** background.
  The image pipeline flattens everything to JPEG by default, which paints transparency
  black and would have turned every diagram into a black rectangle on this theme. Those
  keep their alpha instead and the card puts them on a light plate; photos still get JPEG.

### News: GNews is optional

News runs on the Tavily key you already need for search (`topic: "news"`), so there's no
second signup. GNews is a fallback-in-reverse: set `GNEWS_API_KEY` **only** if you want a
thumbnail per headline, which is the one thing Tavily can't do — it returns images for the
topic rather than per article. Those topic images render as a single banner, never pinned
onto an individual headline they may have nothing to do with.

Entity cards come from Wikipedia (free, no key), so "who is X" works even before a Tavily
key is set. The classifier only routes to Wikipedia when the question is *about* a named
thing — "who is the CEO of Nvidia" is a relational question and goes to web search, since
Wikipedia would return the tangential company page.

## Maps and directions

"How far is the Mathildenhöhe from here", "how long to Cologne by car", "is the botanical
garden walkable" — `src/services/maps.ts` answers with a drawn map and **every travel mode
costed at once**, so the card's Drive / Bike / Walk / Transit tabs switch instantly without
another request. Say how you want to travel and that tab opens first; otherwise pick one.

"From here" means `location.home` in `config.json`. Set it to a street address if you want
the walking times to be honest — the fallback is IP geolocation, which is city-level at
best and put a Darmstadt machine in Frankfurt during testing.

Everything here is keyless:

| Piece | Service | Why |
|---|---|---|
| Place → coordinates | **Nominatim** | Biased to a ~55 km box around home, so "the botanical garden" means the local one. |
| Car / bike / walk | **Valhalla** (FOSSGIS) | Real per-mode costing. |
| Public transport | **Transitous** | The same departure lookup the transit card uses, so "by train" gives actual services. |
| The map itself | **OpenStreetMap tiles** | ~4-9 tiles per lookup, fetched once. |

Three things learned the hard way, all verified rather than assumed:

- **The OSRM demo server is car-only.** Its URL takes a `/foot/` profile and cheerfully
  answers with car speeds — it put 4.1 km on foot at nine minutes. Valhalla costs the same
  trip as 12 min driving, 13 cycling, 40 walking. That's why routing goes to Valhalla.
- **Never hand a second geocoder the raw words.** Nominatim resolved "Cologne" to Köln
  while Transitous, geocoding the same string itself, matched a same-named village — the
  card offered an eleven-hour, four-change bus chain for what is a 101-minute ICE trip.
  `findJourneys` now takes coordinates, and the fix also repaired short trips, where the
  stop-name lookup had been silently returning no journeys at all.
- **Valhalla encodes its route geometry at polyline precision 6**, not the usual 5. A
  stock decoder reads those coordinates ten times too large and lands you in the ocean.

The map is a still, not a pannable widget: tiles are downloaded and the route projected to
pixels in the main process, so the card just places images and draws an SVG line over them.
That keeps it inside OpenStreetMap's tile policy for light use, and means the route can be
drawn in the theme's own colours over an ordinary OpenStreetMap basemap.

## Trains, trams and buses

"When's the next train to Frankfurt", "how do I get to Wiesbaden", "S-Bahn to the airport"
— these route to `src/services/transit.ts` rather than to web search, because a search
returns timetable *pages* and this returns actual departures: the time it leaves, the line
you board, the platform, the arrival, and how many changes.

Say where you're going and it assumes you're leaving from `transit.defaultOrigin` in
`config.json`; name both ends ("from Frankfurt to Cologne") and it uses those instead.

Data comes from **[Transitous](https://transitous.org/)** — free, no API key, no account.
It runs MOTIS over the national DELFI dataset, so coverage includes regional trains,
S-Bahn, trams and buses rather than long-distance rail alone. Two things worth knowing if
you touch this file:

- It **requires a descriptive `User-Agent`** by policy. A generic one gets `403`.
- `*.db.transport.rest` is the other free keyless option and was the first choice, but it
  returned `503` with an empty body on every attempt while this was being built.

The card colour-codes line badges the way the operators do (S-Bahn green, U-Bahn/tram
cyan, ICE/IC magenta, RB/RE yellow) and counts down to the next departure, so the number
you actually act on — "in 6 min" — is the one you see first.

### Keeping an eye on one journey

Add "keep me posted", "let me know if it's delayed" or "tell me about any delays" to a
transit question and Nimbus stops answering once and starts *following* that train.

```
"I want the 17:30 to Frankfurt, keep me updated"
  -> The S6 to Frankfurt Hbf leaves Darmstadt Hauptbahnhof at 17:32.
     It's on time right now. I'll tell you if that changes.

  ...later, unprompted:
  -> Your S6 to Frankfurt Hbf is now 8 minutes late, leaving at 17:40.
```

This needs no new API and no key. Every leg the timetable returns carries both
`scheduledStartTime` and `startTime` — the difference between them *is* the delay — so a
watch is a stored trip plus a poll every 150 seconds.

Two details in `src/services/watchers.ts` that are less obvious than they look:

- The train is followed by **`tripId`, not by time**. Re-planning the route and taking
  "the departure nearest 17:30" would quietly switch to a *different* train the moment the
  watched one slipped past the next one.
- Re-checking searches from **20 minutes before** the scheduled departure. The planner
  returns departures strictly *after* the time it's given, so asking it for the watched
  train's own scheduled time returns every train except that one. That bug made watches go
  permanently silent — which is indistinguishable from "no delays", and the one failure a
  delay alert must not have.

Updates are only spoken when the delay actually moves by two minutes or more. A watcher
that announced "still on time" every few minutes would be switched off within the hour,
and then it wouldn't be there for the delay that mattered. Watches are dropped ten minutes
after the train leaves.

## Clickable results

News headlines, search results, GitHub repos and music cards all open in your default
browser on click. URLs come from third-party API responses, so the main process validates
them before handing anything to the OS: **only `http:` and `https:` are ever opened**.
`file:`, `javascript:`, `data:`, `ms-msdt:` and UNC paths are rejected, which stops a
hostile search result from triggering something local.

## Music and video

Playback splits two ways, because what's legally streamable differs:

| You say | What happens |
|---|---|
| "play some jazz", "put on lofi", "play relaxing music" | **Plays inside Nimbus** — internet radio stream with play/pause and a live indicator |
| "play Bohemian Rhapsody", "play a video about sourdough" | Opens in your browser on YouTube |

The classifier decides which (`params.playback`), and a station request that finds no match
falls back to YouTube rather than failing.

**In-app playback (radio)** uses [Radio-Browser](https://www.radio-browser.info/), a free,
key-free index of public radio streams. Those are plain `audio/mpeg` over HTTP, so an
`<audio>` element plays them directly — no browser hand-off. `src/services/radio.ts` prefers
https streams and tries several mirrors; `useRadioPlayer.ts` keeps one long-lived audio
element outside React's tree so playback survives re-renders.

**Why specific tracks can't play in-app:** extracting audio from YouTube breaches its terms
of service, and scrapers that do it break whenever YouTube changes a response format. The
sanctioned route is YouTube's own player, so those open in the browser with your own
session. Search itself goes through **Piped** (key-free, multiple instances tried in turn).

### Controlling playback

While a station is playing the mic is **closed on purpose** — speakers feed straight back
into it and Whisper transcribes the music as commands. To talk:

1. **Press the hotkey.** The music ducks to a pause and Nimbus starts listening, with the
   player still on screen.
2. Say **"stop the music"** (or "pause", "turn it off", plain "stop") — playback ends and it
   keeps listening, so you can carry straight on with another question.
3. Ask something else instead, and the station is dropped rather than resuming under the
   answer.
4. Say nothing, and the music **resumes** where it left off.

A bare **"stop"** is context-sensitive: it stops the *music* while something is playing, and
closes Nimbus when nothing is. `Esc` always closes everything. The overlay also won't
auto-close during playback, since closing tears down the audio element and would cut the
music off.

If you'd rather have *specific tracks* playing in-app too, that needs a catalogue that
licenses direct streaming — [Jamendo](https://developer.jamendo.com/) (free key, Creative
Commons) is the usual choice, and would slot in beside `radio.ts`.

## The daily briefing

"What does my day look like" / "brief me" / "catch me up" — weather, the next departures on
your usual route, reminders due in the next 18 hours, and today's headlines, in one answer.

No new capability: it's five services that already existed, asked at once. All three network
sections run in parallel (a briefing that took the sum of their latencies would be slower
than asking the questions separately) and each is settled independently, so a section that
fails is simply absent rather than taking the briefing down with it. A real run assembles in
about 2.4 seconds.

Configure it under `briefing` in `config.json`: `weatherCity` and `newsTopic` (empty is
fine — see below).

### Your own days

Tell Nimbus what's happening and it carries it: *"I need to go to Düsseldorf for the Reply
Leadvise event from the 24th to the 27th"*, *"I'm at my girlfriend's this weekend"*,
*"dentist on Tuesday"*. Ask *"what have I got coming up"* to hear the list, or *"cancel the
Düsseldorf trip"* to drop one.

Events are a third kind of thing, deliberately separate from the other two: a **fact** is
true until you change it, a **reminder** fires once at a minute and is done, an **event**
occupies whole days, is worth mentioning on each of them, and *stops existing on its own*
once its last day passes. Expiry happens on read rather than on a timer, so a finished event
is never mentioned again no matter how long the app was shut. Dates are stored day-granular
(`YYYY-MM-DD`) because "the 24th to the 27th" has no meaningful time of day, and pretending
otherwise only invents timezone bugs.

The first version of this section was a **fixed daily commute**, and it was wrong: you don't
take that train most days, so it trained you to ignore the section. Departures now appear
only when an event actually calls for them — one starting today or tomorrow, somewhere other
than home.

**Dates come from their own model call**, not from the intent router. The router reliably
recognises *that* something is an event and just as reliably drops the dates: its prompt
covers fifteen intents and ~25 parameters, and the extra fields fall off the end. "Reply
Leadvise event from the 24th to the 27th" came back with a title and **no dates at all**, and
tightening the wording made it worse — the one case that had worked stopped working too. A
short single-purpose prompt gets every case right, and only runs when an event is actually
being created:

| You say (today is Sun 16 Aug) | Extracted |
|---|---|
| "…Reply Leadvise event from the 24th to the 27th" in Düsseldorf | 24 Aug → 27 Aug @Düsseldorf |
| "dentist on Tuesday" | 18 Aug |
| "I'm at my girlfriend's this weekend" | 22 Aug → 23 Aug |
| "conference in Berlin next Monday and Tuesday" | 24 Aug → 25 Aug @Berlin |

Two things the briefing exposed that were quietly wrong elsewhere:

- **Generic headlines are worthless.** Asked for "top news headlines today", the news
  provider returns aggregator filler — *"School Assembly News Headlines"*, *"MONDAY NEWS IN
  A RUSH"*. Asked for a **country** it returns real reporting from DW, Reuters and Forbes.
  So `newsTopic` defaults to the country in `location.region`, which is also the news a
  briefing should carry: the one where you live.
- **OpenWeatherMap calls this location "Regierungsbezirk Darmstadt"** — the administrative
  district rather than the city. Its coordinates are right, so the briefing shows the
  configured city name instead; adding a country code to the query does not help.

## Reminders, and knowing when to leave

"Remind me in 20 minutes to call the landlord" is table stakes. The one worth having is
**"tell me when I need to leave to catch the last train to Frankfurt"** — Nimbus works the
moment out from the live timetable rather than a clock time you had to know in advance.
Ordinary AI assistants can't do this; it needs a departure board and a door-to-door plan.

The walk is free to account for. Because the journey planner is handed *coordinates* rather
than a station name, MOTIS plans door-to-door and puts a walking leg on the front — so the
itinerary's own start time is already the moment you must be out of the door, and the first
transit leg's departure is when the train actually goes. The difference between them is the
walk, with no second routing request. Three minutes of slack are subtracted on top. A real
run: the F at 15:31 to Frankfurt Hbf, one minute to the stop, alarm set for 15:27.

Firing is a 30-second **poll**, not a `setTimeout` per reminder, in
`src/main/reminder-scheduler.ts`. Timers don't survive a restart, drift while the machine is
asleep, and silently cap out around 24.8 days; a sorted list checked twice a minute behaves
correctly when the laptop has been shut since the reminder was set, and anything that came
due while the app was closed fires on startup. Due reminders are marked fired in the same
step that claims them, so one can't fire twice.

When a reminder fires, Nimbus shows itself and speaks — but **does not open the microphone**.
`showOverlay` always sends WAKE, which starts recording; that's right when you summoned it
and wrong when Nimbus is the one initiating, since a hot mic in an empty room is exactly how
ambient noise became hallucinated questions earlier in this project. `presentOverlay` exists
for that case. A desktop notification goes out as well, in case you're full-screen in
another app.

## What Nimbus remembers between sessions

Until this existed, closing the app meant every answer it had ever given was gone and it
re-learned who you were on each launch. `src/services/memory.ts` keeps two things in
`userData/memory.json`, split because they behave differently:

**Facts** — a short profile you dictate. "Remember that I take the RB68 to work", "my home
station is Luisenplatz", "forget what I said about the gym". These are small enough to put
in front of the model on *every* turn, which is the entire point: it stops re-asking what
it already knows. The classifier rewrites them into standalone statements, so "remember
that I take the RB68 to work" is stored as "Takes the RB68 to work". Capped at 40, and
restating one replaces it rather than growing the prompt.

**Answers** — an append-only archive, searchable by voice: "what was that station you told
me about", "what did I ask about the tickets". Never injected wholesale; there could be
thousands. Search is plain keyword scoring with a double weight on matches in the question,
which carries the topic more reliably than the answer body. Deliberately not embeddings —
that would mean a paid API on every write or a local model, and for "what was that station
you mentioned" the words you say are very nearly the words you said the first time.

Two robustness details, both verified rather than assumed: writes go through a temp file
and a rename, so a crash mid-write leaves the previous store intact instead of a
half-written file that fails to parse forever after; and a corrupt store logs and starts
empty rather than crashing the app on every launch from then on.

This is separate from the rolling 12-turn window in `src/services/conversation.ts`, which
exists so follow-ups like "what about tomorrow?" resolve and is *supposed* to be discarded
when the overlay closes.

## Conversation memory

`src/services/conversation.ts` keeps a rolling window of the last 12 turns in the main
process, so follow-ups resolve against what was already said ("what about tomorrow?", "who is
he?"). History feeds three places: the intent classifier (as context for resolving pronouns),
`chat()` (as full prior turns in `contents`), and `formatResponse()` (as a short summary).
Turns are recorded *after* a response resolves, so the in-flight utterance isn't duplicated.
Closing the overlay clears the history, so each session starts fresh rather than inheriting a
stale topic.

## Ending a conversation by voice

Dismissal phrases are matched locally in the renderer (`src/renderer/src/lib/stop-phrases.ts`)
*before* anything is sent to Gemini, so they close the overlay instantly and are never
mistaken for a question. Matching is exact against a known list rather than substring-based,
so a real question that happens to contain "stop" or "bye" ("what stops a heart attack",
"bye week NFL schedule") still gets answered normally.

## Intent extraction

`classifyIntent()` in `src/services/gemini.ts` is the "rules" that decide what an utterance
means and pull out its parameters. It uses Gemini's **structured output** mode
(`responseSchema` + `responseMimeType: "application/json"`), not just a prompt asking
nicely for JSON — Gemini is constrained at the API level to emit one of the six intents plus
a params object, so there's no free text to regex out and no risk of it wrapping the answer
in markdown or prose. The system prompt above the schema is what tells it, in plain English,
what each intent means and which field to fill in (city / symbol / coin / query / language /
from / to / when / mode / topic).

The router runs at **temperature 0**. At the default it drifted between identical runs —
"how long to Cologne by car" filled in the travel mode on one call and left it blank on the
next — which is unfixable-looking flakiness from the outside. Travel mode additionally has
a plain keyword fallback in `src/services/maps.ts`, since even at temperature 0 the model
fills that field for only about one wording in ten.

## Web search vs. per-topic APIs

Nimbus has a general `search` intent (`src/services/search.ts`) so it isn't limited to
topics someone wired up a dedicated API for. Anything needing live information the model
can't answer from memory routes there; the narrow integrations (weather, stocks, crypto)
stay because they return clean structured data worth rendering as a card.

Why **Tavily** specifically — the free-search landscape as of 2026, all verified rather than
assumed:

| Option | Status |
|---|---|
| **Tavily** | ✅ 1,000 searches/month free, no card. Built for LLM use — returns clean summaries, not raw HTML. |
| Bing Search API | ❌ Retired entirely on Aug 11, 2025. |
| Brave Search API | ❌ Free tier removed Feb 2026. |
| Gemini Google Search grounding | ❌ Paid tier only — verified against this project's own free key: plain calls succeed, grounded calls `429` instantly. |
| DuckDuckGo Instant Answer API | ❌ Key-free but not a real search engine — returns nothing for ordinary queries (tested). |
| Google Custom Search JSON | ⚠️ 100 queries/day free, but needs a separate CSE set up per search scope. |
| SearXNG (self-hosted) | ⚠️ Genuinely free and unlimited, but needs a Docker instance running alongside the app, JSON output is off by default, and single-IP CAPTCHAs degrade results. |
| Crawl4AI | ⚠️ Not a search engine — it's a page *crawler/extractor* (Python). Useful paired with a search API, overkill to bundle in an Electron app. |

Swapping providers means editing one file: `src/services/search.ts`.

### Deep research

A single snippet search answers "what's the capital of Peru" and fails almost everything
else people actually ask. `src/services/research.ts` runs the loop the larger assistants
run:

1. **Plan** — Gemini turns the question into the searches that would answer it. Single-fact
   questions get exactly one query; a comparison or a two-part question gets one per part
   (up to `search.maxQueries`). Pronouns and "latest" are resolved into real names and
   real years first, since a search engine can't resolve either.
2. **Read** — each query runs at Tavily's `advanced` depth with `include_raw_content`, so
   Nimbus gets the extracted page text rather than a 200-character summary. Queries run in
   parallel: a three-part question shouldn't take three times as long.
3. **Merge** — results are **interleaved** across sub-queries, not pooled and ranked
   together. Pooling looks smarter and is worse: ask about two things and the
   better-covered one fills the entire budget, so half the question comes back unanswered.
   Verified — pooling returned eight Deutschlandticket pages and zero about the local RMV
   fare; interleaving put the Darmstadt operator's own page first.
4. **Answer** — the model answers *only* from the pages read, notes when sources disagree,
   and says the sources don't cover it rather than filling the gap from memory. Answers are
   spoken, so it's told to use no citation markers or URLs — the sources appear on the card.

Costs about 2 Tavily credits per sub-query, so a typical question is 2-6 of the 1,000
free monthly credits, and adds roughly 4 seconds over a plain search. Turn it off with
`search.deep: false` (falls back to the one-shot search), or keep the depth and skip the
planning step with `search.plan: false`.

**Why not MCP here?** MCP is for exposing tools to an external agent host (Claude Desktop,
another AI client) or reusing one tool server across several different apps. Nimbus is a
single-purpose app with a fixed, small set of tools and one caller (itself) — wiring up MCP
would mean spawning server subprocesses and translating MCP's tool schema into Gemini's
function-calling format, for no real benefit over calling the REST APIs directly the way
`src/services/*.ts` already does. If you ever want these same integrations reusable from
Claude Desktop or another agent, that's the point where MCP would start paying for itself.

## Toggling integrations

Edit `config.json` — set any of `integrations.weather/stocks/crypto/news/github/transit/maps` to `false`
to disable it (Nimbus will explain it's turned off if you ask anyway), change
`hotkey.accelerator` (Electron [accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator))
if Ctrl+Shift+Space conflicts with something else, or adjust `overlay.autoFadeMs`. Restart
the app to pick up changes.

## Notes

- All data-fetching services live in `src/services/` and run in the **main process** (not
  the renderer), so API keys in `.env` never reach untrusted web content.
- Yahoo Finance's chart endpoint is public but unofficial/undocumented — if it ever breaks
  or gets rate-limited, `src/services/stocks.ts` is the one place to swap in a keyed
  alternative (Finnhub, Alpha Vantage, etc.).
- Mic access is auto-granted (`session.setPermissionRequestHandler` in `src/main/index.ts`)
  rather than prompted, since Nimbus is a single-purpose app you installed yourself.
- Packaging into a distributable `.exe` (via `electron-builder`) is intentionally out of
  scope for this pass — this is local-dev only for now.
