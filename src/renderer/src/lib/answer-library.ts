export interface SavedAnswer {
  id: string
  title: string
  text: string
  createdAt: number
  pinned: boolean
  sources: { title: string; url: string }[]
}
export const LIBRARY_KEY = 'nimbus.saved-answers.v1'
export const LIBRARY_EVENT = 'nimbus-library-change'
export function parseLibrary(raw: string | null): SavedAnswer[] {
  try {
    const data: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(data)) return []
    return data.filter((entry): entry is SavedAnswer => Boolean(entry &&
      typeof entry.id === 'string' && typeof entry.title === 'string' &&
      typeof entry.text === 'string' && Number.isFinite(entry.createdAt) &&
      typeof entry.pinned === 'boolean' && Array.isArray(entry.sources)))
      .slice(0, 100).map(entry => ({ ...entry,
        title: entry.title.slice(0, 200), text: entry.text.slice(0, 40000),
        sources: entry.sources.filter(source => {
          try { return typeof source.title === 'string' && ['https:', 'http:'].includes(new URL(source.url).protocol) } catch { return false }
        }).slice(0, 20)
      }))
  } catch { return [] }
}
export function readLibrary(): SavedAnswer[] {
  try { return parseLibrary(localStorage.getItem(LIBRARY_KEY)) } catch { return [] }
}
export function writeLibrary(entries: SavedAnswer[]): void {
  if (entries.length > 100) throw new Error('Your library holds 100 answers. Remove an answer before saving another.')
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries))
  window.dispatchEvent(new Event(LIBRARY_EVENT))
}
export function answerMarkdown(entry: SavedAnswer): string {
  return `## ${entry.title}\n\nSaved ${new Date(entry.createdAt).toLocaleString()}\n\n${entry.text}${entry.sources.length ? '\n\nSources:\n' + entry.sources.map(source => `- ${source.title}: ${source.url}`).join('\n') : ''}`
}
