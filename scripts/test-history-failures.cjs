// Adversarial QA for the compiled desktop app using isolated, disposable data.
// Provider calls are synthetic; no recording devices or real accounts are used.
const electron = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-history-faults-'));
  const id = randomUUID(), broken = randomUUID();
  fs.mkdirSync(path.join(profile, 'conversations'));
  fs.writeFileSync(path.join(profile, 'conversations', broken + '.json'), '{broken-fixture');
  fs.writeFileSync(path.join(profile, 'conversations', id + '.json'), JSON.stringify({ version: 1, id, title: 'Recovery fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), captions: [], threads: [], selectedThreadId: null, draft: 'Saved draft fixture', pendingContext: [], role: 'Engineer', interviewType: 'Technical', responseStyle: 'Concise structure' }));
  fs.writeFileSync(path.join(profile, 'scenario.json'), JSON.stringify({ id, broken }));
  const settings = JSON.stringify({ provider: 'lmstudio', captionProvider: 'openai', profiles: [], jobs: [] });
  fs.writeFileSync(path.join(profile, 'settings.json'), settings);
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NANOGPT_API_KEY']) delete env[name];
  for (const phase of ['failures', 'stream', 'stress', 'clear', 'verify-clear']) {
    if (phase === 'stress') {
      const stressId = randomUUID(), now = new Date().toISOString();
      const threads = Array.from({ length: 80 }, (_, n) => ({ id: randomUUID(), question: `Question ${n + 1}: ` + 'Long question 한국어 العربية '.repeat(7), captionIds: [], exchanges: [{ id: randomUUID(), question: 'Saved question', answer: `Answer ${n + 1}: 한국어 العربية <img src=x onerror="window.qaInjected=true">`, status: 'ready', context: [], sourceNames: [], createdAt: now }] }));
      const title = 'Long conversation 한국어 العربية ' + 'x'.repeat(70);
      fs.writeFileSync(path.join(profile, 'conversations', stressId + '.json'), JSON.stringify({ version: 1, id: stressId, title, createdAt: now, updatedAt: now, captions: Array.from({ length: 220 }, (_, n) => ({ id: 'stress-' + n, source: n % 2 ? 'microphone' : 'computer', text: `Passage ${n}: <script>window.qaInjected=true</script> 한국어 العربية`, startMs: n * 1000, endMs: n * 1000 + 500, isFinal: true })), threads, selectedThreadId: threads[79].id, draft: '', pendingContext: [], role: 'Engineer', interviewType: 'Technical', responseStyle: 'Concise structure' }));
      fs.writeFileSync(path.join(profile, 'stress.json'), JSON.stringify({ id: stressId, title, question: threads[0].question }));
    }
    const result = require('node:child_process').spawnSync(electron, [__filename, phase, profile], { env, stdio: 'inherit', timeout: 65000 });
    assert.equal(result.status, 0, phase + ' must complete cleanly');
  }
  assert.equal(fs.readFileSync(path.join(profile, 'conversations', broken + '.json'), 'utf8'), '{broken-fixture');
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'conversations', id + '.json'), 'utf8'));
  assert.equal(saved.threads[0].exchanges[0].status, 'stopped');
  assert.match(saved.threads[0].exchanges[0].answer, /Partial answer/);
  assert.equal(saved.threads[2].exchanges[0].status, 'error');
  assert.match(saved.threads[2].exchanges[0].answer, /Useful text before the provider disconnected/);
  const cleared = JSON.parse(fs.readFileSync(path.join(profile, 'cleared.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'conversations', cleared.id + '.json'), 'utf8')).draft, '');
  console.log(JSON.stringify({ success: true, profile, checks: ['startup read failure and retry', 'corrupt files preserved and reported', 'disk full preserves previous file and draft', 'failed save blocks close', 'export while disk save fails', 'retry saves newest text', 'failed delete preserves file and resumes autosave', 'switch questions during streaming', 'cancellation preserves partial answers', 'provider disconnect preserves partial answers across restart', 'provider errors remain attached to their question', 'empty draft stays empty after restart', '220 caption turns and 80 saved questions', 'Unicode and escaped markup', 'large question menu fits narrow window', 'highlighted caption becomes exact question', 'narrow history controls', 'hosted APIs and devices unused'] }));
  process.exit(0);
}
const { app, BrowserWindow, globalShortcut, ipcMain, session, dialog } = electron;
const phase = process.argv[2], profile = path.resolve(process.argv[3]);
const meta = JSON.parse(fs.readFileSync(path.join(profile, 'scenario.json'), 'utf8'));
const file = path.join(profile, 'conversations', meta.id + '.json');
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let window, completed = false, denyWrite = false, denyDelete = false, firstRead = phase === 'failures';
let answerController; const requests = [], rendererErrors = [];
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => register(channel, (...args) => {
  if (channel === 'history:list' && firstRead) { firstRead = false; throw new Error('Synthetic startup read failure'); }
  return callback(...args);
});
const rename = fsp.rename.bind(fsp), unlink = fsp.unlink.bind(fsp);
fsp.rename = async (source, target) => {
  if (denyWrite && path.dirname(target) === path.join(profile, 'conversations')) throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
  return rename(source, target);
};
fsp.unlink = async target => {
  if (denyDelete && String(target) === file) throw Object.assign(new Error('Synthetic delete permission failure'), { code: 'EACCES' });
  return unlink(target);
};
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created; window.setPosition(-20000, -20000); window.setFocusable(false);
  window.show = () => {}; window.showInactive = () => {}; window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
});
global.fetch = async (url, init) => {
  assert.equal(String(url), 'http://localhost:1234/v1/chat/completions');
  const body = JSON.parse(init.body); requests.push(body);
  if (requests.length === 2) return new Response('Synthetic provider unavailable', { status: 503 });
  return new Response(new ReadableStream({ start(controller) {
    answerController = controller;
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: requests.length === 3 ? 'Useful text before the provider disconnected.' : 'Partial answer belongs to question one.' } }] }) + '\n\n'));
    init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
  } }), { headers: { 'content-type': 'text/event-stream' } });
};
app.whenReady().then(() => {
  session.defaultSession.fetch = async () => { throw new Error('Hosted APIs disabled for QA'); };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(profile, 'recovery-export.md') });
});
app.on('will-quit', () => { assert.equal(completed, true, 'Failed saves must block premature exit'); assert.deepEqual(rendererErrors, []); console.log(JSON.stringify({ phase, success: true, requests: requests.length })); });
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let n = 0; n < 600; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    const click = async label => { await js(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing '+${JSON.stringify(label)});button.click()})()`); await sleep(60); };
    const input = async value => { await js(`(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(60); };
    const ready = () => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`);
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const historyPage = async () => { await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`); await until(() => js(`!!document.querySelector('.library-row')`), 'history'); };
    const openSaved = async id => {
      const saved = await js(`window.studio.getHistory(${JSON.stringify(id)})`);
      await historyPage();
      await js(`[...document.querySelectorAll('.library-open')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(saved.title)}).click();void 0`);
      await until(ready, 'manually opened saved conversation');
    };
    if (phase === 'failures') {
      await until(() => js(`document.querySelector('.history-error')?.textContent.includes('could not be opened')`), 'load failure notice');
      assert.equal(await ready(), false, 'A failed load must not overwrite saved history');
      await click('Retry saving'); await until(ready, 'startup retry');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), '', 'Retry keeps the new session blank');
      await openSaved(meta.id);
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Saved draft fixture');
      await sleep(1300);
      assert.match(await js(`document.querySelector('.history-error')?.textContent||''`), /1 conversation file/, 'A successful autosave must not hide the unreadable-file warning');
      const previous = fs.readFileSync(file, 'utf8'); denyWrite = true;
      await input('Unsaved text retained during disk full');
      await until(() => js(`document.querySelector('.history-error')?.textContent.includes('could not be saved')`), 'write failure notice');
      assert.equal(fs.readFileSync(file, 'utf8'), previous, 'Failed atomic replacement must keep the previous file');
      assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')), false);
      window.close(); await sleep(500); assert.equal(window.isDestroyed(), false, 'Close pauses when saving fails');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Unsaved text retained during disk full');
      await click('Export'); await until(() => fs.existsSync(path.join(profile, 'recovery-export.md')), 'recovery export');
      assert.match(fs.readFileSync(path.join(profile, 'recovery-export.md'), 'utf8'), /Unsaved text retained during disk full/);
      denyWrite = false; await click('Retry saving'); await until(() => read().draft === 'Unsaved text retained during disk full', 'save retry');
      await historyPage(); denyDelete = true;
      await click('Delete Recovery fixture'); await click('Confirm deleting Recovery fixture');
      await until(() => js(`document.querySelector('.toast')?.textContent.includes('Could not delete')`), 'delete failure notice');
      assert.equal(fs.existsSync(file), true); denyDelete = false;
      window.setSize(640, 560); await sleep(150);
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.library-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`), true, 'Narrow history retains all controls');
      await click('Interview chat'); await input('Text after a failed delete');
      await until(() => read().draft === 'Text after a failed delete', 'autosave resumes after failed delete');
    } else {
      await until(ready, 'history loaded');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), '', 'Each launch starts a fresh draft');
      assert.equal(await js(`document.querySelectorAll('.caption-line,.question-exchange').length`), 0, 'Previous conversation stays in history');
      const reopenId = phase === 'stress' ? JSON.parse(fs.readFileSync(path.join(profile, 'stress.json'), 'utf8')).id : phase === 'verify-clear' ? JSON.parse(fs.readFileSync(path.join(profile, 'cleared.json'), 'utf8')).id : meta.id;
      await openSaved(reopenId);
      if (phase === 'stream') {
        assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Text after a failed delete');
        await input('Question one'); await click('Send question');
        await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Partial answer')`), 'streaming partial answer');
        await click('New question'); await input('Unsent question two');
        assert.equal(requests.length, 1);
        answerController.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: ' Extra text after deselection.' } }] }) + '\n\n'));
        await click('Stop answer'); await click('Choose a saved question'); await click('1. Question one');
        assert.match(await js(`document.querySelector('.question-thread').textContent`), /Extra text after deselection/);
        assert.match(await js(`document.querySelector('.answer-label').textContent`), /partial answer/);
        assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Unsent question two');
        await click('New question'); await input('Question two provider error'); await click('Send question');
        await until(() => js(`document.querySelector('.generated-answer.error')`), 'provider error displayed');
        assert.equal(requests.length, 2);
        await click('Choose a saved question'); await click('1. Question one');
        assert.match(await js(`document.querySelector('.question-thread').textContent`), /Partial answer/);
        assert.doesNotMatch(await js(`document.querySelector('.question-thread').textContent`), /provider unavailable/);
        await click('New question'); await input('Question three interrupted provider'); await click('Send question');
        await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Useful text before')`), 'partial before disconnect');
        answerController.error(new Error('Synthetic provider disconnect'));
        await until(() => js(`!!document.querySelector('.generated-answer.error')`), 'streaming error notice');
        assert.match(await js(`document.querySelector('.generated-answer.error').textContent`), /Useful text before the provider disconnected/, 'A network error must retain the partial answer');
        await click('Choose a saved question'); await click('1. Question one');
      } else if (phase === 'stress') {
        const stress = JSON.parse(fs.readFileSync(path.join(profile, 'stress.json'), 'utf8'));
        assert.equal(await js(`document.querySelectorAll('.caption-line').length`), 200);
        await click('Show earlier captions');
        assert.equal(await js(`document.querySelectorAll('.caption-line').length`), 220);
        assert.equal(await js(`!!window.qaInjected||!!document.querySelector('.question-thread img,.caption-lines script')`), false, 'Saved text cannot execute markup');
        window.setSize(640, 700); await sleep(150);
        await click('Choose a saved question');
        assert.equal(await js(`(()=>{const menu=document.querySelector('[role="group"][aria-label="Choose a saved question"]'),r=menu.getBoundingClientRect();return menu.querySelectorAll('button').length===80&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&menu.scrollHeight>menu.clientHeight})()`), true, 'Large question menu stays within the narrow window and scrolls');
        await click('1. ' + stress.question.trim());
        assert.match(await js(`document.querySelector('.question-thread').textContent`), /Answer 1:/);
        assert.equal(requests.length, 0, 'Large saved histories do not make model requests');
        await js(`(()=>{const paragraph=document.querySelector('[data-caption-article="stress-0"] [data-caption-selectable]'),node=paragraph.querySelector('[data-caption-part]').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,'Passage 0'.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()`);
        await until(() => js(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Draft selection')`), 'highlighted caption action');
        await click('Draft selection');
        await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Partial answer')`), 'answer to exact selection');
        assert.equal(await js(`document.querySelector('.prompt-card p').textContent`), 'Passage 0', 'Only the highlighted words become the question');
        assert.equal(requests.length, 1); await click('Stop');
        await historyPage(); await click('Delete ' + stress.title); await click('Confirm deleting ' + stress.title);
        await until(() => !fs.existsSync(path.join(profile, 'conversations', stress.id + '.json')), 'delete stress conversation');
        await js(`document.querySelector('.library-open').click();void 0`); await until(ready, 'reopen recovery conversation');
      } else if (phase === 'clear') {
        assert.match(await js(`document.querySelector('.answer-label').textContent`), /partial answer/);
        await click('New session'); await input('Erase this draft');
        await until(async () => (await js(`window.studio.listHistory()`)).conversations.length === 2, 'draft autosave');
        const current = (await js(`window.studio.listHistory()`)).conversations.find(item => item.id !== meta.id);
        fs.writeFileSync(path.join(profile, 'cleared.json'), JSON.stringify({ id: current.id }));
        await input('');
        // Close immediately: the final empty revision must reach disk.
      } else {
        assert.equal(await js(`document.querySelector('.composer textarea').value`), '', 'An erased draft must remain erased after restart');
        assert.equal(await js(`document.querySelectorAll('.question-exchange').length`), 0);
        assert.equal(requests.length, 0, 'Restoring history never starts a model');
      }
    }
    completed = true; window.close();
  } catch (error) {
    console.error(error);
    console.error({ phase, rendererErrors });
    if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(`({notice:document.querySelector('.history-error')?.textContent,toast:document.querySelector('.toast')?.textContent})`));
    app.exit(1);
  }
});
setTimeout(() => { console.error('History failure QA timed out'); app.exit(1); }, 60000);
