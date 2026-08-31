import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, session, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import dotenv from 'dotenv'
import dns from 'node:dns'
import { createTray } from './tray'
import { crashLogPath, logCrashEvent } from './crash-log'
import {
  createOverlayWindow,
  showOverlay,
  hideOverlay,
  presentOverlay,
  moveOverlay,
  snapOverlay,
  setOverlaySqueeze,
  getOverlayLayout
} from './window'
import { startReminderScheduler, stopReminderScheduler } from './reminder-scheduler'
import { startWatchScheduler, stopWatchScheduler } from './watch-scheduler'
import { applyStoredSecrets, secretStatuses, setSecret } from './secrets'
import { aiChoiceLockedByEnv, applyAiChoice, getAiChoice, setAiChoice } from './ai-choice'
import { listModels } from '../services/providers'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { enableSystemAudioCapture } from './system-audio'
import { handleUtterance } from '../services'
import { resetConversation, recordTurn } from '../services/conversation'
import { askAboutScreen } from '../services/vision'
import { looksLikePaperwork, readDocument } from '../services/paperwork'
import { captureDisplayImage, encodeCapture, type ScreenCapture } from './screen'
import { pickRegion, type RegionChoice } from './region-picker'
import { captureSelection, pasteIntoWindow, replyInWindow, type CapturedSelection } from './selection'
import { runTextAction } from '../services/text-actions'
import type { TextActionKind, OverlaySqueeze } from '../shared/types'
import { transcribeAudio } from '../services/whisper'
import { endVadSession, resetVadSession, vadProbabilities, warmVad } from '../services/vad'
import {
  clearHeld,
  considerInterruption,
  missedInterruptions,
  mute,
  type Interruption
} from '../services/interruptions'
import { refreshPlace } from '../services/region'
import { stopSpeechHost } from './speech-host'
import { subtitleFor, type Subtitle } from '../services/subtitles'
import { targetLanguage } from '../services/translate'
import { heardWakeWord, wakeWordEnabled } from '../services/wake-word'
import { localSttInstalled } from '../services/local-stt'
import { readQuotas } from '../services/quota'
import { getStockQuote } from '../services/stocks'
import { pricedWatchlist } from '../services/watchlist'
import { cancelReminderById } from '../services/reminders'
import { cancelStandingItem, standingItems } from '../services/standing'
import { downloadLocalModel, downloadOnnxModel, localModelStatus } from './model-download'
import type { LocalModelKind, LocalModelStatus } from '../shared/types'
import {
  exportMeeting,
  summarizeMeeting,
  transcribePiece,
  type ExportFormat
} from '../services/meeting'
import type { MeetingLine, MeetingSummary } from '../shared/types'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { synthesizeSpeech } from '../services/tts'
import { withDeadline } from '../services/http'
import { onLocalModelLoad } from '../services/local-llm'
import { activeProvider } from '../services/llm'
import { IPC } from '../shared/ipc-channels'
import type {
  AiChoice,
  AiProvider,
  NimbusConfig,
  NimbusResponse,
  ProviderModel,
  QuotaLine,
  StandingItem,
  StockCardData,
  StockRange,
  SecretName,
  SecretStatus,
  SynthesizedSpeech
} from '../shared/types'
import config from '../../config.json'
import { mapTilesFor } from '../services/maps'

/**
 * Resolve names over IPv4 unless there is no IPv4 to be had.
 *
 * This machine has six network interfaces whose IPv6 DNS servers are
 * `fec0:0:0:ffff::1`-`::3` — the obsolete site-local placeholders Windows
 * falls back to when nothing real is configured. Nothing answers there, so
 * every name lookup that asks for an AAAA record waits for those servers to
 * time out. Measured back to back in one process on a cold cache:
 *
 *     dns.lookup(host)              8441ms
 *     dns.lookup(host, family: 4)     30ms
 *
 * undici calls `lookup` with no family at all, so every request paid the 8
 * second penalty and then failed the 10 second connect timeout as a bare
 * "fetch failed". It looked like specific APIs were down, and it looked
 * intermittent, because once a name is in the OS cache the next lookup is
 * instant — until the cache expires and it all comes back.
 *
 * Ordering the results (`ipv4first`) does not help: getaddrinfo still *asks*
 * for AAAA. The query itself has to be avoided.
 *
 * Falls back to an unrestricted lookup when there is no A record, so a
 * genuinely IPv6-only host still resolves. The cost of that fallback is paid
 * only by hosts that have no IPv4 at all.
 */
