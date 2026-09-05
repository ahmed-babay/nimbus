import type { RefObject } from 'react'
import type { NimbusState } from '@shared/types'
import { Waveform } from './Waveform'

export function VoiceMessageBar({ state, transcribing, levelRef, onSend, onStop }: {
  state: NimbusState; transcribing: boolean; levelRef: RefObject<number>
  onSend: () => void; onStop: () => void
}) {
  const recording = state === 'listening' && !transcribing
  const speaking = state === 'speaking'
  const label = transcribing ? 'Transcribing your message' : recording ? 'Your voice message' : speaking ? 'Nimbus is speaking' : 'Preparing your reply'
  const hint = recording ? 'Pause to send automatically' : transcribing ? 'Turning your voice into text' : speaking ? 'You can stop the reply at any time' : 'Your message has been received'
  return <section className="voice-message" aria-label="Voice message controls" data-recording={recording}>
    <div className="voice-message-heading"><span className="voice-message-dot" /><span role="status">{label}</span><span className="voice-message-mode">{recording ? 'LIVE' : speaking ? 'VOICE' : 'PROCESSING'}</span></div>
    <div className="voice-message-controls">
      <button className="voice-message-stop" onClick={onStop} aria-label={recording ? 'Discard voice message' : 'Stop response'} title={recording ? 'Discard this recording' : 'Stop response'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">{recording ? <path d="m4 4 8 8M12 4l-8 8" /> : <rect x="4" y="4" width="8" height="8" rx="2" fill="currentColor" stroke="none" />}</svg>
      </button>
      <div className="voice-message-meter" aria-hidden="true">
        {recording || speaking ? <Waveform levelRef={levelRef} barCount={42} /> : <span className="voice-message-processing"><i /><i /><i /></span>}
      </div>
      {recording && <button className="voice-message-send" onClick={onSend} aria-label="Send voice message" title="Send voice message"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14V4m-4 4 4-4 4 4" /></svg></button>}
    </div>
    <p className="voice-message-hint">{hint}</p>
  </section>
}
