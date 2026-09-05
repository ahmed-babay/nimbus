import type { RefObject } from 'react'
import type { NimbusState } from '@shared/types'
import { Orb } from './Orb'

export function Presence({ state, searching, answerSeq, levelRef, compact, transcribing, pulseKey }: {
  state: NimbusState; searching: boolean; answerSeq: number
  levelRef: RefObject<number>; compact: boolean; transcribing: boolean
  /** Rings the orb's rim when the overlay changes size. */
  pulseKey?: string | number
}) {
  const title = transcribing ? 'Turning voice into words' : searching ? 'Following the sources' : {
    idle: 'A little space for your mind.', listening: 'I’m listening.',
    thinking: 'Let’s work it out.', speaking: 'Here’s what I found.', playing: 'Find your flow.'
  }[state]
  return <div className={`nimbus-presence ${compact ? 'is-compact' : ''}`}>
    <div className="nimbus-presence-light" aria-hidden="true" />
    <Orb state={transcribing ? 'thinking' : state} searching={searching} answerSeq={answerSeq} levelRef={levelRef} size={72} pulseKey={pulseKey} />
    <div className="nimbus-presence-copy">
      {!compact && <p className="experience-eyebrow">Your personal intelligence</p>}
      <p className="nimbus-presence-title" role="status">{title}</p>
      {!compact && <p className="nimbus-presence-caption">{state === 'listening' ? 'Speak naturally. There’s no rush.' : 'A question, an idea, or a moment to focus.'}</p>}
    </div>
  </div>
}
