import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AiChoice,
  Interruption,
  AiProvider,
  OverlayLayout,
  OverlaySqueeze,
  NimbusConfig,
  NimbusResponse,
  ProviderModel,
  QuotaLine,
  Reminder,
  LocalModelKind,
  LocalModelProgress,
  LocalModelStatus,
  MeetingExportFormat,
  MeetingLine,
  MeetingSummary,
  SecretName,
  SecretStatus,
  StandingItem,
  StockCardData,
  StockRange,
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
  onSpeechChunk: (callback: (chunk: string, requestId?: number) => void): (() => void) => {
    const listener = (_event: unknown, chunk: string, requestId?: number): void => callback(chunk, requestId)
    ipcRenderer.on(IPC.SPEECH_CHUNK, listener)
    return () => ipcRenderer.removeListener(IPC.SPEECH_CHUNK, listener)
  },
  onSearchStatus: (callback: (active: boolean) => void): (() => void) => {
    const listener = (_event: unknown, active: boolean): void => callback(active)
    ipcRenderer.on(IPC.SEARCH_STATUS, listener)
    return () => ipcRenderer.removeListener(IPC.SEARCH_STATUS, listener)
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
  /**
   * Puts a draft in the app's message box, never sending it. Resolves false
   * when the app wouldn't take the paste — the draft is on the clipboard
   * regardless.
   */
  replyInApp: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.REPLY_IN_APP, text),
  onShowSettings: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.SHOW_SETTINGS, listener)
    return () => ipcRenderer.removeListener(IPC.SHOW_SETTINGS, listener)
  },
  sendTranscript: (utterance: string, requestId?: number): Promise<NimbusResponse> =>
    ipcRenderer.invoke(IPC.TRANSCRIPT, utterance, requestId),
  /** Takes 16kHz mono float samples; the renderer decodes, main transcribes. */
  transcribeAudio: (pcm: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, pcm),
  /** Map tiles for a panned or zoomed view; the CSP blocks fetching them here. */
  mapTiles: (
    zoom: number,
    wanted: Array<{ col: number; row: number }>
  ): Promise<Array<{ col: number; row: number; image: string }>> =>
    ipcRenderer.invoke(IPC.MAP_TILES, zoom, wanted),
  /** Anything raised while Nimbus was told to stay quiet. */
  getMissed: (): Promise<Interruption[]> => ipcRenderer.invoke(IPC.GET_MISSED),
  clearMissed: (): Promise<void> => ipcRenderer.invoke(IPC.CLEAR_MISSED),
  muteSource: (source: string): Promise<void> => ipcRenderer.invoke(IPC.MUTE_SOURCE, source),
  /**
   * Speech probability per 512-sample frame, from Silero VAD in the main
   * process. An empty array means the model isn't loaded and the caller should
   * fall back to its own heuristic rather than treat the audio as silence.
   */
  vadFrames: (id: string, pcm: ArrayBuffer): Promise<number[]> =>
    ipcRenderer.invoke(IPC.VAD_FRAMES, id, pcm),
  /** Starts or ends a turn's VAD state — the model is recurrent, so turns must not bleed. */
  vadSession: (id: string, active: boolean): void => {
    ipcRenderer.send(IPC.VAD_SESSION, id, active)
  },
  subtitleFor: (
    pcm: ArrayBuffer,
    offsetMs: number,
    previous: string,
    sourceHint: string
  ): Promise<Subtitle | null> =>
    ipcRenderer.invoke(IPC.SUBTITLE_FOR, pcm, offsetMs, previous, sourceHint),
  getQuote: (symbol: string, range: StockRange): Promise<StockCardData> =>
    ipcRenderer.invoke(IPC.GET_QUOTE, symbol, range),
  getWatchlist: (): Promise<StockCardData[]> => ipcRenderer.invoke(IPC.GET_WATCHLIST),
  getStanding: (): Promise<StandingItem[]> => ipcRenderer.invoke(IPC.GET_STANDING),
  cancelStanding: (kind: StandingItem['kind'], id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CANCEL_STANDING, kind, id),
  onShowStanding: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.SHOW_STANDING, listener)
    return () => ipcRenderer.removeListener(IPC.SHOW_STANDING, listener)
  },
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
  /** The seconds-long read into memory, not the one-off download. */
  onLocalModelLoading: (
    callback: (state: { active: boolean; progress: number }) => void
  ): (() => void) => {
    const listener = (_event: unknown, state: { active: boolean; progress: number }): void =>
      callback(state)
    ipcRenderer.on(IPC.LOCAL_MODEL_LOADING, listener)
    return () => ipcRenderer.removeListener(IPC.LOCAL_MODEL_LOADING, listener)
  },
  meetingPiece: (pcm: ArrayBuffer, previous: string, language: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.MEETING_PIECE, pcm, previous, language),
  saveMeeting: (
    lines: MeetingLine[],
    startedAt: number,
    format: MeetingExportFormat,
    summary: MeetingSummary | null
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.SAVE_MEETING, lines, startedAt, format, summary),
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
  moveOverlay: (dx: number, dy: number): void => {
    ipcRenderer.send(IPC.MOVE_OVERLAY, dx, dy)
  },
  snapOverlay: (): void => {
    ipcRenderer.send(IPC.SNAP_OVERLAY)
  },
  setOverlaySqueeze: (squeeze: OverlaySqueeze): void => {
    ipcRenderer.send(IPC.SET_OVERLAY_SQUEEZE, squeeze)
  },
  getOverlayLayout: (): Promise<OverlayLayout> => ipcRenderer.invoke(IPC.GET_OVERLAY_LAYOUT),
  onOverlayLayout: (callback: (layout: OverlayLayout) => void): (() => void) => {
    const listener = (_event: unknown, layout: OverlayLayout): void => callback(layout)
    ipcRenderer.on(IPC.OVERLAY_LAYOUT, listener)
    return () => ipcRenderer.removeListener(IPC.OVERLAY_LAYOUT, listener)
  },
  setMouseIgnore: (ignore: boolean): void => {
    ipcRenderer.send(IPC.SET_MOUSE_IGNORE, ignore)
  }
}

contextBridge.exposeInMainWorld('nimbus', api)

export type NimbusApi = typeof api
