// Accelerated three-hour dataset in the real compiled Electron UI. This is not
// a real-time audio soak: no devices, real transcripts, or hosted APIs are used.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-long-session-'));
  const now = new Date().toISOString(), id = randomUUID();
  const captions = Array.from({ length: 10800 }, (_, n) => ({ id: `three-hour-${n}`, source: n % 2 ? 'microphone' : 'computer', startMs: n * 1000, endMs: n * 1000 + 500, isFinal: true, text: n === 121 ? 'I designed cobalt-payments with a PostgreSQL transactional outbox and idempotency keys. Atomic event publishing prevented duplicate charges.' : `We discussed feature${Math.floor(n / 60)}, deployment, accessibility, monitoring and component${n % 60}.`, ...(n % 10 === 0 ? { translation: { language: 'es', sourceText: 'Synthetic source speech.', text: 'Traducción de ejemplo.' } } : {}) }));
  const threads = Array.from({ length: 180 }, (_, n) => ({ id: randomUUID(), question: `Technical question ${n + 1}`, captionIds: [], exchanges: [{ id: randomUUID(), question: `Technical question ${n + 1}`, answer: 'A synthetic response about architecture. '.repeat(50), status: 'ready', createdAt: now, context: [], sourceNames: [] }] }));
  fs.mkdirSync(path.join(profile, 'conversations'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', profiles: [], jobs: [] }));
  fs.writeFileSync(path.join(profile, 'scenario.json'), JSON.stringify({ id }));
  fs.writeFileSync(path.join(profile, 'conversations', id + '.json'), JSON.stringify({ version: 1, id, title: 'Three-hour interview', createdAt: now, updatedAt: now, captions, threads, selectedThreadId: threads[179].id, draft: '', pendingContext: [], role: 'Software engineer', interviewType: 'Technical', responseStyle: 'Concise structure' }));
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NANOGPT_API_KEY']) delete env[name];
  for (const phase of ['workload', 'reopen']) {
    const result = require('node:child_process').spawnSync(electron, [__filename, phase, profile], { env, stdio: 'inherit', timeout: 65000 });
    assert.equal(result.status, 0, `${phase} must finish cleanly`);
  }
  const record = JSON.parse(fs.readFileSync(path.join(profile, 'conversations', id + '.json'), 'utf8'));
  assert.equal(record.captions.length, 10800);
  assert.equal(record.threads.length, 182);
  assert.ok(record.threads[180].exchanges[0].memory.relevant.some(item => item.id === 'three-hour-121'));
  console.log(JSON.stringify({ success: true, simulatedMinutes: 180, profile, checks: ['real UI with 10800 caption segments and 180 initial questions', 'old facts retrieved for a new question and follow-up', 'API context bounded and unrelated answers excluded', 'memory inspection and export', 'new conversation has no previous memory', 'restart rebuilds source index and preserves answer evidence', 'compact and narrow layouts', 'no extra summary API requests'], realTimeSoak: false }));
  process.exit(0);
}
const { app, BrowserWindow, globalShortcut, dialog, session } = electron;
const phase = process.argv[2], profile = path.resolve(process.argv[3]);
const meta = JSON.parse(fs.readFileSync(path.join(profile, 'scenario.json'), 'utf8'));
const question = 'For cobalt-payments, why did we need a transactional outbox?';
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let window, complete = false; const calls = [], errors = [], started = performance.now();
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created; window.setPosition(-20000, -20000); window.setFocusable(false); window.show = () => {}; window.showInactive = () => {}; window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
global.fetch = async (url, init) => {
  assert.equal(String(url), 'http://localhost:1234/v1/chat/completions');
  const request = JSON.parse(init.body); calls.push(request);
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Synthetic technical answer ' + calls.length } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
app.whenReady().then(() => {
  session.defaultSession.fetch = async () => { throw new Error('Hosted network disabled in long-interview QA'); };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(profile, 'long-export.md') });
});
app.on('will-quit', () => { assert.equal(complete, true); assert.deepEqual(errors, []); console.log(JSON.stringify({ phase, success: true, requests: calls.length, elapsedMs: Math.round(performance.now() - started) })); });
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let n = 0; n < 600; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    const click = async label => { await js(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing '+${JSON.stringify(label)});button.click()})()`); await sleep(60); };
    const input = async value => { await js(`(()=>{const field=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(60); };
    const ready = () => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`);
    await until(ready, 'history opened');
    assert.equal(await js(`document.querySelector('.composer textarea').value`), '', 'Startup uses a fresh draft');
    assert.equal(await js(`document.querySelectorAll('.caption-line,.question-exchange').length`), 0, 'Large history stays closed at startup');
    await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`);
    await until(() => js(`!!document.querySelector('.library-row')`), 'saved history list');
    await js(`[...document.querySelectorAll('.library-open')].find(b=>b.textContent.includes('Three-hour interview')).click();void 0`);
    await until(ready, 'manually opened three-hour conversation');
    assert.equal(calls.length, 0, 'Opening large history must not call a provider');
    assert.equal(await js(`document.querySelector('.caption-status').textContent`), 'Off');
    if (phase === 'workload') {
      await click('New question'); await input(question); await click('Send question');
      await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Synthetic technical answer 1')`), 'new question answer');
      assert.match(calls[0].messages[1].content, /Atomic event publishing prevented duplicate charges/);
      assert.doesNotMatch(calls[0].messages[1].content, /A synthetic response about architecture/);
      assert.ok(calls[0].messages[1].content.length < 30000, 'Full transcript and unrelated answers must not inflate the request');
      assert.equal(await js(`[...document.querySelectorAll('summary')].some(s=>s.textContent.includes('Earlier speech used'))`), true);
      await click('Caption options');
      await until(() => js(`[...document.querySelectorAll('summary')].some(s=>s.textContent.includes('Conversation summary'))`), 'background summary available');
      await click('Caption options');
      await js(`(()=>{const summary=[...document.querySelectorAll('summary')].find(s=>s.textContent.includes('Earlier speech used'));summary.closest('details').open=true;const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(style)})()`);
      window.setSize(1319, 840); await sleep(180);
      fs.writeFileSync(path.join(profile, 'memory-workspace.png'), (await window.webContents.capturePage()).toPNG());
      await input('How did idempotency help?'); await click('Send question');
      await until(() => js(`document.querySelectorAll('.question-exchange').length===2&&document.querySelector('.question-thread').textContent.includes('Synthetic technical answer 2')`), 'follow-up answer');
      assert.match(calls[1].messages[1].content, /Synthetic technical answer 1/);
      assert.match(calls[1].messages[1].content, /idempotency keys/);
      await click('Export session'); await until(() => fs.existsSync(path.join(profile, 'long-export.md')), 'export');
      assert.match(fs.readFileSync(path.join(profile, 'long-export.md'), 'utf8'), /Relevant earlier speech used/);
      await click('New session'); await input('What did cobalt-payments use?'); await click('Send question');
      await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Synthetic technical answer 3')`), 'separate session answer');
      assert.doesNotMatch(calls[2].messages[1].content, /idempotency keys|Interview summary|Relevant earlier speech/);
      await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`);
      await until(() => js(`!!document.querySelector('.library-row')`), 'history');
      await js(`[...document.querySelectorAll('.library-open')].find(b=>b.textContent.includes('Three-hour interview')).click();void 0`); await until(ready, 'reopened long conversation');
      window.setSize(640, 700); await sleep(100);
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.send-button').getBoundingClientRect().bottom<=innerHeight`), true);
      await click('Compact'); await until(() => js(`!!document.querySelector('.compact-composer')`), 'compact');
      assert.equal(await js(`document.querySelector('.compact-composer button').getBoundingClientRect().bottom<=innerHeight`), true);
      await click('Expand workspace'); await until(ready, 'expanded');
    } else {
      assert.match(await js(`document.querySelector('.question-thread').textContent`), /Synthetic technical answer 2/);
      const record = await js(`window.studio.getHistory(${JSON.stringify(meta.id)})`);
      assert.ok(record.threads[180].exchanges[0].memory.relevant.some(item => item.id === 'three-hour-121'));
      await click('New question'); await input(question); await click('Send question');
      await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Synthetic technical answer 1')`), 'retrieval after restart');
      assert.match(calls[0].messages[1].content, /Atomic event publishing prevented duplicate charges/);
    }
    complete = true; window.close();
  } catch (error) { console.error(error, { phase, errors }); app.exit(1); }
});
setTimeout(() => { console.error('Long-interview QA timed out'); app.exit(1); }, 60000);
