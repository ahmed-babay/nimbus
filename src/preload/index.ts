import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { NimbusConfig, NimbusResponse, SynthesizedSpeech } from '../shared/types'

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
  }
}

contextBridge.exposeInMainWorld('nimbus', api)

export type NimbusApi = typeof api
