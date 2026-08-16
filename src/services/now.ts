/**
 * The model has no clock. Left to itself it guesses the date from training
 * data and gets the timezone wrong, which quietly corrupts anything
 * time-relative: "today", "tonight", "the next train", "how long until…".
 * Every prompt that could touch time gets this line prepended.
 */
export function currentTimeContext(): string {
  const now = new Date()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const formatted = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone
  }).format(now)

  // The offset matters for anything the user might cross-check against a
  // timetable or a foreign colleague's clock.
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const offset = `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`

  return (
    `Current local date and time: ${formatted} (${timeZone}, ${offset}). ` +
    `ISO: ${now.toISOString()}. ` +
    'Treat this as authoritative for anything relative — today, tomorrow, tonight, ' +
    'now, "the next one" — and never state a different date or time than this.'
  )
}

/** The user's IANA timezone, e.g. "Europe/Berlin". */
export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
