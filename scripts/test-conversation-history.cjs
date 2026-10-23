// End-to-end persistence across independent Electron processes. Local fixtures
// only: synthetic audio, fake captions/translations, mocked chat and clipboard.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-history-ui-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', captionProvider: 'openai', profiles: [], jobs: [] }));
  fs.mkdirSync(path.join(profile, 'caption-models')); fs.writeFileSync(path.join(profile, 'caption-models', 'keep.bin'), 'model-sentinel');
  const env = { ...process.env, OPENAI_API_KEY: 'fixture-caption-key' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NANOGPT_API_KEY', 'OPENROUTER_API_KEY']) delete env[key];
  for (const phase of ['create', 'reopen', 'delete', 'empty']) {
    const result = spawnSync(electron, [__filename, phase, profile], { env, stdio: 'inherit', timeout: 65000 });
    assert.equal(result.status, 0, `${phase} must close cleanly`);
    assert.ok(fs.existsSync(path.join(profile, phase + '-quit.json')));
    if (phase === 'create') {
      const meta = JSON.parse(fs.readFileSync(path.join(profile, 'scenario.json'), 'utf8'));
      const record = JSON.parse(fs.readFileSync(path.join(profile, 'conversations', meta.id + '.json'), 'utf8'));
      assert.equal(record.draft, 'Last instant draft saved on close');
      assert.equal(record.threads.length, 2); assert.equal(record.threads[0].exchanges.length, 2);
      assert.equal(record.captions.length, 3); assert.ok(record.captions.every(line => line.translation?.language === 'es'));
    }
  }
  assert.equal(fs.readFileSync(path.join(profile, 'caption-models', 'keep.bin'), 'utf8'), 'model-sentinel');
  assert.equal(fs.readdirSync(path.join(profile, 'conversations')).filter(name => name.endsWith('.json')).length, 0);
  console.log(JSON.stringify({ success: true, checks: ['autosave and immediate-close flush', 'restart restores captions translations draft and question threads', 'selected question reuses saved answers', 'follow-ups use only their own answer thread', 'restart capture IDs do not overwrite old speech', 'full-text search', 'rename survives restart', 'export all questions and original/translated captions', 'delete stays deleted after restart', 'no recording devices or hosted APIs'] }));
  process.exit(0);
}
const { app, BrowserWindow, globalShortcut, ipcMain, session, dialog, clipboard } = electron;
const phase = process.argv[2], profile = path.resolve(process.argv[3]);
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let window, completed = false, delivered = false; const calls = [], copied = [], errors = [];
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created; window.setPosition(-20000, -20000); window.setFocusable(false);
  window.show = () => {}; window.showInactive = () => {}; window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
