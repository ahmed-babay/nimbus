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
  assert.ok(peak > .005 && peak < .2, 'sound cues render audible, unclipped PCM')
  fs.writeFileSync(path.join(qa, 'sound-identity.wav'), wav)
  console.log('PASS: voice send/discard controls, fixed orb shell, palette color and layout, command drafts, stale answers, TTS mute races, stop response, sound settings')
  console.log('PASS: five sound cues rendered without clipping; preview at out/qa/sound-identity.wav')
  console.log('Screenshots: out/qa/studio.png, commands.png, answer.png')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