const systemLookup = dns.lookup
type LookupArgs = Parameters<typeof dns.lookup>
function ipv4FirstLookup(hostname: string, options: unknown, callback: unknown): void {
  const done = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void
  const given = typeof options === 'function' ? undefined : options
  const opts =
    typeof given === 'number' ? { family: given } : ({ ...((given as object) ?? {}) } as { family?: number })

  // An explicit family is the caller's business; leave it alone.
  if (opts.family) {
    ;(systemLookup as (...a: unknown[]) => void)(hostname, opts, done)
    return
  }

  ;(systemLookup as (...a: unknown[]) => void)(
    hostname,
    { ...opts, family: 4 },
    (error: unknown, ...rest: unknown[]) => {
      if (!error) return done(error, ...rest)
      // No IPv4 for this name — ask again without the restriction.
      ;(systemLookup as (...a: unknown[]) => void)(hostname, given ?? {}, done)
    }
  )
}
;(dns as { lookup: unknown }).lookup = ipv4FirstLookup as unknown as (...a: LookupArgs) => void

/**
 * A rejected promise must not take the whole app down.
 *
 * Node terminates the process on an unhandled rejection, and this app makes a
 * lot of network calls from the main process - reminders, watchers and the
 * schedulers all run unattended. One unreachable host at the wrong moment was
 * enough to close the overlay and everything behind it with no explanation.
 * Logged loudly rather than swallowed silently: these still point at bugs.
 */
process.on('unhandledRejection', (reason) => {
  logCrashEvent(`unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`)
})
process.on('uncaughtException', (error) => {
  logCrashEvent(`uncaught exception: ${error instanceof Error ? error.stack : error}`)
})


/**
 * Environment, from the working directory *and* from the user's own data
 * folder.
 *
 * dotenv reads the current working directory, which under `yarn dev` is the
 * project — so every key in .env is present. For an installed build the
 * working directory is wherever the shortcut happened to point, so none of
 * them were, and the app quietly degraded: without GROQ_API_KEY speech
 * recognition fell back to loading Whisper on-device, which is why the
 * packaged app felt slow when dev did not. It looked like the network was
 * slow. It was the app doing far more work.
 *
 * .env is deliberately not shipped inside the installer — that would put live
 * API keys in a file handed to other people. Reading one from userData keeps
 * the keys on the machine they belong to.
 *
 * Order matters: dotenv never overwrites a variable that is already set, so
 * the working directory wins where it has one, and this fills in the rest.
 */
dotenv.config()
dotenv.config({ path: join(app.getPath('userData'), '.env') })

// Chromium blocks audio.play() without a user gesture by default. Nimbus's
// "gesture" is a global OS-level hotkey, which never reaches the renderer
// as a real DOM event, so without this the Edge TTS audio element's play()
// call was silently rejecting and falling back to the robotic native voice
// every single time — must be set before app is ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Chromium's own background pings (component updater, Safe Browsing, etc.)
// have nothing to do with anything Nimbus does, but they still fire on
// startup and log an ERROR on networks where TLS inspection mangles the
// handshake to Google's endpoints. Silenced rather than left to alarm anyone
// reading the console.
app.commandLine.appendSwitch('disable-background-networking')

// Time given to the compositor to actually repaint after hiding the overlay,
// before a screenshot is taken. Without it the overlay is still on screen in
// the captured frame even though the window reports itself hidden.
const OVERLAY_HIDE_REPAINT_MS = 180
// Upper bound on a whole turn, covering intent routing plus whatever service
// it calls. Generous enough for a slow search, short enough that a stuck
// dependency surfaces as an error rather than a spinner that never ends.
const TURN_DEADLINE_MS = 25000

