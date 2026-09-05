const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')

function source(file) {
  const filename = path.resolve(file)
  const { outputFiles } = buildSync({ entryPoints: [filename], bundle: true, write: false, platform: 'node', format: 'cjs' })
  const mod = new Module(filename, module)
  mod._compile(outputFiles[0].text, filename)
  return mod.exports
}
const { directMusicIntent, wantsBrowserPlayback } = source('src/services/music-intent.ts')
const { findStation, normalizeGenre } = source('src/services/radio.ts')
const { silenceWindowMs } = source('src/renderer/src/lib/voice-timing.ts')
const { deferFeedback } = source('src/renderer/src/lib/deferred-feedback.ts')
const { SOUND_SCORE, CUE_GAIN, CUE_CEILING } = source('src/renderer/src/lib/sound-design.ts')
const { chooseAcknowledgment } = source('src/renderer/src/lib/acknowledgment-phrases.ts')
const { wantsWebSearch, searchSubject } = source('src/shared/search-phrases.ts')
const { factsFromReply } = source('src/services/facts-card.ts')
const { parseLibrary, answerMarkdown } = source('src/renderer/src/lib/answer-library.ts')
const { speechGain } = source('src/renderer/src/lib/speech-level.ts')
const { quickCalculation } = source('src/shared/quick-calculation.ts')

test('local calculations preserve precedence, percentages and explicit errors', () => {
  assert.equal(quickCalculation('calculate (125 + 75) / 4'), '50. Calculated on this device.')
  assert.equal(quickCalculation('what is 20 percent of 150'), '30. Calculated on this device.')
  assert.equal(quickCalculation('2 plus 3 times 4'), '14. Calculated on this device.')
  assert.equal(quickCalculation('(-2 + 5) * 3'), '9. Calculated on this device.')
  assert.match(quickCalculation('5 / 0'), /undefined/)
  assert.match(quickCalculation('9007199254740993 + 1'), /precision/)
  assert.equal(quickCalculation('2026-09-05'), null)
  assert.equal(quickCalculation('remind me in 5 minutes'), null)
  assert.equal(quickCalculation('explain 1 + 2'), null)
  assert.equal(quickCalculation('process.exit()'), null)
})

test('unit conversions check dimensions and temperature bounds', () => {
  assert.equal(quickCalculation('convert 10 miles to km'), '10 miles = 16.09344 km.')
  assert.equal(quickCalculation('32 fahrenheit to celsius'), '32 °F = 0 °C.')
  assert.equal(quickCalculation('convert 0 kelvin to celsius'), '0 K = -273.15 °C.')
  assert.equal(quickCalculation('2 hours in minutes'), '2 hours = 120 minutes.')
  assert.match(quickCalculation('convert -1 kelvin to celsius'), /absolute zero/)
  assert.equal(quickCalculation('convert 5 kg to km'), null)
  assert.equal(quickCalculation('50 euros to dollars'), null)
})

test('saved answers survive malformed storage and exclude unsafe source links', () => {
  assert.deepEqual(parseLibrary('{broken'), [])
  assert.deepEqual(parseLibrary('[null, {}, 42]'), [])
  const entry = { id: 'one', title: 'A useful answer', text: 'Keep this', createdAt: 1000, pinned: false,
    sources: [{ title: 'Source', url: 'https://example.com' }, { title: 'Unsafe', url: 'javascript:alert(1)' }, null] }
  const parsed = parseLibrary(JSON.stringify([entry]))
  assert.equal(parsed[0].sources.length, 1)
  assert.match(answerMarkdown(parsed[0]), /Keep this/)
  assert.match(answerMarkdown(parsed[0]), /https:\/\/example.com/)
})

test('voice lift respects every channel, headroom, mute and invalid samples', () => {
  const buffer = (...channels) => ({ numberOfChannels: channels.length, getChannelData: i => new Float32Array(channels[i]) })
  assert.equal(speechGain(buffer([.1, -.1])), 2.2)
  assert.ok(speechGain(buffer([.1], [1])) <= .85)
  assert.equal(speechGain(buffer([.8]), 0), 0)
  assert.equal(speechGain(buffer([NaN])), 0)
  assert.ok(speechGain(buffer([.5]), .5) < 1)
})

test('fact source attribution never matches an unrelated URL path', () => {
  const card = factsFromReply(JSON.stringify({ usable: true, layout: 'price', title: 'Price', headline: '€10',
    groups: [{ title: 'Shop', headline: '€10', sourceNote: 'shop.com' }] }),
    { query: 'price', sources: [{title: 'Unrelated', url: 'https://example.com/shop.com', snippet: ''}] })
  assert.equal(card.groups[0].url, undefined)
  assert.equal(factsFromReply('null', {query: '', sources: []}), null)
})

