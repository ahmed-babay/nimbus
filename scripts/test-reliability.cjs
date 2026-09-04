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
