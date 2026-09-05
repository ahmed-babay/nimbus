import { useEffect, useRef, useState } from 'react'
import type { NimbusResponse } from '@shared/types'
import { answerMarkdown, LIBRARY_EVENT, readLibrary, writeLibrary, type SavedAnswer } from '../lib/answer-library'

export function SaveAnswer({ response, question }: { response: NimbusResponse; question?: string }) {
  const [message, setMessage] = useState('')
  useEffect(() => { setMessage('') }, [response])
  return <span className="library-save">
    <button onClick={() => {
      try {
        let text = response.fullText ?? response.speech
        if (response.card.type === 'facts') {
          const facts = response.card.data
          const lines = [facts.title, facts.subtitle, [facts.headline, facts.headlineLabel, facts.headlineNote].filter(Boolean).join(' · '),
            ...facts.rows.map(row => `${row.label}: ${row.value}${row.note ? ` (${row.note})` : ''}`),
            ...facts.groups.flatMap(group => [group.title, group.headline, ...group.rows.map(row => `${row.label}: ${row.value}`)]),
            ...facts.bullets.map(bullet => `- ${bullet}`)].filter(Boolean)
          text += '\n\n' + lines.join('\n')
        }
        text = text.slice(0, 40000)
        const entries = readLibrary()
        if (entries.some(entry => entry.text === text)) { setMessage('Already saved'); return }
        const data = 'data' in response.card ? response.card.data : undefined
        const sources = data && 'sources' in data && Array.isArray(data.sources) ? data.sources : []
        writeLibrary([{ id: crypto.randomUUID(), title: (question || text).slice(0, 200), text: text.slice(0, 40000), createdAt: Date.now(), pinned: false, sources }, ...entries])
        setMessage('Saved on this device')
      } catch (error) { setMessage(error instanceof Error && error.message.includes('100 answers') ? error.message : 'Could not save. Device storage may be full.') }
    }}>◇ Save answer</button>
    <span role="status">{message}</span>
  </span>
}

export function AnswerLibrary({ onOpen, onAsk, onChange }: { onOpen: () => void; onAsk: (text: string) => void; onChange: (open: boolean) => void }) {
  useEffect(() => () => onChange(false), [onChange])
  const dialog = useRef<HTMLDialogElement>(null)
  const [entries, setEntries] = useState(readLibrary)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [removed, setRemoved] = useState<SavedAnswer | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    const refresh = () => setEntries(readLibrary())
    window.addEventListener(LIBRARY_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(LIBRARY_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])
  const update = (next: SavedAnswer[]) => {
    try { writeLibrary(next); setNotice(''); return true } catch { setNotice('Changes could not be saved. Device storage may be unavailable.'); return false }
  }
  const copy = async (text: string) => {
    try { await window.nimbus.copyText(text); setNotice('Copied to clipboard') } catch { setNotice('Could not copy. Try again.') }
  }
  const visible = entries.filter(entry => `${entry.title} ${entry.text}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
  return <>
    <button className="library-trigger" onClick={() => { onOpen(); onChange(true); setConfirmClear(false); dialog.current?.showModal() }}>Library</button>
    <dialog ref={dialog} className="answer-library nimbus-glass" aria-labelledby="library-title" onClose={() => onChange(false)} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
      <div className="library-heading"><div><p className="experience-eyebrow">Your collection</p><h2 id="library-title">Saved answers</h2></div>
        <button aria-label="Close saved answers" onClick={() => dialog.current?.close()}>×</button></div>
      <p className="library-caption">Only answers you save. Stored on this device. Saved facts may become outdated.</p>
      <input aria-label="Search saved answers" placeholder="Find a saved idea, answer or source…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="library-toolbar"><span>{entries.length} / 100 saved</span>
        <button disabled={!entries.length} onClick={() => void copy(entries.map(answerMarkdown).join('\n\n---\n\n'))}>Copy all as Markdown</button></div>
      <div className="library-entries nimbus-scroll">
        {!visible.length && <p className="library-empty">{entries.length ? 'No saved answers match your search.' : 'Keep the answers worth returning to. Use “Save answer” beneath any response.'}</p>}
        {visible.map(entry => <article key={entry.id}>
          <div className="library-entry-heading"><h3>{entry.title}</h3><button aria-label={entry.pinned ? 'Unpin answer' : 'Pin answer'} aria-pressed={entry.pinned} onClick={() => update(entries.map(item => item.id === entry.id ? { ...item, pinned: !item.pinned } : item))}>{entry.pinned ? '◆' : '◇'}</button></div>
          <time>{new Date(entry.createdAt).toLocaleDateString()}</time>
          <p className="library-answer">{entry.text}</p>
          {entry.sources.map((source, index) => <button className="library-source" key={`${source.url}-${index}`} onClick={() => window.nimbus.openExternal(source.url)}>{source.title} ↗</button>)}
          <div className="library-actions"><button onClick={() => void copy(answerMarkdown(entry))}>Copy</button>
            <button onClick={() => { dialog.current?.close(); onAsk(`Revisit this saved question using current information where available: ${entry.title}`) }}>Ask again</button>
            <button onClick={() => { if (update(entries.filter(item => item.id !== entry.id))) setRemoved(entry) }}>Remove</button></div>
        </article>)}
      </div>
      <div className="library-footer"><span role="status">{notice}</span>
        {removed && <button onClick={() => { if (update([removed, ...entries])) setRemoved(null) }}>Undo removal</button>}
        {!!entries.length && <button onClick={() => setConfirmClear(!confirmClear)}>Clear library</button>}
      </div>
      {confirmClear && <div className="library-confirm">Remove all saved answers from this device? Copy them first if you want a backup.
        <button onClick={() => { if (update([])) { setRemoved(null); setConfirmClear(false) } }}>Remove all</button>
        <button onClick={() => setConfirmClear(false)}>Keep answers</button></div>}
    </dialog>
  </>
}