global.fetch = async (url, init) => {
  assert.equal(String(url), 'http://localhost:1234/v1/chat/completions');
  const body = JSON.parse(init.body); calls.push(body);
  const answer = phase === 'reopen' ? 'SECOND-CONVERSATION-ANSWER' : calls.length === 1 ? 'QUEUE-ANSWER-ONE: buffers traffic.' : calls.length === 2 ? 'TRADEOFF-ANSWER-TWO: adds latency.' : 'FOLLOWUP-ANSWER-THREE: retries recover failures.';
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
app.whenReady().then(() => {
  session.defaultSession.fetch = async () => { throw new Error('Hosted APIs disabled in history fixture'); };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(profile, 'export.md') });
  clipboard.writeText = text => copied.push(text);
});
app.on('will-quit', () => {
  assert.equal(completed, true); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(profile, phase + '-quit.json'), JSON.stringify({ phase, completed }));
  console.log(JSON.stringify({ phase, success: true, requests: calls.length }));
});
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let n = 0; n < 600; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    await until(() => js(`!!document.querySelector('.composer')&&!document.querySelector('.history-save-status')?.textContent.includes('Opening')`), 'history ready');
    const click = async (label, scope = 'body') => { await js(`(()=>{const root=document.querySelector(${JSON.stringify(scope)}),button=[...root.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing '+${JSON.stringify(label)});button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));button.click()})()`); await sleep(50); };
    const field = async (selector, value) => { await js(`(()=>{const field=document.querySelector(${JSON.stringify(selector)}),proto=field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(40); };
    const input = value => field('.composer textarea', value);
    const list = () => js(`window.studio.listHistory()`);
    const historyPage = async () => { await js(`[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`); await until(() => js(`!!document.querySelector('.library-page')`), 'history page'); };
    const selectQuestion = async text => { await click('Choose a saved question'); await click(text); };
    const installMedia = async () => {
      await js(`(()=>{const fixture=window.historyFixture={contexts:[]};const make=async video=>{const context=new AudioContext({sampleRate:24000});await context.resume();const source=context.createOscillator(),gain=context.createGain(),destination=context.createMediaStreamDestination();gain.gain.value=.2;gain.gain.setValueAtTime(0,context.currentTime+1.4);source.connect(gain).connect(destination);source.start();const stream=destination.stream;if(video){const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;stream.addTrack(canvas.captureStream(1).getVideoTracks()[0])}fixture.contexts.push(context);return stream};navigator.mediaDevices.getUserMedia=()=>make(false);navigator.mediaDevices.getDisplayMedia=()=>make(true)})()`);
      ipcMain.removeHandler('captions:transcribe'); ipcMain.handle('captions:transcribe', () => {
        if (delivered) return []; delivered = true;
        const lines = phase === 'create' ? [['q1', 'computer', 'Describe the queue design.'], ['me', 'microphone', 'I handled bursts with a message queue.'], ['q2', 'computer', 'What are the tradeoffs?']] : [['q1', 'computer', 'New question after reopening.']];
        return lines.map(([id, source, text], index) => ({ id, source, text, startMs: index * 1000, endMs: index * 1000 + 500, isFinal: true }));
      });
      ipcMain.removeHandler('captions:translate'); ipcMain.handle('captions:translate', (_event, request) => ({ text: 'ES-history: ' + request.text }));
    };
    if (phase === 'create') {
      await installMedia(); await click('Start captions'); await until(() => js(`document.querySelectorAll('.caption-line').length===3`), 'caption turns'); await click('Pause');
      await click('Translate captions'); await click('Translate to Spanish'); await until(() => js(`document.querySelectorAll('.caption-translated p').length===3`), 'saved translations');
      await click('Draft answer', '[data-caption-article$=":q1"]'); await until(() => js(`document.querySelector('.generated-answer')?.textContent.includes('QUEUE-ANSWER-ONE')`), 'first answer');
      await click('Draft answer', '[data-caption-article$=":q2"]'); await until(() => js(`document.querySelector('.generated-answer')?.textContent.includes('TRADEOFF-ANSWER-TWO')`), 'second question');
      await click('View answers', '[data-caption-article$=":q1"]'); await until(() => js(`document.querySelector('.generated-answer')?.textContent.includes('QUEUE-ANSWER-ONE')`), 'saved first answer'); assert.equal(calls.length, 2);
      await click('Copy response'); assert.equal(copied.at(-1), 'QUEUE-ANSWER-ONE: buffers traffic.');
      await input('Explain failure recovery.'); await click('Send question'); await until(() => js(`document.querySelectorAll('.question-exchange').length===2&&document.querySelector('.question-thread').textContent.includes('FOLLOWUP-ANSWER-THREE')`), 'follow-up');
      const prompt = calls[2].messages[1].content;
      assert.match(prompt, /QUEUE-ANSWER-ONE/); assert.doesNotMatch(prompt, /TRADEOFF-ANSWER-TWO/);
      await selectQuestion('2. What are the tradeoffs?'); assert.equal(await js(`document.querySelectorAll('.question-exchange').length`), 1); assert.equal(calls.length, 3);
      await selectQuestion('1. Describe the queue design.');
      await input('Preserve this unsent question'); await click('New question');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Preserve this unsent question');
      assert.equal(calls.length, 3, 'New question must not send or remove saved answers');
      await selectQuestion('1. Describe the queue design.');
      // The fixture lives offscreen; remove animation to capture its final state
      // and resize once to request a fresh compositor frame.
      await js(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(style)})()`);
      const size = window.getSize(); window.setSize(size[0] - 1, size[1]); await sleep(150);
      fs.writeFileSync(path.join(profile, 'workspace.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(640, 700); await sleep(200);
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.send-button').getBoundingClientRect().bottom<=innerHeight`), true, 'Narrow workspace keeps send visible');
      fs.writeFileSync(path.join(profile, 'narrow.png'), (await window.webContents.capturePage()).toPNG());
      await click('Compact'); await until(() => js(`!!document.querySelector('.compact-composer')`), 'compact question history');
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.compact-composer button').getBoundingClientRect().bottom<=innerHeight`), true, 'Compact question history keeps composer visible');
      await sleep(500); window.webContents.invalidate(); await sleep(100);
      fs.writeFileSync(path.join(profile, 'compact.png'), (await window.webContents.capturePage()).toPNG());
      await click('Expand workspace'); await until(() => js(`!!document.querySelector('.composer')`), 'expanded history');
      await until(async () => (await list()).conversations[0]?.answerCount===3, 'autosaved all answers');
      const meta = (await list()).conversations[0]; fs.writeFileSync(path.join(profile, 'scenario.json'), JSON.stringify({ id: meta.id, originalTitle: meta.title }));
      await input('Last instant draft saved on close');
      // No explicit save: the real close handshake must persist the newest edit.
      completed = true; window.close(); return;
    }
    const meta = JSON.parse(fs.readFileSync(path.join(profile, 'scenario.json'), 'utf8'));
    if (phase === 'reopen') {
      const savedFile = path.join(profile, 'conversations', meta.id + '.json');
      const savedBefore = fs.readFileSync(savedFile, 'utf8');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), '', 'Restart starts a new draft');
      assert.equal(await js(`document.querySelectorAll('.caption-line,.question-exchange').length`), 0, 'Previous captions and answers do not open automatically');
      await sleep(1200);
      assert.equal(fs.readFileSync(savedFile, 'utf8'), savedBefore, 'Fresh startup must not change the previous conversation');
      assert.equal((await list()).conversations.length, 1, 'A blank startup must not create an empty history entry');
      await historyPage();
      await js(`[...document.querySelectorAll('.library-open')].find(button=>button.querySelector('strong')?.textContent===${JSON.stringify(meta.originalTitle)}).click();void 0`);
      await until(() => js(`!!document.querySelector('.question-thread')`), 'manually reopened saved conversation');
      assert.equal(calls.length, 0, 'Opening saved text must not contact a model');
      assert.equal(await js(`document.querySelector('.caption-status').textContent`), 'Off');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Last instant draft saved on close');
      assert.equal(await js(`document.querySelectorAll('.question-exchange').length`), 2);
      assert.match(await js(`document.querySelector('.question-thread').textContent`), /FOLLOWUP-ANSWER-THREE/);
      await click('Translate captions'); await click('Translate to Spanish');
      assert.equal(await js(`document.querySelectorAll('.caption-translated p').length`), 3, 'Saved translations can be viewed with capture off');
      await installMedia(); await click('Start captions'); await until(() => js(`document.querySelector('.caption-lines').textContent.includes('New question after reopening')`), 'continued capture'); await click('Stop');
      await until(async () => (await js(`window.studio.getHistory(${JSON.stringify(meta.id)})`)).captions.length===4, 'continued history saved');
      const continued = await js(`window.studio.getHistory(${JSON.stringify(meta.id)})`);
      assert.equal(continued.captions.filter(line => line.id.endsWith(':q1')).length, 2, 'Reused recognizer IDs must not overwrite old speech');
      assert.ok(continued.captions.some(line => line.id===continued.threads[0].captionIds[0]), 'Saved question link still resolves');
      await click('New session'); await input('What about testing?'); await click('Send question'); await until(() => js(`document.querySelector('.generated-answer')?.textContent.includes('SECOND-CONVERSATION-ANSWER')`), 'second conversation');
      await historyPage(); await until(() => js(`document.querySelectorAll('.library-row').length===2`), 'both conversations');
      for (const query of ['New question after reopening', 'SECOND-CONVERSATION-ANSWER', 'ES-history']) {
        await field('[aria-label="Search sessions"]', query); await until(() => js(`document.querySelectorAll('.library-row').length===1`), 'full-text search ' + query);
      }
      await field('[aria-label="Search sessions"]', ''); await until(() => js(`document.querySelectorAll('.library-row').length===2`), 'search reset');
      await click('Rename ' + meta.originalTitle); await field('[aria-label="Rename session"]', 'Saved interview practice');
      await js(`document.querySelector('[aria-label="Rename session"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));void 0`);
      await until(() => js(`document.querySelector('.library-table').textContent.includes('Saved interview practice')`), 'rename');
      await click('Export Saved interview practice'); await until(() => fs.existsSync(path.join(profile, 'export.md')), 'export');
      const exported = fs.readFileSync(path.join(profile, 'export.md'), 'utf8');
      for (const text of ['QUEUE-ANSWER-ONE', 'TRADEOFF-ANSWER-TWO', 'FOLLOWUP-ANSWER-THREE', 'New question after reopening', 'ES-history']) assert.ok(exported.includes(text));
      const longExport = 'Long conversation\n' + 'a'.repeat(1_010_000) + '\nFINAL-PASSAGE';
      await js(`window.studio.exportSession({content:${JSON.stringify(longExport)},suggestedName:'long.md'})`);
      assert.equal(fs.readFileSync(path.join(profile, 'export.md'), 'utf8').trimEnd(), longExport, 'Long exports must not be silently truncated');
      await click('Delete What about testing?'); await click('Confirm deleting What about testing?');
      await until(async () => (await list()).conversations.length===1, 'delete second conversation');
      window.setSize(640, 560); await click('Interview chat'); await sleep(150);
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true);
      completed = true; await click('Close'); return;
    }
    if (phase === 'delete') {
      assert.equal((await list()).conversations.length, 1);
      assert.equal((await list()).conversations[0].title, 'Saved interview practice');
      await historyPage(); await click('Delete Saved interview practice'); await click('Confirm deleting Saved interview practice');
      await until(async () => (await list()).conversations.length===0, 'delete remaining conversation');
    } else {
      assert.equal((await list()).conversations.length, 0, 'Deleted conversations must not be recreated by pending autosaves');
      assert.equal(await js(`document.querySelectorAll('.caption-line').length`), 0);
      assert.equal(await js(`document.querySelectorAll('.question-exchange').length`), 0);
    }
    completed = true; await click('Close');
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(`({history:document.querySelector('.history-save-status')?.textContent,error:document.querySelector('.history-error')?.textContent,toast:document.querySelector('.toast')?.textContent})`));
    app.exit(1);
  }
});
setTimeout(() => { console.error('History fixture timed out'); app.exit(1); }, 60000);
