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
  COPY_TEXT: 'nimbus:copy-text',
  /** renderer -> main (invoke): which API keys are set, and from where. Never returns key values. */
  GET_SECRETS: 'nimbus:get-secrets',
  /** renderer -> main (invoke): store or clear one API key */
  SET_SECRET: 'nimbus:set-secret',
  /** renderer -> main (invoke): list the models a provider's key can use */
  LIST_MODELS: 'nimbus:list-models',
  /** renderer -> main (invoke): read/write the chosen provider and model */
  GET_AI_CHOICE: 'nimbus:get-ai-choice',
  SET_AI_CHOICE: 'nimbus:set-ai-choice',
  /** main -> renderer: a reminder came due; payload is the Reminder to show and speak */
  REMINDER_DUE: 'nimbus:reminder-due',
  /** renderer -> main (invoke): is the on-device model installed? */
  LOCAL_MODEL_STATUS: 'nimbus:local-model-status',
  /** renderer -> main (invoke): download the on-device model */
  DOWNLOAD_LOCAL_MODEL: 'nimbus:download-local-model',
  /** main -> renderer: download progress for the on-device model */
  LOCAL_MODEL_PROGRESS: 'nimbus:local-model-progress',
  /** renderer -> main (invoke): everything Nimbus is holding — watches, events, reminders */
  GET_STANDING: 'nimbus:get-standing',
  /** renderer -> main (invoke): cancel one standing item by kind + id */
  CANCEL_STANDING: 'nimbus:cancel-standing',
  /** main -> renderer: open the panel of standing commitments */
  SHOW_STANDING: 'nimbus:show-standing',
  /** renderer -> main (invoke): drop one reminder by id */
  CANCEL_REMINDER: 'nimbus:cancel-reminder',
  /** renderer -> main (invoke): how much of each free tier is left */
  GET_QUOTAS: 'nimbus:get-quotas',
  /** renderer -> main (invoke): is the wake word listener usable right now? */
  WAKE_WORD_READY: 'nimbus:wake-word-ready',
  /**
   * renderer -> main (invoke): a short burst of mic audio, returns only
   * whether it was the wake phrase. Never returns what was said.
   */
  WAKE_HEARD: 'nimbus:wake-heard',
  /** renderer -> main (invoke): one captured piece of video audio, returns a Subtitle or null */
  SUBTITLE_FOR: 'nimbus:subtitle-for',
  /** renderer -> main (invoke): one captured piece of a meeting, returns the text or null */
  MEETING_PIECE: 'nimbus:meeting-piece',
  /** renderer -> main (invoke): write the transcript to a file the user chooses */
  SAVE_MEETING: 'nimbus:save-meeting',
  /** renderer -> main (invoke): summarise the captured meeting */
  SUMMARIZE_MEETING: 'nimbus:summarize-meeting',
  /** main -> region picker: the frozen screenshot to drag a selection over */
  REGION_IMAGE: 'nimbus:region-image',
  /** region picker -> main: chosen region (0..1), or null to cancel */
  REGION_SELECTED: 'nimbus:region-selected'
} as const
