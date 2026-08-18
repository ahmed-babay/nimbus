import { useEffect, useRef, useState } from 'react'
import type { MeetingControls } from '../hooks/useMeeting'

/**
 * The meeting view: what has been said so far, and what to do with it.
 *
 * The transcript is **collapsed while recording**. During an actual meeting
 * the screen belongs to the meeting — a panel unrolling live captions over the
 * call is in the way, and reading your own conversation back at yourself while
 * having it is no use to anyone. What stays visible is only proof of life:
 * that it is running, how long for, and how much it has heard.
 *
 * It opens automatically once recording stops, because that is the moment the
 * transcript becomes the point.
 */

function clock(offsetMs: number): string {
  const total = Math.max(0, Math.round(offsetMs / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function MeetingPanel({ meeting }: { meeting: MeetingControls }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const recording = meeting.phase === 'recording'
  const [expanded, setExpanded] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)

  // Opens once when recording ends. Not tied directly to `recording` so that
  // collapsing it again afterwards actually sticks.
  useEffect(() => {
    if (meeting.phase === 'stopped') setExpanded(true)
    if (meeting.phase === 'idle') setExpanded(false)
  }, [meeting.phase])

  useEffect(() => {
    if (!recording) return
    const tick = (): void => setElapsedMs(Date.now() - meeting.startedAt)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [recording, meeting.startedAt])

  // Follow the conversation while it runs, but stop yanking the view around
  // once it has stopped and the user may be reading back through it.
  useEffect(() => {
    if (!recording || !expanded) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [meeting.lines.length, recording, expanded])

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-2.5">
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-nimbus-accent">
          Meeting
        </div>
        {recording && (
          <span className="flex items-center gap-1.5 text-[10px] text-nimbus-text-dim">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
            </span>
            <span className="tabular-nums">{clock(elapsedMs)}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-nimbus-text-dim">
            {meeting.pending > 0
              ? `${meeting.lines.length} lines · ${meeting.pending} transcribing…`
              : `${meeting.lines.length} ${meeting.lines.length === 1 ? 'line' : 'lines'}`}
          </span>
          <div className="flex overflow-hidden rounded-md border border-white/[0.07]">
            {(['en', 'de'] as const).map((code) => (
              <button
                key={code}
                onClick={() => meeting.setLanguage(code)}
                title={`Transcribe this meeting as ${code === 'en' ? 'English' : 'German'}`}
                className={`px-1.5 py-0.5 text-[9.5px] font-semibold uppercase transition-colors ${
                  meeting.language === code
                    ? 'bg-nimbus-accent/25 text-nimbus-text'
                    : 'text-nimbus-text-dim hover:bg-white/[0.05] hover:text-nimbus-text'
                }`}
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      </div>

      {recording && (
        <p className="mt-1 text-[10px] text-nimbus-text-dim">
          Listening to you and to the call. Nimbus won&apos;t speak or answer until you stop.
        </p>
      )}

      {meeting.lines.length > 0 && (
        <button
          onClick={() => setExpanded((open) => !open)}
          className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg border border-white/[0.07] px-2 py-1 text-left text-[10.5px] text-nimbus-text-dim transition-colors hover:bg-white/[0.05] hover:text-nimbus-text"
        >
          <span
            className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          >
            ›
          </span>
          {expanded ? 'Hide transcript' : 'Show transcript'}
        </button>
      )}

      {meeting.lines.length === 0 && !recording && (
        <p className="mt-2 text-[11px] text-nimbus-text-dim">Nothing was captured.</p>
      )}

      {expanded && meeting.lines.length > 0 && (
        <div
          ref={scrollRef}
          className="mt-2 max-h-[240px] space-y-1.5 overflow-y-auto pr-1"
          onMouseEnter={() => window.nimbus.setMouseIgnore(false)}
        >
          {meeting.lines.map((line, index) => (
            <div key={`${line.offsetMs}-${index}`} className="flex gap-2 text-[11.5px]">
              <span className="w-[34px] shrink-0 pt-[1px] text-[9.5px] tabular-nums text-nimbus-text-dim">
                {clock(line.offsetMs)}
              </span>
              <span
                className={`w-[38px] shrink-0 font-semibold ${
                  line.speaker === 'you' ? 'text-nimbus-accent-bright' : 'text-nimbus-positive'
                }`}
              >
                {line.speaker === 'you' ? 'You' : 'Them'}
              </span>
              <span className="min-w-0 flex-1 leading-snug text-nimbus-text">{line.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {recording ? (
          <button
            onClick={meeting.stop}
            className="rounded-lg border border-nimbus-border px-2.5 py-1 text-[10.5px] text-nimbus-text transition-colors hover:bg-white/[0.06]"
          >
            Stop recording
          </button>
        ) : (
          <>
            <button
              onClick={() => void meeting.summarize()}
              disabled={meeting.lines.length === 0 || meeting.summarizing}
              className="rounded-lg border border-nimbus-accent/50 bg-nimbus-accent/15 px-2.5 py-1 text-[10.5px] text-nimbus-text transition-colors hover:bg-nimbus-accent/25 disabled:opacity-40"
            >
              {meeting.summarizing ? 'Summarising…' : 'Summarise'}
            </button>
            <button
              onClick={() => void meeting.save()}
              disabled={meeting.lines.length === 0}
              className="rounded-lg border border-nimbus-border px-2.5 py-1 text-[10.5px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text disabled:opacity-40"
            >
              Save to a file
            </button>
            <button
              onClick={meeting.reset}
              className="rounded-lg border border-nimbus-border px-2.5 py-1 text-[10.5px] text-nimbus-text-dim transition-colors hover:bg-white/[0.06] hover:text-nimbus-text"
            >
              Discard
            </button>
          </>
        )}
      </div>

      {meeting.savedPath && (
        <p className="mt-1.5 break-all text-[10px] text-nimbus-positive">
          Saved to {meeting.savedPath}
        </p>
      )}
      {meeting.error && <p className="mt-1.5 text-[10px] text-nimbus-negative">{meeting.error}</p>}

      {meeting.summary && (
        <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.03] p-2.5">
          <p className="text-[11.5px] leading-relaxed text-nimbus-text">
            {meeting.summary.summary}
          </p>
          <Section title="Decided" items={meeting.summary.decisions} />
          <Section title="To do" items={meeting.summary.actions} accent />
          <Section title="Still open" items={meeting.summary.openQuestions} />
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  items,
  accent
}: {
  title: string
  items: string[]
  accent?: boolean
}) {
  // An empty list is left out entirely. A meeting that decided nothing should
  // say so by omission rather than showing an empty heading.
  if (items.length === 0) return null
  return (
    <div className="mt-2">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-nimbus-text-dim">
        {title}
      </div>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5 text-[11px] leading-snug text-nimbus-text">
            <span className={accent ? 'text-nimbus-accent-bright' : 'text-nimbus-text-dim'}>•</span>
            <span className="min-w-0 flex-1">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
