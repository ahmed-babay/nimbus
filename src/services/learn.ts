import { complete } from './llm'
import { getFacts, rememberFact } from './memory'

/**
 * Notices durable facts in ordinary conversation.
 *
 * Until now a fact was only kept if the user said "remember this". Everything
 * else went into a raw archive of questions and answers, which is worse than
 * useless as a memory: asked where they lived, Nimbus reasoned from a train
 * search and decided the user lived in Mainz. Storing what somebody asked is
 * not the same as knowing anything about them.
 *
 * So this reads what they said and keeps only what is durably true about
 * them — where they work, what they do, who they live with, what they cannot
 * eat. The archive stays for recall; this is the part that gets used without
 * being asked for.
 *
 * The whole design is biased toward keeping nothing. A memory that is wrong is
 * far more damaging than one that is empty, because it is applied silently to
 * every later answer and the user never sees why. Three separate brakes:
 * a cheap phrase test before the model is called at all, a prompt that spends
 * most of its length on what *not* to keep, and a rule that only first-person
 * statements count.
 */

/**
 * Only sentences where someone says something about themselves are worth a
 * model call. This is a filter, not a decision — it lets far too much through
 * on purpose, and the model does the actual judging.
 */
const SELF_STATEMENT =
  /\b(i|i'm|im|i am|my|mine|me|we|our|call me|ich|mein|meine)\b.{0,120}\b(live|living|work|working|job|office|study|studying|school|university|name|called|wife|husband|partner|kid|kids|child|children|dog|cat|allergic|vegetarian|vegan|don't eat|do not eat|prefer|usually|always|never|birthday|from|moved|commute|wohne|arbeite|heiße)\b/i

const EXTRACT_PROMPT = `You pull durable facts about the user out of things they said.

Return a fact ONLY when the user stated it about themselves, plainly, in this message.

KEEP facts that stay true for months:
- where they live or work, and the address or area if they gave one
- their job, employer, field of study
- names they gave for themselves or people close to them
- lasting constraints: allergies, diet, not driving, working nights
- standing preferences they described as habitual

DO NOT keep:
- anything they asked about rather than stated. "When is the train to Mainz"
  says nothing about where they live or work. This is the single most common
  mistake: a place someone asks about is not a place they belong to.
- anything temporary: how they feel today, where they are right now, what
  they are doing this afternoon
- anything you inferred, guessed, or completed. If they did not say it, it is
  not a fact.
- anything about you, the assistant, or how they want you to behave
- opinions about the world rather than about themselves

Write each fact as a short third-person sentence starting with "The user".
Keep the user's own wording for names and addresses; do not tidy or translate them.

Return an empty list when nothing qualifies. That is the normal answer and it
is always better than a fact you are not sure of.`

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    facts: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['facts']
}

/** Long enough to be a statement, short enough not to be a monologue. */
const MAX_FACT_CHARS = 160

function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

/**
 * Whether a fact is already known, allowing for rewording.
 *
 * Compared on content words rather than exactly: "The user works at Merck" and
 * "The user works for Merck" are the same fact, and keeping both would grow
 * the prompt on every restatement.
 */
function alreadyKnown(candidate: string): boolean {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9äöüß\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 3 && word !== 'user')
    )

  const incoming = words(candidate)
  if (incoming.size === 0) return true

  return getFacts().some((fact) => {
    const known = words(fact.text)
    let shared = 0
    for (const word of incoming) if (known.has(word)) shared++
    return shared / incoming.size > 0.7
  })
}

/**
 * Reads one utterance and stores anything durable in it.
 *
 * Never throws and is not awaited by the answer path: learning something is
 * worth strictly less than replying promptly, and a failed extraction should
 * be invisible.
 */
export async function learnFrom(utterance: string): Promise<string[]> {
  if (!SELF_STATEMENT.test(utterance)) return []

  try {
    const raw = await complete({
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', text: utterance }],
      jsonSchema: SCHEMA,
      temperature: 0
    })
    const parsed = JSON.parse(stripFences(raw)) as { facts?: unknown }
    const facts = Array.isArray(parsed.facts) ? parsed.facts : []

    const kept: string[] = []
    for (const entry of facts) {
      if (typeof entry !== 'string') continue
      const fact = entry.trim()
      if (!fact || fact.length > MAX_FACT_CHARS) continue
      // The model was told to write these; anything not in that shape is it
      // having answered a different question.
      if (!/^the user\b/i.test(fact)) continue
      if (alreadyKnown(fact)) continue
      rememberFact(fact)
      kept.push(fact)
    }

    if (kept.length > 0) console.log(`[learn] remembered: ${kept.join(' | ')}`)
    return kept
  } catch (error) {
    console.warn('[learn] extraction failed:', error instanceof Error ? error.message : error)
    return []
  }
}