/** How often to re-ask where the machine is. Laptops move; buildings don't. */
const PLACE_REFRESH_MS = 15 * 60 * 1000

let overlayWindow: BrowserWindow | null = null
// Held only between the capture hotkey and the question that follows it, then
// cleared — the screenshot is never retained beyond the turn that uses it.
let pendingCapture: ScreenCapture | null = null
// Text grabbed from another app, plus the window to paste a result back into.
let pendingSelection: CapturedSelection | null = null

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.TRANSCRIPT, async (event, utterance: string): Promise<NimbusResponse> => {
    // Forward tokens as the model produces them, so the overlay can show the
    // answer building up instead of sitting on "Thinking…" until it's done.
    const stream = (chunk: string): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.SPEECH_CHUNK, chunk)
    }

    // A screenshot is waiting: this question is about the screen, so answer
    // from the image instead of routing through the normal intent pipeline.
    if (pendingCapture) {
      const capture = pendingCapture
      pendingCapture = null

      // A letter or form gets the structured reading rather than prose: what
      // it wants, by when, how much. Same explicit capture, different answer.
      if (looksLikePaperwork(utterance)) {
        try {
          const data = await withDeadline(
            readDocument(utterance, capture),
            TURN_DEADLINE_MS,
            'Reading the document'
          )
          const spoken = [
            data.summary,
            data.actionRequired && `You need to: ${data.actionRequired}.`,
            data.deadlineLabel && `Deadline: ${data.deadlineLabel}.`
          ]
            .filter(Boolean)
            .join(' ')
          recordTurn('user', utterance)
          recordTurn('model', spoken)
          return {
            speech: spoken,
            card: { type: 'paperwork', data: { ...data, thumbnail: capture.thumbnail } }
          }
        } catch (err) {
          console.error('[paperwork] falling back to a plain reading:', err)
          // Structured extraction failed — a prose answer is still useful, so
          // fall through rather than losing the capture entirely.
        }
      }

      try {
        const speech = await withDeadline(
          askAboutScreen(utterance, capture, stream),
          TURN_DEADLINE_MS,
          'Reading the screen'
        )
        recordTurn('user', utterance)
        recordTurn('model', speech)
        return { speech, card: { type: 'screen', data: { thumbnail: capture.thumbnail } } }
      } catch (err) {
        return {
          speech: err instanceof Error ? err.message : "I couldn't read that screenshot.",
          card: { type: 'text' }
        }
      }
    }

    const setSearching = (active: boolean): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.SEARCH_STATUS, active)
    }

    // Backstop: no matter what a service does, this handler always settles.
    // An un-timed-out fetch once left the overlay on "Thinking…" indefinitely
    // with no error to show, which is worse than simply failing.
    const response = await withDeadline(
      handleUtterance(utterance, stream, setSearching),
      TURN_DEADLINE_MS,
      'That',
      // On the on-device model a slow turn is usually the weights still being
      // read, and telling someone to check their wifi over that sends them
      // looking in entirely the wrong place.
      activeProvider() === 'local' ? 'Try again in a moment.' : undefined
    ).catch((err: unknown) => ({
      speech: err instanceof Error ? err.message : 'Something went wrong.',
      card: { type: 'text' } as const
    }))

    // Opened only when the user asked for YouTube. It used to open on every
    // music result, so "play some lofi" could throw a browser window over
    // whatever was on screen — and it did that most often when the radio
    // lookup had quietly failed, which is exactly when the user had least
    // reason to expect it. The card is a play button; that is enough.
    if (response.card.type === 'music' && response.card.data.autoOpen) {
      void shell.openExternal(response.card.data.url)
    }

    return response
  })

  ipcMain.on(IPC.HIDE, () => {
    if (overlayWindow) hideOverlay(overlayWindow)
  })

  ipcMain.on(IPC.RESET_CONVERSATION, () => {
    resetConversation()
    // Closing the overlay drops anything captured but never acted on, so a
    // later turn can't be answered against stale context.
    pendingCapture = null
    pendingSelection = null
  })

  ipcMain.on(IPC.COPY_TEXT, (_event, text: string) => {
    // Electron's clipboard rather than navigator.clipboard: the overlay is a
    // transparent, often-unfocused window, where the web API is unreliable.
    clipboard.writeText(text)
  })

  ipcMain.on(IPC.MOVE_OVERLAY, (_event, dx: number, dy: number) => {
    if (!overlayWindow) return
    // Moved from the renderer rather than by -webkit-app-region, which never
    // fires on this window: it is transparent and click-through, and
    // setIgnoreMouseEvents makes it invisible to input at the OS level, so
    // Chromium's own drag region is never reached.
    moveOverlay(overlayWindow, dx, dy)
  })

  ipcMain.on(IPC.SNAP_OVERLAY, () => {
    if (overlayWindow) snapOverlay(overlayWindow)
  })

  ipcMain.on(IPC.SET_OVERLAY_SQUEEZE, (_event, squeeze: OverlaySqueeze) => {
    if (overlayWindow) setOverlaySqueeze(overlayWindow, squeeze)
  })

  ipcMain.handle(IPC.GET_OVERLAY_LAYOUT, () => getOverlayLayout())

  ipcMain.on(IPC.SET_MOUSE_IGNORE, (_event, ignore: boolean) => {
    // forward:true keeps mousemove flowing to the renderer while ignoring, so
    // it can still tell when the pointer arrives over the card.
    overlayWindow?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  ipcMain.on(IPC.OPEN_EXTERNAL, (_event, url: string) => {
    // Only ever hand http(s) to the OS. Card URLs come from third-party API
    // responses, and blindly opening arbitrary schemes (file:, etc.) would
    // let a hostile result trigger something local.
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        console.warn(`[nimbus] refused to open non-http URL: ${parsed.protocol}`)
        return
      }
      void shell.openExternal(parsed.toString())
    } catch {
      console.warn('[nimbus] refused to open malformed URL')
    }
  })

  ipcMain.handle(IPC.GET_CONFIG, (): NimbusConfig => config)

  ipcMain.handle(IPC.GET_SECRETS, (): SecretStatus[] => secretStatuses())

  ipcMain.handle(
    IPC.SET_SECRET,
    (_event, name: SecretName, value: string): { ok: boolean; error?: string } =>
      setSecret(name, value)
  )

  ipcMain.handle(IPC.LIST_MODELS, async (_event, provider: AiProvider): Promise<ProviderModel[]> => {
    return listModels(provider)
  })

  ipcMain.handle(IPC.GET_AI_CHOICE, (): AiChoice & { lockedByEnv: boolean } => ({
    ...getAiChoice(),
    lockedByEnv: aiChoiceLockedByEnv()
  }))

  ipcMain.handle(IPC.SET_AI_CHOICE, (_event, choice: AiChoice): void => setAiChoice(choice))

  ipcMain.handle(
    IPC.RUN_TEXT_ACTION,
    async (
      event,
      kind: TextActionKind,
      customInstruction?: string
    ): Promise<{ result: string; canReplace: boolean }> => {
      if (!pendingSelection) throw new Error('There is no selected text to work on.')
      const result = await runTextAction(kind, pendingSelection.text, customInstruction, (chunk) => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.SPEECH_CHUNK, chunk)
      })
      // The result becomes the working text, so a follow-up ("now make it
      // shorter") builds on it instead of starting from the original again.
      pendingSelection = { ...pendingSelection, text: result }
      return { result, canReplace: pendingSelection.windowHandle !== '0' }
    }
  )

  ipcMain.handle(IPC.REPLY_IN_APP, async (_event, text: string): Promise<boolean> => {
    if (!pendingSelection) throw new Error('There is no conversation to reply to.')
    const { windowHandle } = pendingSelection
    // Hide first so focus can return to the chat app before the paste.
    if (overlayWindow) hideOverlay(overlayWindow)
    const pasted = await replyInWindow(windowHandle, text)
    pendingSelection = null

    // Some composers - Instagram's among them - only accept a paste when the
    // caret is already in them, and no keystroke from outside can put it
    // there. Rather than fail silently, say where the draft went: it is on the
    // clipboard either way, so the user is always one Ctrl+V from done.
    if (!pasted && Notification.isSupported()) {
      new Notification({
        title: 'Nimbus — reply copied',
        body: 'Click the message box and press Ctrl+V to paste your draft.'
      }).show()
    }
    return pasted
  })

  ipcMain.handle(IPC.REPLACE_SELECTION, async (_event, text: string): Promise<void> => {
    if (!pendingSelection) throw new Error('There is no selection to replace.')
    const { windowHandle } = pendingSelection
    // Hide first so focus can return to the source app before the paste.
    if (overlayWindow) hideOverlay(overlayWindow)
    await pasteIntoWindow(windowHandle, text)
    pendingSelection = null
  })

  ipcMain.handle(
    IPC.TRANSCRIBE_AUDIO,
    async (_event, pcm: ArrayBuffer): Promise<string> => {
      // Already 16kHz mono float samples — the renderer decoded them, because
      // only Chromium has the WebM/Opus codec.
      //
      // Told which language to expect rather than left to guess: an utterance
      // is a couple of seconds, which is too little for reliable detection,
      // and the language the user thinks in is the one they ask questions in.
      return transcribeAudio(new Float32Array(pcm), { language: targetLanguage() })
    }
  )

  ipcMain.handle(
    IPC.MAP_TILES,
    (_event, zoom: number, wanted: Array<{ col: number; row: number }>) =>
      mapTilesFor(zoom, wanted)
  )

  ipcMain.handle(IPC.GET_MISSED, (): Interruption[] => missedInterruptions())
  ipcMain.handle(IPC.CLEAR_MISSED, (): void => clearHeld())
  ipcMain.handle(IPC.MUTE_SOURCE, (_event, source: string): void => mute(source))

  ipcMain.handle(
    IPC.VAD_FRAMES,
    async (_event, id: string, pcm: ArrayBuffer): Promise<number[]> =>
      vadProbabilities(id, new Float32Array(pcm))
  )

  ipcMain.on(IPC.VAD_SESSION, (_event, id: string, active: boolean) => {
    if (active) resetVadSession(id)
    else endVadSession(id)
  })

  ipcMain.handle(
    IPC.GET_QUOTE,
    (_event, symbol: string, range: StockRange): Promise<StockCardData> =>
      getStockQuote(symbol, range)
  )

  ipcMain.handle(IPC.GET_WATCHLIST, (): Promise<StockCardData[]> => pricedWatchlist())

  ipcMain.handle(IPC.GET_STANDING, (): StandingItem[] => standingItems())

  ipcMain.handle(
    IPC.CANCEL_STANDING,
    (_event, kind: StandingItem['kind'], id: string): boolean => cancelStandingItem(kind, id)
  )

  ipcMain.handle(IPC.CANCEL_REMINDER, (_event, id: string): boolean => cancelReminderById(id))

  ipcMain.handle(IPC.GET_QUOTAS, (): Promise<QuotaLine[]> => readQuotas())

  ipcMain.handle(IPC.WAKE_WORD_READY, async (): Promise<boolean> => {
    // Both halves are required: the user's opt-in, and the on-device
    // recogniser. Without local weights this would ship a room's conversation
    // to a cloud API, which is not a trade the setting was offering.
    return wakeWordEnabled() && (await localSttInstalled())
  })

  ipcMain.handle(IPC.WAKE_HEARD, async (_event, pcm: ArrayBuffer): Promise<boolean> => {
    try {
      const heard = await heardWakeWord(new Float32Array(pcm))
      // Opened here rather than in the renderer so that saying the name lands
      // in exactly the same place as pressing the hotkey — showOverlay is what
      // starts a listening turn.
      if (heard && overlayWindow) showOverlay(overlayWindow)
      return heard
    } catch (error) {
      // A failure here must stay quiet — this runs continuously, and an error
      // dialog per burst would be unusable.
      console.warn('[wake-word] burst failed:', error)
      return false
    }
  })

  ipcMain.handle(
    IPC.LOCAL_MODEL_STATUS,
    (_event, kind: LocalModelKind = 'llm'): Promise<LocalModelStatus> => localModelStatus(kind)
  )

  ipcMain.handle(
    IPC.DOWNLOAD_LOCAL_MODEL,
    async (event, kind: LocalModelKind = 'llm'): Promise<{ ok: boolean; error?: string }> => {
      try {
        const fetchModel =
          kind === 'llm'
            ? downloadLocalModel
            : (report: Parameters<typeof downloadLocalModel>[0]) => downloadOnnxModel(kind, report)
        await fetchModel((progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC.LOCAL_MODEL_PROGRESS, progress)
          }
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Download failed.' }
      }
    }
  )

  ipcMain.handle(
    IPC.SUBTITLE_FOR,
    async (
      _event,
      pcm: ArrayBuffer,
      offsetMs: number,
      previous: string,
      sourceHint: string
    ): Promise<Subtitle | null> => {
      // A failed piece must not stop the stream: subtitles arrive every few
      // seconds, and one dropped line is far better than the mode dying
      // because a single upload timed out.
      try {
        return await subtitleFor({
          pcm: new Float32Array(pcm),
          offsetMs,
          previous,
          sourceHint
        })
      } catch (error) {
        console.warn('[subtitles] piece failed:', error)
        return null
      }
    }
  )

  ipcMain.handle(
    IPC.MEETING_PIECE,
    async (
      _event,
      pcm: ArrayBuffer,
      previous: string,
      language: string
    ): Promise<string | null> => {
      // As with subtitles, one failed piece must not end the recording —
      // losing a sentence of a meeting is recoverable, losing the meeting is
      // not.
      try {
        return await transcribePiece(new Float32Array(pcm), previous, language)
      } catch (error) {
        console.warn('[meeting] piece failed:', error)
        return null
      }
    }
  )

  ipcMain.handle(
    IPC.SAVE_MEETING,
    async (
      _event,
      lines: MeetingLine[],
      startedAt: number,
      format: ExportFormat,
      summary: MeetingSummary | null
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const when = new Date(startedAt)
      const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`

      let built: ReturnType<typeof exportMeeting>
      try {
        // Built before the dialog opens, so a format that can't be produced
        // says why instead of asking where to put a file it can't write.
        built = exportMeeting(format, lines, startedAt, summary)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Could not build it.' }
      }

      const result = await dialog.showSaveDialog({
        title: format === 'transcript' ? 'Save meeting transcript' : 'Save meeting summary',
        defaultPath: join(app.getPath('documents'), `meeting-${stamp}.${built.extension}`),
        filters: [{ name: built.filterName, extensions: [built.extension] }]
      })
      if (result.canceled || !result.filePath) return { ok: false }

      try {
        await writeFile(result.filePath, built.data)
        return { ok: true, path: result.filePath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not write the file.'
        return { ok: false, error: message }
      }
    }
  )

  ipcMain.handle(
    IPC.SUMMARIZE_MEETING,
    async (_event, lines: MeetingLine[], startedAt: number): Promise<MeetingSummary> =>
      summarizeMeeting(lines, startedAt)
  )

  ipcMain.handle(IPC.SYNTHESIZE_SPEECH, async (_event, text: string): Promise<SynthesizedSpeech> => {
    const { audio, mimeType } = await synthesizeSpeech(text)
    // Copy into a fresh, exactly-sized ArrayBuffer — Buffer.buffer can be a
    // larger pooled (and Shared-typed) ArrayBuffer that isn't safe to send
    // as-is across the context bridge.
    const arrayBuffer = new ArrayBuffer(audio.byteLength)
    new Uint8Array(arrayBuffer).set(audio)
    return { audio: arrayBuffer, mimeType }
  })
}

/**
 * One Nimbus at a time.
 *
 * Without this a second launch runs alongside the first, and the two fight
 * over everything that is single by nature: the global hotkey, the microphone,
 * and every file in userData — including the scripts the speech and GPU
 * processes are written to and then executed. One instance rewriting a script
 * while the other is running it is a crash with no sensible explanation.
 *
 * The second copy hands its turn to the first and exits, which is also what
 * someone double-clicking the icon actually wants.
 */
if (!app.requestSingleInstanceLock()) {
  console.log('[main] another Nimbus is already running; handing over to it')
  app.quit()
}

app.on('second-instance', () => {
  if (overlayWindow) showOverlay(overlayWindow)
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nimbus.assistant')

  // Electron denies media (mic) permission requests by default; Nimbus is a
  // single-purpose app the user installed themselves, so auto-grant it
  // rather than showing a permission prompt.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  // Meeting capture and live subtitles both need to hear what the machine is
  // playing, not just the microphone.
  enableSystemAudioCapture()

  // Before anything can read a key: .env first, then whatever settings hold.
  applyStoredSecrets()
  applyAiChoice()

  overlayWindow = createOverlayWindow()
  registerIpcHandlers()

  // The on-device model takes seconds to read into memory. Telling the overlay
  // while it happens is the difference between a visible "loading" bar and a
  // window that appears to have hung.
  onLocalModelLoad((state) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(IPC.LOCAL_MODEL_LOADING, state)
    }
  })

  // Fetched and loaded in the background so the first thing said isn't the
  // request that waits for it. 2.2MB, and it is deliberately not awaited —
  // voice input falls back to the energy heuristic until it is ready.
  void warmVad()

  // Where this machine is, asked once at startup and kept fresh. Everything
  // that says "from here" - trains, directions, weather, the router's place
  // correction - reads the answer, so it must not wait for it.
  void refreshPlace()
  setInterval(() => void refreshPlace(), PLACE_REFRESH_MS)

  startReminderScheduler({
    onDue: (reminder) => {
      if (!overlayWindow) return
      // Every unprompted interruption goes through here: muted subjects are
      // dropped, quiet hours hold it for later, and either way it is recorded
      // so "what did you tell me while I was out" has an answer.
      const { deliver } = considerInterruption(`reminder:${reminder.id}`, 'reminder', reminder.text)
      if (deliver) presentOverlay(overlayWindow, IPC.REMINDER_DUE, reminder)
    }
  })

  startWatchScheduler({
    onUpdate: (update) => {
      if (!overlayWindow) return
      // Delivered down the reminder channel deliberately: a delay is the same
      // kind of event — Nimbus interrupting with something time-critical the
      // user asked to be told — and it already presents and speaks correctly.
      // The three kinds of watch carry different payloads, and none of their
      // ids matter here — only the sentence does.
      presentOverlay(overlayWindow, IPC.REMINDER_DUE, {
        id: `watch-${Date.now()}`,
        at: new Date().toISOString(),
        text: update.speech,
        fired: true
      })
    }
  })

  createTray({
    onShow: () => {
      if (overlayWindow) showOverlay(overlayWindow)
    },
    onStanding: () => {
      // presentOverlay, not showOverlay: opening a list to read should not
      // also open a hot microphone.
      if (overlayWindow) presentOverlay(overlayWindow, IPC.SHOW_STANDING)
    },
    onSettings: () => {
      if (overlayWindow) showOverlay(overlayWindow, IPC.SHOW_SETTINGS)
    },
    onQuit: () => app.quit()
  })

  registerHotkey(
    () => {
      // Plain hotkey starts a normal turn, so drop any captured screenshot or
      // selection — otherwise the next question is answered against them.
      pendingCapture = null
      pendingSelection = null
      if (overlayWindow) showOverlay(overlayWindow)
    },
    async () => {
      if (!overlayWindow) return
      // Hidden, not closed: an already-open overlay would otherwise appear in
      // its own screenshot. Conversation, pending selection and everything
      // else in the renderer survive, since the window is only hidden.
      const wasVisible = overlayWindow.isVisible()

      try {
        if (wasVisible) {
          overlayWindow.hide()
          // Hiding is not instant on screen — without a beat for the
          // compositor to repaint, the capture still contains the overlay.
          await new Promise((resolve) => setTimeout(resolve, OVERLAY_HIDE_REPAINT_MS))
        }

        const { image, bounds } = await captureDisplayImage()

        let choice: RegionChoice = 'full'
        if (config.screenshot.selectRegion) {
          // Picker draws over the frozen capture, so the selection maps
          // exactly onto what gets cropped.
          const preview = `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`
          choice = await pickRegion(preview, bounds)
        }

        if (choice === null) {
          // Cancelled — put the overlay back exactly as it was.
          if (wasVisible) showOverlay(overlayWindow)
          return
        }

        pendingCapture = encodeCapture(image, choice === 'full' ? undefined : choice)
        pendingSelection = null
        showOverlay(overlayWindow)
        overlayWindow.webContents.send(IPC.SCREEN_CAPTURED, pendingCapture.thumbnail)
      } catch (err) {
        console.error('[screen] capture failed:', err instanceof Error ? err.message : err)
        pendingCapture = null
        if (wasVisible) showOverlay(overlayWindow)
      }
    },
    async () => {
      if (!overlayWindow) return
      const wasVisible = overlayWindow.isVisible()
      try {
        // The squeezed overlay can still be the foreground window. Ctrl+C
        // would then copy from Nimbus instead of the highlighted text.
        // Only hide when we actually have focus — otherwise the orb would
        // blink out while the other app already owns the selection.
        if (wasVisible && overlayWindow.isFocused()) {
          overlayWindow.hide()
          await new Promise((resolve) => setTimeout(resolve, OVERLAY_HIDE_REPAINT_MS))
        }
        pendingSelection = await captureSelection()
        pendingCapture = null
        // presentOverlay, not showOverlay: WAKE would treat this as a fresh
        // question and drop the selection. Compact dock is opened when parked
        // in a corner, so Ctrl+Shift+A still works while squeezed.
        presentOverlay(overlayWindow, IPC.SELECTION_CAPTURED, pendingSelection.text)
      } catch (err) {
        pendingSelection = null
        const message = err instanceof Error ? err.message : 'Selection capture failed.'
        console.warn('[selection]', message)
        presentOverlay(overlayWindow, IPC.SELECTION_CAPTURED, '')
      }
    }
  )

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

})

// Nimbus is tray-only: closing the overlay must never quit the app.
app.on('window-all-closed', () => {
  /* intentionally empty */
})

/**
 * A dead renderer looks exactly like the app closing, so rebuild it.
 *
 * The window is the only thing the user can see. If its process is killed —
 * out of memory, a GPU reset, a driver fault — the tray icon stays but the
 * overlay never appears again, which reads as "it closed for no reason".
 * Logged with the actual reason, because until now there was nothing to go on.
 */
app.on('render-process-gone', (_event, _contents, details) => {
  logCrashEvent(`renderer gone: ${details.reason} (exitCode ${details.exitCode})`)
  if (details.reason === 'clean-exit') return
  try {
    // ipcMain handlers are process-wide and already registered, so only the
    // window itself needs rebuilding.
    overlayWindow = createOverlayWindow()
    console.log('[main] overlay rebuilt after renderer crash')
  } catch (error) {
    logCrashEvent(`could not rebuild the overlay: ${error instanceof Error ? error.stack : error}`)
  }
})

// The GPU and utility processes recover on their own; this is only so there is
// a record when one of them goes, since that often precedes the renderer going.
app.on('child-process-gone', (_event, details) => {
  logCrashEvent(`${details.type} process gone: ${details.reason}`)
})

// So the crash log's own location is on record somewhere findable — printed
// once at startup rather than only mattering after something has already
// gone wrong, which is the moment nobody remembers where to look.
console.log(`[main] crash log: ${crashLogPath()}`)

app.on('will-quit', () => {
  stopReminderScheduler()
  stopWatchScheduler()
  unregisterHotkey()
  // Ends the voice process cleanly. Without this it is killed with the GPU
  // device still live, which is the fault this whole arrangement avoids.
  stopSpeechHost()
})
