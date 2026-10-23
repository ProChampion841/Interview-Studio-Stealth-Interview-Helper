// Real Electron UI/lifecycle checks. Uses synthetic audio and generated images;
// never records a device, captures the desktop, or calls a hosted provider.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  for (const phase of ['bar-exit', 'workspace-exit', 'native-exit']) {
    const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-floating-bar-'));
    const env = { ...process.env, OPENAI_API_KEY: 'fixture-caption-key' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NANOGPT_API_KEY', 'OPENROUTER_API_KEY']) delete env[key];
    const result = spawnSync(electron, [__filename, phase, profile], { env, stdio: 'inherit', timeout: 60000 });
    assert.equal(result.status, 0, `Electron must exit cleanly in ${phase}`);
    assert.ok(fs.existsSync(path.join(profile, 'quit-complete.json')), `${phase} must reach will-quit`);
  }
  console.log(JSON.stringify({ success: true, checks: ['floating bar instead of minimize', 'always on top', 'drag position retained and onscreen', 'live captions continue', 'answers finish in bar', 'draft and attachment preserved', 'clickable with mouse pass-through enabled', 'compact and maximized restore', 'native minimize recovery', 'close exits from bar/workspace/native frame'] }));
  process.exit(0);
}
const { app, BrowserWindow, ipcMain, session, globalShortcut, screen } = electron;
const phase = process.argv[2], profile = path.resolve(process.argv[3]);
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', captionProvider: 'openai', jobs: [], profiles: [] }));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
const trayDescriptor = Object.getOwnPropertyDescriptor(electron, 'Tray');
if (trayDescriptor?.configurable) Object.defineProperty(electron, 'Tray', { value: class { constructor() { throw new Error('No tray icon may be created'); } } });
let window, completed = false, finishAnswer, ignoredMouse = false, translationCalls = 0;
const errors = [], captionCalls = { computer: 0, microphone: 0 };
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created; window.setPosition(-20000, -20000); window.setFocusable(false);
  window.show = () => {}; window.showInactive = () => {};
  const setIgnore = window.setIgnoreMouseEvents.bind(window);
  window.setIgnoreMouseEvents = (ignore, options) => { ignoredMouse = ignore; setIgnore(ignore, options); };
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
global.fetch = async (url, init) => {
  assert.equal(String(url), 'http://localhost:1234/v1/chat/completions');
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'A useful answer ' } }] }) + '\n\n'));
    finishAnswer = () => { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'finished while minimized.' } }] }) + '\n\ndata: [DONE]\n\n')); controller.close(); };
    init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
  } }), { headers: { 'content-type': 'text/event-stream' } });
};
app.whenReady().then(() => { session.defaultSession.fetch = async () => { throw new Error('Hosted network disabled in window fixture'); }; });
app.on('will-quit', () => {
  assert.equal(completed, true, 'App must finish checks before quitting');
  fs.writeFileSync(path.join(profile, 'quit-complete.json'), JSON.stringify({ phase, completed }));
  console.log(JSON.stringify({ phase, success: true, captionCalls }));
});
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 500; i++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    await until(() => js(`!!document.querySelector('.composer')&&!document.querySelector('.composer textarea').disabled`), 'workspace and history ready');
    const click = async label => { await js(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing button');button.click()})()`); await sleep(40); };
    if (phase !== 'bar-exit') {
      completed = true;
      if (phase === 'native-exit') window.close(); else await click('Close');
      return;
    }
    const input = async text => { await js(`(()=>{const field=document.querySelector('.composer textarea,.compact-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(40); };
    ipcMain.removeHandler('captions:transcribe');
    ipcMain.handle('captions:transcribe', (_event, request) => {
      const n = ++captionCalls[request.source];
      return [{ id: request.source + '-' + n, source: request.source, text: n === 1 ? 'A caption before minimizing.' : 'New speech while the bar is open.', startMs: n * 1000, endMs: n * 1000 + 500, isFinal: true }];
    });
    ipcMain.removeHandler('captions:translate');
    ipcMain.handle('captions:translate', (_event, request) => { translationCalls++; return { text: 'Traducción: ' + request.text }; });
    await js(`(()=>{const fixture=window.barFixture={contexts:[],gains:[],streams:[]};const make=async video=>{const context=new AudioContext({sampleRate:24000});await context.resume();const source=context.createOscillator(),gain=context.createGain(),destination=context.createMediaStreamDestination();gain.gain.value=.2;gain.gain.setValueAtTime(0,context.currentTime+1.5);source.connect(gain).connect(destination);source.start();const stream=destination.stream;if(video){const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;stream.addTrack(canvas.captureStream(1).getVideoTracks()[0])}fixture.contexts.push(context);fixture.gains.push(gain);fixture.streams.push(stream);return stream};navigator.mediaDevices.getUserMedia=()=>make(false);navigator.mediaDevices.getDisplayMedia=()=>make(true)})()`);
    await click('Start captions'); await until(() => captionCalls.computer && captionCalls.microphone, 'captions');
    await click('Translate captions'); await click('Translate to Spanish');
    await until(() => js(`!!document.querySelector('.caption-translated p')`), 'translation');
    await input('Explain the approach'); await click('Send question'); await until(() => !!finishAnswer, 'answer generating');
    await input('Keep this unfinished draft');
    await js(`(()=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0)),data=new DataTransfer();data.items.add(new File([bytes],'pending.png',{type:'image/png'}));document.querySelector('.app').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}))})()`);
    await until(() => js(`document.querySelectorAll('.attachment-item').length===1`), 'attachment');
    await js(`window.studio.setAlwaysOnTop(false)`);
    const workspace = window.getNormalBounds();
    await click('Minimize'); await until(() => js(`!!document.querySelector('.floating-bar')`), 'floating bar');
    assert.equal(window.isMinimized(), false); assert.equal(window.isAlwaysOnTop(), true);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'Same renderer keeps live work mounted');
    assert.equal(await js(`document.querySelector('.floating-bar-status').textContent.includes('Generating answer')`), true);
    const bar = window.getBounds(), work = screen.getDisplayMatching(bar).workArea;
    assert.ok(bar.width <= 480 && bar.height <= 96 && bar.x >= work.x && bar.y >= work.y && bar.x + bar.width <= work.x + work.width && bar.y + bar.height <= work.y + work.height);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight`), true, 'Bar fits without the workspace minimum size');
    assert.equal(await js(`getComputedStyle(document.querySelector('.floating-bar')).webkitAppRegion==='drag'&&[...document.querySelectorAll('.floating-bar button')].every(button=>getComputedStyle(button).webkitAppRegion==='no-drag')`), true, 'Bar is draggable and controls are clickable');
    await js(`window.studio.setStealth({mousePassthrough:true});window.studio.setPassthrough(true);void 0`); await sleep(60);
    assert.equal(ignoredMouse, false, 'Bar controls cannot become click-through');
    await js(`window.barFixture.gains.forEach((gain,i)=>{const context=window.barFixture.contexts[i];gain.gain.setValueAtTime(.2,context.currentTime);gain.gain.setValueAtTime(0,context.currentTime+1.5)})`);
    await until(() => js(`document.querySelector('.floating-bar-preview')?.textContent.includes('bar is open')`), 'new caption in bar');
    await until(() => translationCalls >= 4 && js(`document.querySelector('.floating-bar-preview').textContent.includes('Traducción')`), 'translation continues in bar');
    finishAnswer(); await until(() => js(`document.querySelector('.floating-bar-status').textContent.includes('Answer ready')`), 'answer completes in bar');
    await sleep(180);
    fs.writeFileSync(path.join(profile, 'floating-bar.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(320, 96); await sleep(80);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.floating-bar button')].every(button=>{const rect=button.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight})`), true, 'Bar controls fit a narrow display');
    window.setSize(bar.width, bar.height);
    const dragged = { x: work.x + 25, y: work.y + 35 }; window.setPosition(dragged.x, dragged.y);
    await click('Restore workspace'); await until(() => js(`!!document.querySelector('.composer')`), 'workspace restored');
    assert.deepEqual(window.getNormalBounds(), workspace); assert.equal(window.isAlwaysOnTop(), false);
    assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Keep this unfinished draft');
    assert.equal(await js(`document.querySelectorAll('.attachment-item').length`), 1);
    assert.match(await js(`document.querySelector('.generated-answer').textContent`), /finished while minimized/);
    assert.equal(await js(`document.querySelector('.caption-status').textContent`), 'Listening');
    await js(`window.studio.setStealth({mousePassthrough:false})`);
    await click('Mute microphone');
    await click('Compact'); await until(() => js(`!!document.querySelector('.compact-app')`), 'compact');
    const compact = window.getNormalBounds();
    await click('Minimize'); await until(() => js(`!!document.querySelector('.floating-bar')`), 'compact bar');
    assert.equal(await js(`document.querySelector('.floating-bar-status').textContent.includes('Mic muted')`), true);
    assert.deepEqual(window.getPosition(), [dragged.x, dragged.y], 'Bar remembers dragged position');
    await click('Restore workspace'); await until(() => js(`!!document.querySelector('.compact-app')`), 'compact restored');
    assert.deepEqual(window.getNormalBounds(), compact);
    assert.equal(await js(`document.querySelector('.compact-composer textarea').value`), 'Keep this unfinished draft');
    await click('Expand workspace'); await until(() => js(`!!document.querySelector('.composer')`), 'full layout');
    window.maximize(); window.hide(); await until(() => window.isMaximized(), 'native maximize');
    await click('Minimize'); await until(() => js(`!!document.querySelector('.floating-bar')`), 'maximized bar');
    await click('Restore workspace'); await until(() => window.isMaximized(), 'maximized restored');
    window.unmaximize(); window.hide(); await sleep(80);
    window.minimize(); await until(() => js(`!!document.querySelector('.floating-bar')`), 'native minimize becomes bar');
    assert.equal(window.isMinimized(), false);
    await click('Restore workspace'); await until(() => js(`!!document.querySelector('.composer')`), 'restore after native minimize');
    window.maximize(); window.hide(); await until(() => window.isMaximized(), 'maximize before native minimize');
    window.minimize(); await until(() => js(`!!document.querySelector('.floating-bar')`), 'native minimize from maximized');
    await click('Restore workspace'); await until(() => window.isMaximized(), 'native minimized maximized state restored');
    window.unmaximize(); window.hide(); await sleep(60);
    await js(`window.studio.setAlwaysOnTop(true)`); await click('Minimize');
    await until(() => js(`!!document.querySelector('.floating-bar')`), 'bar exit');
    assert.deepEqual(errors, []);
    completed = true; await click('Exit Interview Studio');
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout(() => { console.error('Floating bar fixture timed out'); app.exit(1); }, 55000);
