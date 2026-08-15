export const IPC = {
  /** main -> renderer: wake word detected (or tray "Show Nimbus" clicked), overlay should appear and start listening */
  WAKE: 'nimbus:wake',
  /** main -> renderer: tray "Settings" clicked, overlay should appear showing settings */
  SHOW_SETTINGS: 'nimbus:show-settings',
  /** renderer -> main (invoke): final speech transcript, returns a NimbusResponse */
  TRANSCRIPT: 'nimbus:transcript',
  /** renderer -> main (invoke): recorded mic audio (ArrayBuffer + mimeType), returns the transcript string */
  TRANSCRIBE_AUDIO: 'nimbus:transcribe-audio',
  /** renderer -> main (invoke): text to speak, returns { audio: ArrayBuffer, mimeType } to play */
  SYNTHESIZE_SPEECH: 'nimbus:synthesize-speech',
  /** renderer -> main: request the overlay hide itself (auto-fade finished, or user dismissed) */
  HIDE: 'nimbus:hide',
  /** renderer -> main (invoke): read config.json for overlay timing / integration toggles */
  GET_CONFIG: 'nimbus:get-config',
  /** renderer -> main: overlay closed, clear conversation history so the next session starts fresh */
  RESET_CONVERSATION: 'nimbus:reset-conversation',
  /** main -> renderer: a token chunk of the answer as the model generates it */
  SPEECH_CHUNK: 'nimbus:speech-chunk',
  /** renderer -> main: open a result link in the user's default browser */
  OPEN_EXTERNAL: 'nimbus:open-external',
  /** main -> renderer: screen captured; payload is a thumbnail data URI to display */
  SCREEN_CAPTURED: 'nimbus:screen-captured',
  /** main -> renderer: text selected in another app is ready to act on */
  SELECTION_CAPTURED: 'nimbus:selection-captured',
  /** renderer -> main (invoke): run an action on the captured selection */
  RUN_TEXT_ACTION: 'nimbus:run-text-action',
  /** renderer -> main (invoke): paste a result back over the original selection */
  REPLACE_SELECTION: 'nimbus:replace-selection',
  /** renderer -> main: toggle click-through as the pointer enters/leaves the card */
  SET_MOUSE_IGNORE: 'nimbus:set-mouse-ignore',
  /** renderer -> main: put an answer on the clipboard */
  COPY_TEXT: 'nimbus:copy-text'
} as const