test('acknowledgments vary without repeating the last spoken phrase', () => {
  for (const language of ['English', 'German', 'Arabic', 'French', 'Spanish']) {
    const choices = new Set([0, .25, .5, .99].map(value => chooseAcknowledgment(language, undefined, () => value)))
    assert.equal(choices.size, 4)
    for (const previous of choices) {
      for (const value of [0, .4, .99]) {
        const next = chooseAcknowledgment(language, previous, () => value)
        assert.ok(choices.has(next))
        assert.notEqual(next, previous)
        assert.doesNotMatch(next, /hmm/i)
      }
    }
  }
  assert.equal(chooseAcknowledgment(' English ', undefined, () => 0), 'Let me check.')
  assert.equal(chooseAcknowledgment('unsupported'), undefined)
})

test('sound cues have distinct contours and bounded levels and tails', () => {
  const scores = Object.values(SOUND_SCORE)
  assert.equal(new Set(scores.map(JSON.stringify)).size, 5)
  for (const score of scores) for (const note of score) {
    assert.ok(note.gain > 0 && note.gain <= .05)
    assert.ok(note.at + note.length <= .35)
    assert.ok(note.from > 0 && note.to > 0)
  }
  // Audible on speakers, and still with headroom to spare. The authored gains
  // above are a balance, not a level; what actually reaches the mixer is the
  // gain times CUE_GAIN, and every note of every cue can overlap every other
  // note of the same cue.
  assert.ok(CUE_GAIN > 1)
  for (const score of scores) {
    let simultaneous = 0
    for (const note of score) {
      const played = Math.min(CUE_CEILING, note.gain * CUE_GAIN)
      assert.ok(played <= CUE_CEILING)
      simultaneous += played
    }
    assert.ok(simultaneous < 1, `cue sums to ${simultaneous}, which clips`)
  }
  // The quietest cue still has to be heard over a room.
  const loudest = Math.max(...scores.flat().map((note) => note.gain * CUE_GAIN))
  assert.ok(loudest > .1)
})

test('fast answers cancel acknowledgment before synthesis starts', () => {
  let run; let prepared = 0
  const cancel = deferFeedback({
    prepare: async () => { prepared++; return 'audio' }, play: () => () => {},
    schedule: callback => { run = callback; return () => {} }
  })
  cancel(); run()
  assert.equal(prepared, 0)
})

test('late acknowledgment cannot play after cancellation', async () => {
  let resolve; let run; let played = false
  const cancel = deferFeedback({
    prepare: () => new Promise(done => { resolve = done }),
    play: () => { played = true; return () => {} },
    schedule: callback => { run = callback; return () => {} }
  })
  run(); cancel(); resolve('audio')
  await new Promise(done => setImmediate(done))
  assert.equal(played, false)
})

test('answer arrival stops active acknowledgment once', async () => {
  let run; let stopped = 0
  const cancel = deferFeedback({
    prepare: async () => 'audio', play: () => () => { stopped++ },
    schedule: callback => { run = callback; return () => {} }
  })
  run(); await new Promise(done => setImmediate(done)); cancel(); cancel()
  assert.equal(stopped, 1)
})

test('voice pauses stay patient after a short opening and honor longer preferences', () => {
  assert.equal(silenceWindowMs(400, 900), 1800)
  assert.equal(silenceWindowMs(2000), 1200)
  assert.equal(silenceWindowMs(400, 2500), 2500)
  assert.equal(silenceWindowMs(2000, NaN), 1200)
  assert.equal(silenceWindowMs(2000, -10), 600)
  assert.equal(silenceWindowMs(2000, Infinity), 1200)
})

