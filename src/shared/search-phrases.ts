/**
 * "Search the internet for X" — an instruction, not a question.
 *
 * The router is a model, and models are agreeable: told to look something up
 * they would sometimes classify the sentence as chat and then answer it from
 * memory, which comes out as "I don't have information about that" for the one
 * category of question where the user has *explicitly said where to get it*.
 * That is close to the worst failure an assistant can have, because the user
 * already said what to do and it declined.
 *
 * So an explicit instruction to search is matched here, locally, and forces
 * the search path regardless of what the router decided. No round trip, no
 * temperature, nothing to disagree with.
 *
 * Matching is shape-based rather than a phrase list: people say this a hundred
 * ways, and the shape — a search verb aimed at the web — is the stable part.
 * English and German are both handled because the app ships with a German
 * locale and its user speaks both.
 */

import { normalizeUtterance } from './stop-phrases'

/**
 * Verbs that mean "go and look", once the sentence is normalized.
 *
 * Longest alternative first throughout: JavaScript alternation takes the first
 * branch that matches, so "find" listed before "find out" would consume the
 * verb and leave "out on the web" for a pattern expecting the web noun next.
 */
const SEARCH_VERB = '(search|look up|look|google|bing|find out|find|check|research|browse)'

/** Words that mean "on the web", in either language. */
const WEB_NOUN = '(the )?(internet|websearch|web|online|net|google|browser|netz)'

const PATTERNS: RegExp[] = [
  /\b(?:see|check|find|know|learn) (?:on|from) (?:the )?(?:internet|web)\b/,
  // "search the internet for the price of a 3070", "look it up online",
  // "check online for the ps5 price", "find out on the web who won".
  new RegExp(
    `\\b${SEARCH_VERB} (it |this |that |them )?(for |about )?(on |in |im |auf |through |using )?${WEB_NOUN}\\b`
  ),
  // A bare instruction with an object, using only verbs that cannot mean
  // anything else. "check" and "find" are deliberately absent here: "check the
  // weather" and "find me a song" are a weather lookup and a music request,
  // and forcing those onto the web would break two working features to fix one.
  /^(ok |okay |hey |nimbus |please |just |can you |could you |would you |will you |i want you to |i need you to )*(search|look up|google|bing|research) (for )?\S/,
  // "google it", "bing this" — the verb alone is the whole instruction.
  /\b(google|bing|duckduckgo) (it|this|that|them|me)\b/,
  // "look it up", "look this up".
  /\blook (it|this|that|them) up\b/,
  // "do a web search", "run a quick search", "do some research on".
  /\b(do|run|make|perform|give me) (a|an|some) (web |internet |online |quick |proper )*(search|research|lookup)\b/,
  // "what does the internet say about X", "see what the web says".
  /\b(what|see what|check what) (does |do )?(the )?(internet|web|google) (say|says)\b/,
  // German: "such im internet nach", "schau mal im netz", "recherchiere das".
  /\b(such|suche|schau|schaue|guck|recherchier|recherchiere|nachschauen|nachsehen)\b[^.]*\b(internet|netz|web|online|google)\b/,
  /^(bitte |kannst du |koenntest du )*(google|recherchiere|suche) (mal )?(das|es|nach|die|den|\S)/
]

/**
 * True when the user told Nimbus to go and look something up.
 *
 * False for questions *about* searching ("how does Google work", "what is a
 * web search") — those name the web as a subject rather than as a place to go.
 */
export function wantsWebSearch(transcript: string): boolean {
  const normalized = normalizeUtterance(transcript)
  if (!normalized) return false
  // Explicit privacy choices take precedence over a matching search phrase.
  if (/\b(dont|do not|never|without|no need to|stop|avoid)\b.*\b(search|google|bing|browse|look|research|internet|web|online)\b|\b(nicht|kein|keine|ohne)\b.*\b(such|suche|suchen|google|recherchieren|internet|web|online)\b/.test(normalized)) return false
  // "what is a search engine" is about the web; "what does the internet say
  // about X" is a request to go and read it. The trailing verb is what tells
  // them apart — with one, the web is the subject; with the other, the source.
  if (
    /^(what|whats|how|why|who|when|which) (is|are|was|does|do|did) (a |an |the )?(google|search engine|websearch|web search|internet|browser)\b(?! (say|says|know|knows|think|thinks|tell|tells|have|has))/.test(
      normalized
    )
  ) {
    return false
  }
  return PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * The sentence with the instruction removed, so the query is what they wanted
 * looked up rather than a search for the words "search the internet for".
 *
 * Returns the original when stripping would leave nothing — "look it up" on
 * its own refers to the previous turn, and the whole sentence is the better
 * thing to hand to a planner that can see the conversation.
 */
export function searchSubject(transcript: string): string {
  const stripped = transcript
    .replace(/^\s*i\s+(?:want|would like|need)\s+to\s+(?:see|check|find|know|learn)\s+(?:on|from)\s+(?:the\s+)?(?:internet|web)\s*/i, '')
    .replace(/^\s*(ok|okay|alright|hey|nimbus|please|just)\b[\s,]*/gi, '')
    .replace(/^\s*(can|could|would|will)\s+you\b[\s,]*/i, '')
    .replace(/^\s*i\s+(want|need)\s+you\s+to\b[\s,]*/i, '')
    .replace(
      /^\s*(search|look|google|bing|check|research|browse|find)(\s+(up|for|out))?\s+(on\s+|in\s+|im\s+|auf\s+|through\s+|using\s+)?(the\s+)?(internet|web|online|net|google|browser)?\s*(for|about|on)?[\s,:]*/i,
      ''
    )
    .replace(/\s+(on|in)\s+the\s+(internet|web)\s*[.?!]*\s*$/i, '')
    .replace(/\s+online\s*[.?!]*\s*$/i, '')
    .replace(/^\s*(for|about)\s+/i, '')
    .trim()
  // "look it up" strips down to "it up", which is not something anyone can
  // search for. Residue made only of pronouns and particles means the sentence
  // was pointing at the previous turn, so hand the planner the whole thing and
  // let the conversation resolve it.
  const meaningful = stripped.replace(/\b(it|this|that|them|up|out|please|for|me|the)\b/gi, '').trim()
  return meaningful.length > 2 ? stripped : transcript.trim()
}
