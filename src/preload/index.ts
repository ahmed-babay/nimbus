import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  NimbusConfig,
  NimbusResponse,
  Reminder,
  SynthesizedSpeech,
  TextActionKind
} from '../shared/types'

const api = {
  getConfig: (): Promise<NimbusConfig> => ipcRenderer.invoke(IPC.GET_CONFIG),
  onWake: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.WAKE, listener)
    return () => ipcRenderer.removeListener(IPC.WAKE, listener)
  },
  onSpeechChunk: (callback: (chunk: string) => void): (() => void) => {
    const listener = (_event: unknown, chunk: string): void => callback(chunk)
    ipcRenderer.on(IPC.SPEECH_CHUNK, listener)
    return () => ipcRenderer.removeListener(IPC.SPEECH_CHUNK, listener)
  },
  onScreenCaptured: (callback: (thumbnail: string) => void): (() => void) => {
    const listener = (_event: unknown, thumbnail: string): void => callback(thumbnail)
    ipcRenderer.on(IPC.SCREEN_CAPTURED, listener)
    return () => ipcRenderer.removeListener(IPC.SCREEN_CAPTURED, listener)
  },
  onSelectionCaptured: (callback: (text: string) => void): (() => void) => {
    const listener = (_event: unknown, text: string): void => callback(text)
    ipcRenderer.on(IPC.SELECTION_CAPTURED, listener)
    return () => ipcRenderer.removeListener(IPC.SELECTION_CAPTURED, listener)
  },
  onReminderDue: (callback: (reminder: Reminder) => void): (() => void) => {
    const listener = (_event: unknown, reminder: Reminder): void => callback(reminder)
    ipcRenderer.on(IPC.REMINDER_DUE, listener)
    return () => ipcRenderer.removeListener(IPC.REMINDER_DUE, listener)
  },
  runTextAction: (
    kind: TextActionKind,
    customInstruction?: string
  ): Promise<{ result: string; canReplace: boolean }> =>
    ipcRenderer.invoke(IPC.RUN_TEXT_ACTION, kind, customInstruction),
  replaceSelection: (text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.REPLACE_SELECTION, text),
  onShowSettings: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.SHOW_SETTINGS, listener)
    return () => ipcRenderer.removeListener(IPC.SHOW_SETTINGS, listener)
  },
  sendTranscript: (utterance: string): Promise<NimbusResponse> =>
    ipcRenderer.invoke(IPC.TRANSCRIPT, utterance),
  transcribeAudio: (audio: ArrayBuffer, mimeType: string): Promise<string> =>
    ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, audio, mimeType),
  synthesizeSpeech: (text: string): Promise<SynthesizedSpeech> =>
    ipcRenderer.invoke(IPC.SYNTHESIZE_SPEECH, text),
  hide: (): void => {
    ipcRenderer.send(IPC.HIDE)
  },
  resetConversation: (): void => {
    ipcRenderer.send(IPC.RESET_CONVERSATION)
  },
  openExternal: (url: string): void => {
    ipcRenderer.send(IPC.OPEN_EXTERNAL, url)
  },
  onRegionImage: (callback: (dataUri: string) => void): (() => void) => {
    const listener = (_event: unknown, dataUri: string): void => callback(dataUri)
    ipcRenderer.on(IPC.REGION_IMAGE, listener)
    return () => ipcRenderer.removeListener(IPC.REGION_IMAGE, listener)
  },
  sendRegion: (
    region: { x: number; y: number; width: number; height: number } | 'full' | null
  ): void => {
    ipcRenderer.send(IPC.REGION_SELECTED, region)
  },
  copyText: (text: string): void => {
    ipcRenderer.send(IPC.COPY_TEXT, text)
  },
  setMouseIgnore: (ignore: boolean): void => {
    ipcRenderer.send(IPC.SET_MOUSE_IGNORE, ignore)
  }
}

contextBridge.exposeInMainWorld('nimbus', api)

export type NimbusApi = typeof api
