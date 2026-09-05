// Run after npm run build. Uses the real renderer with an isolated fake bridge;
// never opens the user's microphone or calls models / online integrations.
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 45000 })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = require('electron')
const qa = path.join(root, 'out', 'qa')
fs.mkdirSync(qa, { recursive: true })
app.setPath('userData', path.join(qa, 'ui-test-profile'))
const preload = path.join(qa, 'ui-test-preload.cjs')
fs.writeFileSync(preload, `
const config = require(${JSON.stringify(path.join(root, 'config.json'))});
localStorage.setItem('nimbus.sounds', 'off');
localStorage.setItem('nimbus.acknowledgments', 'off');
localStorage.removeItem('nimbus.saved-answers.v1');
window.__qa = { events: {}, requests: [], speech: [], errors: [], spoken: 0 };
window.addEventListener('error', event => window.__qa.errors.push(event.message));
window.addEventListener('unhandledrejection', event => window.__qa.errors.push(String(event.reason)));
navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
window.speechSynthesis.speak = () => { window.__qa.spoken++; };
window.nimbus = new Proxy({}, { get: (_, name) => {
 if(name.startsWith('on')) return cb => { window.__qa.events[name] = cb; return () => {}; };
 if(name === 'getConfig') return async () => config;
 if(name === 'getOverlayLayout') return async () => ({corner:null,squeeze:'full'});
 if(name === 'isWakeWordReady') return async () => false;
 if(['getSecrets','getQuotas','listModels'].includes(name)) return async () => [];
 if(name === 'getAiChoice') return async () => ({provider:'local',model:'',lockedByEnv:false});
 if(name === 'getLocalModelStatus') return async () => ({installed:false,sizeBytes:0});
 if(name === 'sendTranscript') return (text, id) => new Promise((resolve,reject) => window.__qa.requests.push({text,id,resolve,reject}));
 if(name === 'synthesizeSpeech') return text => new Promise((resolve,reject) => window.__qa.speech.push({text,resolve,reject}));
 return async () => null;
}});
`)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 720, webPreferences: {
    preload, contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: true
  } })
  win.webContents.on('console-message', event => { if (event.level >= 2) console.log(event.message) })
  const run = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Failed UI assertion:', code); throw error })
  const settle = () => new Promise(resolve => setTimeout(resolve, 160))
  const input = async value => {
    await run(`(() => { const input = document.querySelector('input[aria-label="Message Nimbus"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await settle()
  }
  const submit = async value => {
    await input(value)
    await run(`document.querySelector('input[aria-label="Message Nimbus"]').form.requestSubmit()`)
    await settle()
  }
  const click = async label => {
    await run(`(() => { const button = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent).includes(${JSON.stringify(label)})); if(!button) throw new Error('Missing button: ' + ${JSON.stringify(label)}); button.click(); })()`)
    await settle()
  }
  const screenshot = async name => {
    await new Promise(resolve => setTimeout(resolve, 500))
    fs.writeFileSync(path.join(qa, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await win.loadFile(path.join(root, 'out/renderer/index.html'))
  await settle()
  await run('window.__qa.events.onScreenCaptured(null)')
  await new Promise(resolve => setTimeout(resolve, 600))
  await screenshot('studio')
  const shellWidth = await run(`document.querySelector('.nimbus-presence .nimbus-orb').getBoundingClientRect().width`)
  await run('window.__qa.events.onWake()')
  await settle()
  await screenshot('voice-message')
  assert.equal(await run(`!!document.querySelector('button[aria-label="Send voice message"]') && !!document.querySelector('button[aria-label="Discard voice message"]')`), true, 'voice recording has send and discard controls')
  await click('Discard voice message')
  assert.equal(await run('window.__qa.requests.length'), 0, 'discard does not submit a question')
  await input('/')
  await screenshot('commands')
  assert.equal(await run(`(() => {
    const menu = document.querySelector('.nimbus-command-menu');
    const panel = document.querySelector('.nimbus-glass');
    const label = menu.querySelector('[class*="uppercase"]');
    const probe = document.createElement('span'); probe.style.color = 'var(--color-nimbus-accent-bright)'; panel.append(probe);
    const matches = getComputedStyle(probe).color === getComputedStyle(label).color;
    probe.remove();
    return matches && menu.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom;
  })()`), true, 'palette inherits the active color and fits the panel')
  await input('/weather')
  await run(`document.querySelector('input[aria-label="Message Nimbus"]').form.requestSubmit()`)
  await settle()
  assert.equal(await run('window.__qa.requests.length'), 0, 'picking a command fills a draft without executing it')
  await click('Voice on')
  await click('Answers are spoken')
  await submit('first question')
  await submit('second question')
  await run(`window.__qa.requests[1].resolve({speech:'Latest answer',card:{type:'text'}})`)
  await settle()
  await run(`window.__qa.requests[0].resolve({speech:'Stale answer',card:{type:'text'}})`)
  await settle()
  assert.equal(await run(`document.body.innerText.includes('Latest answer') && !document.body.innerText.includes('Stale answer')`), true, 'old responses cannot replace a newer answer')
  await screenshot('answer')
  assert.equal(await run(`document.querySelector('.nimbus-presence .nimbus-orb').getBoundingClientRect().width`), shellWidth, 'answer presentation preserves the orb size')
  assert.equal(await run(`!!document.querySelector('.nimbus-orb-answer, .nimbus-orb-orbit, [style*="--orb-shock"]')`), false, 'no external orb bursts or shockwaves')
  for (const squeeze of ['compact', 'icon', 'full']) {
    await run(`window.__qa.events.onOverlayLayout({corner:${squeeze === 'full' ? 'null' : "'bottom-right'"},squeeze:${JSON.stringify(squeeze)}})`)
    await settle()
    assert.equal(await run(`(() => {
      const orb = [...document.querySelectorAll('.nimbus-orb')].at(-1);
      return Math.abs(orb.getBoundingClientRect().width - orb.offsetWidth) < .5 && getComputedStyle(orb).overflow === 'hidden';
    })()`), true, 'orb stays contained without scale overshoot in ' + squeeze)
    await settle()
  }
  await click('Answers are silent')
  await submit('third question')
  await run(`window.__qa.requests[2].resolve({speech:'Pending speech',card:{type:'text'}})`)
  await settle()
  await click('Answers are spoken')
  await click('Answers are silent')
  await run(`window.__qa.speech[0].resolve({audio:new ArrayBuffer(0),mimeType:'audio/wav'})`)
  await settle()
  assert.equal(await run('window.__qa.spoken'), 0, 'muting and unmuting cannot resurrect pending TTS')
  await submit('fourth question')
  await click('Stop response')
  await run(`window.__qa.events.onSpeechChunk('Obsolete token', window.__qa.requests[3].id); window.__qa.requests[3].reject(new Error('Obsolete failure'))`)
  await settle()
  assert.equal(await run(`/Obsolete/.test(document.body.innerText)`), false, 'stopped streams and failures stay dismissed')
  // A web answer laid out for the question, rather than three blue links.
  await submit('how much is an rtx 3070')
  await run(`window.__qa.requests.at(-1).resolve({
    speech: 'A used RTX 3070 goes for about 329 euros right now.',
    card: { type: 'facts', data: {
      layout: 'price', title: 'RTX 3070', subtitle: 'Nvidia · used',
      headline: '€329', headlineLabel: 'cheapest used', headlineNote: 'today',
      groups: [
        { title: 'Geizhals', headline: '€329', note: 'geizhals.de', rows: [] },
        { title: 'eBay Kleinanzeigen', headline: '€340', note: 'ebay.de', rows: [] }
      ],
      rows: [
        { label: 'Memory', value: '8 GB GDDR6' },
        { label: 'Released', value: 'October 2020' },
        { label: 'Launch price', value: '€519' }
      ],
      bullets: [],
      answer: 'A used RTX 3070 goes for about 329 euros right now.',
      query: 'rtx 3070 price used',
      sources: [{ title: 'Geizhals price history', url: 'https://geizhals.de/rtx3070', snippet: '' }]
    } }
  })`)
  await settle()
  await screenshot('facts-card')
  assert.equal(await run(`(() => {
    // Lower-cased before matching: row labels are uppercased by the stylesheet,
    // which is a presentation choice and not something to assert against.
    const text = document.body.innerText.toLowerCase();
    return ['rtx 3070', '€329', 'cheapest used', 'geizhals', '€340', 'memory', '8 gb gddr6', 'launch price']
      .every(fragment => text.includes(fragment));
  })()`), true, 'a priced web answer shows its figure, its offers and its specs')

  await click('Save answer')
  await click('Library')
  assert.equal(await run(`document.querySelector('.answer-library').open`), true)
  assert.equal(await run(`document.querySelectorAll('.library-entries article').length`), 1)
  await click('Pin answer')
  assert.equal(await run(`JSON.parse(localStorage.getItem('nimbus.saved-answers.v1'))[0].pinned`), true)
  await screenshot('library')
  await run(`(() => { const field = document.querySelector('input[aria-label="Search saved answers"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'no matching answer'); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await settle()
  assert.equal(await run(`document.querySelectorAll('.library-entries article').length`), 0)
  await run(`(() => { const field = document.querySelector('input[aria-label="Search saved answers"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ''); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await settle()
  await click('Remove')
  assert.equal(await run(`document.querySelectorAll('.library-entries article').length`), 0)
  await click('Undo removal')
  assert.equal(await run(`document.querySelectorAll('.library-entries article').length`), 1)
  await run(`document.querySelector('.answer-library').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); document.querySelector('.answer-library').close()`)
  await settle()
  assert.equal(await run(`!!document.querySelector('.nimbus-presence')`), true, 'closing the library preserves the assistant')
  await click('Settings')
  assert.equal(await run(`document.body.innerText.includes('Signature sounds') && document.body.innerText.includes('Thinking acknowledgment')`), true)
  assert.deepEqual(await run('window.__qa.errors'), [])
  const soundBundle = require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src/renderer/src/lib/sound-design.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'NimbusSoundQA'
  }).outputFiles[0].text
  await win.webContents.executeJavaScript(soundBundle)
  const channels = await run(`(async () => {
    const ctx = new OfflineAudioContext(2, 44100 * 4, 44100);
    ['open','listen','received','interrupt','close'].forEach((cue,i) => NimbusSoundQA.scheduleSound(ctx,cue,.1+i*.75));
    const audio = await ctx.startRendering();
    return [Array.from(audio.getChannelData(0)), Array.from(audio.getChannelData(1))];
  })()`)
  const frames = channels[0].length
  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(176400, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40)
  let peak = 0
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) {
    const sample = channels[channel][frame]
    assert.ok(Number.isFinite(sample))
    peak = Math.max(peak, Math.abs(sample))
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + frame * 4 + channel * 2)
  }
  // Raised deliberately: the cues used to peak around -27dBFS, which is
  // inaudible on speakers or under anything else playing. Still a long way
  // from full scale, and the notes of a cue overlap, so this checks the sum.
  assert.ok(peak > .1, 'sound cues are loud enough to hear on speakers')
  assert.ok(peak < .8, 'sound cues stay clear of clipping')
  fs.writeFileSync(path.join(qa, 'sound-identity.wav'), wav)
  // The rim is what moves now, not the orb. Driven straight through the
  // engine rather than through the app: this needs a known tremor value and a
  // known clock, and going via the component would test the browser's frame
  // scheduling instead of the geometry.
  const orbBundle = require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src/renderer/src/lib/storm-orb.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'NimbusOrbQA'
  }).outputFiles[0].text
  await win.webContents.executeJavaScript(orbBundle)
  const rim = await run(`(() => {
    const canvas = document.createElement('canvas');
    canvas.style.width = '120px'; canvas.style.height = '120px';
    document.body.append(canvas);
    const orb = NimbusOrbQA.createStormOrb(canvas, { fill: .94, bare: true, contained: true });
    orb.resize();
    const palette = NimbusOrbQA.stormPalette(['#101020', '#3355aa', '#88bbff']);
    const context = canvas.getContext('2d');
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const limit = Math.min(cx, cy) - 1;
    // Where the edge is, along each of 72 rays out from the centre. Compared as
    // a whole shape rather than reduced to a roundness number: pixel rounding
    // lands the same way on every reading, so it cancels out of a comparison
    // between two of them, where it would swamp any absolute measure.
    const edge = (now, tremor) => {
      orb.frame({ palette, intensity: .5, charge: 0, release: 0, flash: 0, level: 0, scale: 1, tremor }, 33, now);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const radii = [];
      for (let step = 0; step < 72; step++) {
        const angle = (step / 72) * Math.PI * 2;
        const dx = Math.cos(angle), dy = Math.sin(angle);
        let found = 0;
        for (let r = limit; r >= 0; r -= .25) {
          const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
          // A high threshold on purpose: this finds the solid shell, whose
          // boundary is the clipped rim path itself, rather than the soft glow
          // stroke outside it that would smear the deformation being measured.
          if (pixels[(y * canvas.width + x) * 4 + 3] > 140) { found = r; break; }
        }
        radii.push(found);
      }
      // How hard the orb presses against the edge of its own bitmap.
      let border = 0;
      for (let x = 0; x < canvas.width; x++) {
        border = Math.max(border, pixels[x * 4 + 3], pixels[((canvas.height - 1) * canvas.width + x) * 4 + 3]);
      }
      for (let y = 0; y < canvas.height; y++) {
        border = Math.max(border, pixels[y * canvas.width * 4 + 3], pixels[(y * canvas.width + canvas.width - 1) * 4 + 3]);
      }
      return { shape: radii.join(','), reach: Math.max(...radii), border };
    };
    const clocks = [0, 40, 80, 120, 160, 200, 240, 280];
    const still = clocks.map(now => edge(now, 0));
    const ringing = clocks.map(now => edge(now, 1));
    canvas.remove();
    return { still, ringing };
  })()`)
  const shapes = list => list.map(entry => entry.shape)
  const distinct = new Set(shapes(rim.ringing)).size
  // Not exactly one: lightning striking the inside of the shell can tip the
  // single antialiased pixel at the boundary over the threshold, so a resting
  // orb reads as one or two shapes across eight frames. A ringing one reads as
  // a different shape almost every frame, which is the whole distinction.
  const stillShapes = new Set(shapes(rim.still)).size
  assert.ok(stillShapes <= 2, `a quiet orb's edge stays where it is (${stillShapes} of 8 distinct)`)
  assert.ok(distinct >= 6, `a speaking orb's edge lands somewhere new on nearly every frame (${distinct} of 8 distinct)`)
  assert.ok(
    shapes(rim.ringing).every(shape => shape !== shapes(rim.still)[0]),
    'a speaking orb never sits at the resting edge'
  )
  // A canvas cannot paint outside itself, so a rim that swung wider than the
  // resting one would come back sliced flat down one side. The tremor travels
  // only inward for exactly this reason, and these two hold it to that.
  assert.ok(
    Math.max(...rim.ringing.map(entry => entry.reach)) <= Math.max(...rim.still.map(entry => entry.reach)),
    'the ringing edge stays inside the space the resting one already occupies'
  )
  assert.ok(
    Math.max(...rim.ringing.map(entry => entry.border)) <= Math.max(...rim.still.map(entry => entry.border)),
    'a ringing rim never presses further into the bitmap edge than a resting one'
  )


  console.log('PASS: voice send/discard controls, fixed orb shell, palette color and layout, command drafts, stale answers, TTS mute races, stop response, sound settings')
  console.log('PASS: the rim vibrates on demand and holds still otherwise, without leaving the bitmap')
  console.log('PASS: five sound cues rendered without clipping; preview at out/qa/sound-identity.wav')
  console.log('Screenshots: out/qa/studio.png, commands.png, answer.png, facts-card.png')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
