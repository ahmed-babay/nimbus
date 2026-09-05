const PHRASES: Record<string, readonly string[]> = {
  english: ['Let me check.', 'One moment.', 'Let me think.', 'Give me a second.'],
  german: ['Ich schaue kurz nach.', 'Einen Moment.', 'Lass mich kurz überlegen.', 'Gib mir eine Sekunde.'],
  arabic: ['دعني أتحقق.', 'لحظة من فضلك.', 'دعني أفكر قليلاً.', 'ثانية واحدة.'],
  french: ['Je regarde.', 'Un instant.', 'Laisse-moi réfléchir.', 'Une petite seconde.'],
  spanish: ['Déjame comprobarlo.', 'Un momento.', 'Déjame pensar.', 'Dame un segundo.']
}

/** Choose only when a slow turn needs feedback, excluding the last spoken cue. */
export function chooseAcknowledgment(language: string, previous?: string, random = Math.random): string | undefined {
  const choices = PHRASES[language.trim().toLowerCase()]?.filter(phrase => phrase !== previous)
  if (!choices?.length) return undefined
  return choices[Math.floor(random() * choices.length)]
}
