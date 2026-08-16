import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AiChoice,
  AiProvider,
  NimbusConfig,
  NimbusResponse,
  ProviderModel,
  QuotaLine,
  Reminder,
  LocalModelKind,
  LocalModelProgress,
  LocalModelStatus,
  MeetingLine,
  MeetingSummary,
  SecretName,
  SecretStatus,
  Subtitle,
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
  getSecrets: (): Promise<SecretStatus[]> => ipcRenderer.invoke(IPC.GET_SECRETS),
  setSecret: (name: SecretName, value: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.SET_SECRET, name, value),
  listModels: (provider: AiProvider): Promise<ProviderModel[]> =>
    ipcRenderer.invoke(IPC.LIST_MODELS, provider),
  getAiChoice: (): Promise<AiChoice & { lockedByEnv: boolean }> =>
    ipcRenderer.invoke(IPC.GET_AI_CHOICE),
  setAiChoice: (choice: AiChoice): Promise<void> => ipcRenderer.invoke(IPC.SET_AI_CHOICE, choice),
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
  /** Takes 16kHz mono float samples; the renderer decodes, main transcribes. */
  transcribeAudio: (pcm: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, pcm),
  subtitleFor: (
    pcm: ArrayBuffer,
    offsetMs: number,
    previous: string,
    sourceHint: string
  ): Promise<Subtitle | null> =>
    ipcRenderer.invoke(IPC.SUBTITLE_FOR, pcm, offsetMs, previous, sourceHint),
  cancelReminder: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CANCEL_REMINDER, id),
  getQuotas: (): Promise<QuotaLine[]> => ipcRenderer.invoke(IPC.GET_QUOTAS),
  isWakeWordReady: (): Promise<boolean> => ipcRenderer.invoke(IPC.WAKE_WORD_READY),
  /** Returns only whether it was the wake phrase — never what was said. */
  wakeHeard: (pcm: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke(IPC.WAKE_HEARD, pcm),
  getLocalModelStatus: (kind: LocalModelKind = 'llm'): Promise<LocalModelStatus> =>
    ipcRenderer.invoke(IPC.LOCAL_MODEL_STATUS, kind),
  downloadLocalModel: (kind: LocalModelKind = 'llm'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.DOWNLOAD_LOCAL_MODEL, kind),
  onLocalModelProgress: (callback: (progress: LocalModelProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: LocalModelProgress): void => callback(progress)
    ipcRenderer.on(IPC.LOCAL_MODEL_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC.LOCAL_MODEL_PROGRESS, listener)
  },
  meetingPiece: (pcm: ArrayBuffer, previous: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.MEETING_PIECE, pcm, previous),
  saveMeeting: (
    lines: MeetingLine[],
    startedAt: number
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.SAVE_MEETING, lines, startedAt),
  summarizeMeeting: (lines: MeetingLine[], startedAt: number): Promise<MeetingSummary> =>
    ipcRenderer.invoke(IPC.SUMMARIZE_MEETING, lines, startedAt),
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