test('common spoken music commands work without an LLM', () => {
  for (const text of ['play jazz', 'Please put on some lofi music', 'can you play relaxing music please', 'play music', 'play luffy', 'play focus music in Nimbus']) {
    assert.equal(directMusicIntent(text)?.params.playback, 'station', text)
  }
})
test('ambiguous requests and specific songs remain contextual', () => {
  for (const text of ['play chess', 'play Yesterday by The Beatles', 'why do people play jazz?', 'play the One Piece opening', 'play it again', 'play jazz on YouTube']) {
    assert.equal(directMusicIntent(text), null, text)
  }
})
test('opening the browser requires an explicit, non-negated request', () => {
  for (const text of ['play jazz', 'play music in Nimbus', "play jazz but don't open YouTube", 'play jazz, not in the browser']) {
    assert.equal(wantsBrowserPlayback(text), false, text)
  }
  assert.equal(wantsBrowserPlayback('play jazz on YouTube'), true)
  assert.equal(wantsBrowserPlayback('open the video'), true)
})
test('genre repair does not rewrite named fictional characters', () => {
  assert.equal(normalizeGenre('low fi'), 'lofi')
  assert.equal(normalizeGenre('Luffy from One Piece'), 'Luffy from One Piece')
})
test('station lookup survives a mirror outage, normalizes moods and rejects unsafe streams', async () => {
  const original = global.fetch
  const urls = []
  global.fetch = async (url) => {
    urls.push(url)
    if (url.includes('de1.')) throw new Error('offline')
    return { ok: true, json: async () => [
      { name: 'Invalid', url_resolved: 'javascript:bad', codec: 'MP3' },
      { name: 'Focus FM', url_resolved: 'https://example.com/live.mp3', codec: 'MP3', tags: 'ambient,focus' }
    ] }
  }
  try {
    const result = await findStation('focus music')
    assert.equal(result.name, 'Focus FM')
    assert.equal(result.streamUrl, 'https://example.com/live.mp3')
    assert.ok(urls.every(url => url.includes('ambient')))
  } finally { global.fetch = original }
})
test('station failure is explicit', async () => {
  const original = global.fetch
  global.fetch = async () => ({ ok: false })
  try { await assert.rejects(findStation('jazz'), /couldn't find a station/) }
  finally { global.fetch = original }
})

test('an explicit instruction to search is recognised, and an ordinary question is not', () => {
  const asked = [
    'search the internet for the price of an rtx 3070',
    'can you search the web for the iPhone 17 price',
    'look it up online',
    'google it',
    'google the price of eggs',
    'search for the current CEO of Nvidia',
    'look up the population of Darmstadt',
    'do a quick web search on this',
    'what does the internet say about the new MacBook',
    'research the best noise cancelling headphones',
    'find out on the web who won the game',
    'check online for the PS5 price',
    'such im Internet nach dem Preis der PS5'
  ]
  for (const text of asked) assert.equal(wantsWebSearch(text), true, text)

  // The intents that reach a real source must keep reaching it: forcing these
  // onto the web would trade a weather card for a list of weather websites.
  const notAsked = [
    'do not search the internet for this',
    "don't google it",
    'answer without browsing the web',
    'bitte nicht im Internet suchen',
    "what's the weather in Berlin",
    'play some jazz',
    'find me a song by Adele',
    'check the weather',
    'what is google',
    'how does a search engine work',
    'when is the next train to Frankfurt',
    'remind me to call the landlord',
    'how far is the airport',
    'find my keys',
    'how much is 50 euros in dollars'
  ]
  for (const text of notAsked) assert.equal(wantsWebSearch(text), false, text)
})

test('the search instruction is stripped from the query, unless nothing is left', () => {
  assert.equal(searchSubject('search the internet for the price of an rtx 3070'), 'the price of an rtx 3070')
  assert.equal(searchSubject('google the price of eggs'), 'price of eggs')
  assert.equal(searchSubject('look up the population of Darmstadt'), 'population of Darmstadt')
  // Pronoun-only leftovers point at the previous turn, so the whole sentence
  // goes to the planner instead of a search for "it up".
  assert.equal(searchSubject('look it up online'), 'look it up online')
  assert.equal(searchSubject('google it'), 'google it')
})

test('a fact card is built only when the sources actually held a structure', () => {
  const sources = [{ title: 'Geizhals', url: 'https://geizhals.de/rtx3070', snippet: '' }]
  const priced = factsFromReply(JSON.stringify({
    usable: true,
    layout: 'price',
    title: 'RTX 3070',
    headline: '€329',
    headlineLabel: 'cheapest used',
    groups: [{ title: 'Geizhals', headline: '€329', sourceNote: 'geizhals.de' }],
    rows: [{ label: 'Memory', value: '8 GB GDDR6' }]
  }), { query: 'rtx 3070 price', sources })
  assert.equal(priced.layout, 'price')
  assert.equal(priced.headline, '€329')
  // Groups are only clickable when they matched a page that was really read.
  assert.equal(priced.groups[0].url, 'https://geizhals.de/rtx3070')

  // Fenced JSON is still JSON — providers without constrained decoding fence.
  assert.ok(factsFromReply('```json\n' + JSON.stringify({
    usable: true, layout: 'list', title: 'Requirements',
    bullets: ['A valid passport', 'Proof of address', 'A recent photo']
  }) + '\n```', { query: 'x', sources }))

  // The model saying it has nothing structured is honoured verbatim.
  assert.equal(factsFromReply(JSON.stringify({
    usable: false, layout: 'profile', title: 'Anything', rows: [{ label: 'a', value: 'b' }]
  }), { query: 'x', sources }), null)

  // A table with one row looks like a bug, so it is not shown.
  assert.equal(factsFromReply(JSON.stringify({
    usable: true, layout: 'profile', title: 'Thing', rows: [{ label: 'a', value: 'b' }]
  }), { query: 'x', sources }), null)

  // A comparison needs two things to compare, and a list needs more than one
  // point, whatever else came back with them.
  assert.equal(factsFromReply(JSON.stringify({
    usable: true, layout: 'comparison', title: 'X vs Y', headline: 'X',
    groups: [{ title: 'X', headline: '1' }]
  }), { query: 'x', sources }), null)
  assert.equal(factsFromReply(JSON.stringify({
    usable: true, layout: 'list', title: 'Only one', headline: 'a', bullets: ['just this']
  }), { query: 'x', sources }), null)

  // Rows with no value, and invented layouts, are dropped rather than shown.
  const messy = factsFromReply(JSON.stringify({
    usable: true, layout: 'nonsense', title: 'Thing',
    rows: [{ label: 'a', value: '' }, { label: '', value: 'b' }, { label: 'c', value: 'd' }],
    bullets: ['one', '', 'two']
  }), { query: 'x', sources })
  assert.equal(messy.layout, 'profile')
  assert.deepEqual(messy.rows, [{ label: 'c', value: 'd' }])
  assert.deepEqual(messy.bullets, ['one', 'two'])
})
