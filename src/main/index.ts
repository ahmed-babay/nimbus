import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import dotenv from 'dotenv'
import { createTray } from './tray'
import { createOverlayWindow, showOverlay, hideOverlay } from './window'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { handleUtterance } from '../services'
import { resetConversation } from '../services/conversation'
import { transcribeAudio } from '../services/whisper'
import { synthesizeSpeech } from '../services/tts'
import { IPC } from '../shared/ipc-channels'
import type { NimbusConfig, NimbusResponse, SynthesizedSpeech } from '../shared/types'
import config from '../../config.json'

dotenv.config()

// Chromium blocks audio.play() without a user gesture by default. Nimbus's
// "gesture" is a global OS-level hotkey, which never reaches the renderer
// as a real DOM event, so without this the Edge TTS audio element's play()
// call was silently rejecting and falling back to the robotic native voice
// every single time — must be set before app is ready.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let overlayWindow: BrowserWindow | null = null

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.TRANSCRIPT, async (event, utterance: string): Promise<NimbusResponse> => {
    // Forward tokens as the model produces them, so the overlay can show the
    // answer building up instead of sitting on "Thinking…" until it's done.
    const response = await handleUtterance(utterance, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.SPEECH_CHUNK, chunk)
    })

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

  overlayWindow = createOverlayWindow()
  registerIpcHandlers()

  createTray({
    onShow: () => {
      if (overlayWindow) showOverlay(overlayWindow)
    },
    onSettings: () => {
      if (overlayWindow) showOverlay(overlayWindow, IPC.SHOW_SETTINGS)
    },
    onQuit: () => app.quit()
  })

  registerHotkey(() => {
    if (overlayWindow) showOverlay(overlayWindow)
  })

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })
})

// Nimbus is tray-only: closing the overlay must never quit the app.
app.on('window-all-closed', () => {
  /* intentionally empty */
})

app.on('will-quit', () => {
  unregisterHotkey()
})
