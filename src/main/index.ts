import { app, BrowserWindow, clipboard, ipcMain, session, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import dotenv from 'dotenv'
import { createTray } from './tray'
import { createOverlayWindow, showOverlay, hideOverlay, presentOverlay } from './window'
import { startReminderScheduler, stopReminderScheduler } from './reminder-scheduler'
import { applyStoredSecrets, secretStatuses, setSecret } from './secrets'
import { aiChoiceLockedByEnv, applyAiChoice, getAiChoice, setAiChoice } from './ai-choice'
import { listModels } from '../services/providers'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { handleUtterance } from '../services'
import { resetConversation, recordTurn } from '../services/conversation'
import { askAboutScreen } from '../services/vision'
import { captureDisplayImage, encodeCapture, type ScreenCapture } from './screen'
import { pickRegion, type RegionChoice } from './region-picker'
import { captureSelection, pasteIntoWindow, type CapturedSelection } from './selection'
import { runTextAction } from '../services/text-actions'
import type { TextActionKind } from '../shared/types'
import { transcribeAudio } from '../services/whisper'
import { synthesizeSpeech } from '../services/tts'
import { withDeadline } from '../services/http'
import { IPC } from '../shared/ipc-channels'
import type {
  AiChoice,
  AiProvider,
  NimbusConfig,
  NimbusResponse,
  ProviderModel,
  SecretName,
  SecretStatus,
  SynthesizedSpeech
} from '../shared/types'
import config from '../../config.json'

dotenv.config()

// Chromium blocks audio.play() without a user gesture by default. Nimbus's
// "gesture" is a global OS-level hotkey, which never reaches the renderer
// as a real DOM event, so without this the Edge TTS audio element's play()
// call was silently rejecting and falling back to the robotic native voice
// every single time — must be set before app is ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Time given to the compositor to actually repaint after hiding the overlay,
// before a screenshot is taken. Without it the overlay is still on screen in
// the captured frame even though the window reports itself hidden.
const OVERLAY_HIDE_REPAINT_MS = 180
// Upper bound on a whole turn, covering intent routing plus whatever service
// it calls. Generous enough for a slow search, short enough that a stuck
// dependency surfaces as an error rather than a spinner that never ends.
const TURN_DEADLINE_MS = 25000

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

    // Backstop: no matter what a service does, this handler always settles.
    // An un-timed-out fetch once left the overlay on "Thinking…" indefinitely
    // with no error to show, which is worse than simply failing.
    const response = await withDeadline(
      handleUtterance(utterance, stream),
      TURN_DEADLINE_MS,
      'That'
    ).catch((err: unknown) => ({
      speech: err instanceof Error ? err.message : 'Something went wrong.',
      card: { type: 'text' } as const
    }))

    // "Play X" means play it — open the video straight away in the default
    // browser, which uses YouTube's own player and the user's own session.
    if (response.card.type === 'music') {
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
    async (_event, audio: ArrayBuffer, mimeType: string): Promise<string> => {
      return transcribeAudio(Buffer.from(audio), mimeType)
    }
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nimbus.assistant')

  // Electron denies media (mic) permission requests by default; Nimbus is a
  // single-purpose app the user installed themselves, so auto-grant it
  // rather than showing a permission prompt.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  // Before anything can read a key: .env first, then whatever settings hold.
  applyStoredSecrets()
  applyAiChoice()

  overlayWindow = createOverlayWindow()
  registerIpcHandlers()

  startReminderScheduler({
    onDue: (reminder) => {
      if (overlayWindow) presentOverlay(overlayWindow, IPC.REMINDER_DUE, reminder)
    }
  })

  createTray({
    onShow: () => {
      if (overlayWindow) showOverlay(overlayWindow)
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
      try {
        // Read the selection while the other app still has focus — showing
        // the overlay first would make Nimbus the foreground window and the
        // Ctrl+C would go to the wrong place.
        pendingSelection = await captureSelection()
        pendingCapture = null
        showOverlay(overlayWindow)
        overlayWindow.webContents.send(IPC.SELECTION_CAPTURED, pendingSelection.text)
      } catch (err) {
        pendingSelection = null
        const message = err instanceof Error ? err.message : 'Selection capture failed.'
        console.warn('[selection]', message)
        showOverlay(overlayWindow)
        overlayWindow.webContents.send(IPC.SELECTION_CAPTURED, '')
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

app.on('will-quit', () => {
  stopReminderScheduler()
  unregisterHotkey()
})
