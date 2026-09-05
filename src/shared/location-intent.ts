/** A location used to qualify a question is not a request for an address. */
export function asksWhereTheyAre(utterance: string): boolean {
  return /^(?:(?:can|could|would) you (?:tell me |show me )?|please |do you know )*(?:where am i|where i am|where we are|my location|my position|wo bin ich|mein standort)(?: right now| now| on (?:a |the )?map)?[?.! ]*$/i.test(utterance.trim())
}
export function asksLocalWeather(text: string): boolean {
  if (/\b(remind me|reminder|remember that|set an? |dont|don't|do not)\b/i.test(text)) return false
  return /\b(weather|temperature|how hot|how cold|how warm|wetter|temperatur)\b/i.test(text) && /\b(where i am|where we are|here|my location|outside|hier|bei mir)\b/i.test(text)
}
