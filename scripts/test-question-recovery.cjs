// Real renderer/IPC QA with saved caption selections and synthetic AI failures.
// Uses isolated app data; never records audio or calls a hosted provider.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-question-recovery-'));
  const id = randomUUID(), now = new Date().toISOString();
  fs.mkdirSync(path.join(profile, 'conversations'));
  const captions = [
    ['computer', 'What are queues? Explain backpressure.'],
    ['microphone', 'I build distributed services.'],
    ['computer', 'Describe caching. Explain retries. Restore this question.']
  ].map(([source, text], n) => ({ id: 'speech-' + n, source, text, startMs: n * 1000, endMs: n * 1000 + 500, isFinal: true }));
  fs.writeFileSync(path.join(profile, 'conversations', id + '.json'), JSON.stringify({ version: 1, id, title: 'Question recovery fixture', createdAt: now, updatedAt: now, captions, threads: [], selectedThreadId: null, draft: 'Unsent draft kept', pendingContext: [], role: 'Engineer', interviewType: 'Technical', responseStyle: 'Socratic hints' }));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', profiles: [], jobs: [] }));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'NANOGPT_API_KEY', 'OPENROUTER_API_KEY', 'LMSTUDIO_MODEL']) delete env[key];
  for (const phase of ['exercise', 'reopen']) {
    const result = require('node:child_process').spawnSync(electron, [__filename, phase, profile, id], { env, stdio: 'inherit', timeout: 65000 });
    assert.equal(result.status, 0, phase + ' must close cleanly');
  }
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'conversations', id + '.json'), 'utf8'));
  assert.equal(saved.threads.length, 5, 'Retries must not create duplicate question threads');
  assert.equal(saved.responseStyle, 'Simple & professional', 'Old hint styles migrate to spoken answers on reopen');
  assert.equal(saved.threads[0].exchanges.length, 2, 'A follow-up stays in its own thread');
  assert.ok(saved.threads.every(thread => thread.exchanges.every(exchange => exchange.status === 'ready' && !exchange.error)));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-ERROR|Response interrupted/);
  console.log(JSON.stringify({ success: true, profile, checks: ['same selection after repeated HTTP failures', 'different selection after error', 'retry after partial streaming failure', 'copy excludes error notice', 'duplicate-click prevention', 'composer preservation', 'successful caption opens saved answer', 'follow-up retry context', 'cancellation and retry', 'screenshots reused for immediate retry', 'compact recovery controls', 'retry from saved captions after restart', 'no hosted APIs or devices'] }));
  process.exit(0);
}
const { app, globalShortcut, session, clipboard } = electron;
const phase = process.argv[2], profile = path.resolve(process.argv[3]), id = process.argv[4];
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let window, completed = false, partialController;
const calls = new Map(), rendererErrors = [], copied = [];
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created; window.setPosition(-20000, -20000); window.setFocusable(false);
  window.show = () => {}; window.showInactive = () => {}; window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
});
const sse = text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
global.fetch = async (url, init) => {
  assert.equal(String(url), 'http://localhost:1234/v1/chat/completions');
  const body = JSON.parse(init.body), content = body.messages[1].content;
  assert.match(body.messages[0].content, /Write only the words the user can speak directly/);
  assert.match(body.messages[0].content, /Return plain text only/);
  assert.doesNotMatch(body.messages[0].content, /Prefer short Socratic|then add a short list/);
  const text = typeof content === 'string' ? content : content[0].text;
  assert.match(text, /Response style: Simple & professional/);
  const question = text.split('User request:\n')[1].split('\n\n')[0];
  const attempts = calls.get(question) || []; attempts.push(body); calls.set(question, attempts);
  const attempt = attempts.length;
  const failure = status => Response.json({ error: { code: status, message: 'PRIVATE-ERROR fixture provider failure' } }, { status });
  if (phase === 'exercise') {
    if (question === 'What are queues?' && attempt <= 2) return failure(attempt === 1 ? 402 : 503);
    if (question === 'What are queues?' && attempt === 3) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse('Useful partial answer.')));
      setTimeout(() => controller.error(new Error('Synthetic stream disconnect')), 100);
    } }));
    if (question === 'Explain tradeoffs.' && attempt === 1) return failure(429);
    if (question === 'Screenshot question.' && attempt === 1) return failure(503);
    if (question === 'Restore this question.') return failure(503);
    if (question === 'Explain retries.' && attempt === 1) return new Response(new ReadableStream({ start(controller) {
      partialController = controller;
      controller.enqueue(new TextEncoder().encode(sse('Stopped partial answer.')));
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
    } }));
  }
  if (question === 'Screenshot question.') assert.deepEqual(body.messages, attempts[0].messages, 'Retry preserves the exact original images and context');
  if (question === 'Explain tradeoffs.') {
    assert.match(text, /Recovered queue answer/);
    assert.doesNotMatch(text, /PRIVATE-ERROR|HTTP 429|Response interrupted|Useful partial/);
  }
  return new Response(sse(question === 'What are queues?' ? 'Recovered queue answer.' : 'Complete answer: ' + question) + 'data: [DONE]\n\n');
};
app.whenReady().then(() => {
  session.defaultSession.fetch = async () => { throw new Error('Hosted requests disabled in QA'); };
  clipboard.writeText = text => copied.push(text);
});
app.on('will-quit', () => { assert.equal(completed, true); assert.deepEqual(rendererErrors, []); console.log(JSON.stringify({ phase, success: true, requests: [...calls.values()].reduce((n, list) => n + list.length, 0) })); });
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let n = 0; n < 600; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    const click = async (label, scope = 'body') => { await js(`(()=>{const button=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing '+${JSON.stringify(label)});button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));button.click()})()`); await sleep(60); };
    const input = async value => { await js(`(()=>{const input=document.querySelector('.composer textarea,.compact-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(60); };
    const select = async (caption, text) => {
      await js(`(()=>{const node=document.querySelector('[data-caption-article="speech-${caption}"] [data-caption-part]').firstChild,range=document.createRange(),start=node.textContent.indexOf(${JSON.stringify(text)});if(start<0)throw Error('Missing selection text');range.setStart(node,start);range.setEnd(node,start+${text.length});const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()`);
      await until(() => js(`[...document.querySelector('[data-caption-article="speech-${caption}"]').querySelectorAll('.caption-use')].some(b=>/selection|Retry answer|View answers/.test(b.textContent))`), 'selection action');
    };
    const action = async caption => { await js(`(()=>{const button=document.querySelector('[data-caption-article="speech-${caption}"] .caption-use');if(button.disabled)throw Error('Caption action stuck disabled');button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));button.click()})()`); await sleep(60); };
    const error = () => until(() => js(`!!document.querySelector('.generated-answer.error')`), 'error with recovery controls');
    const ready = text => until(() => js(`[...document.querySelectorAll('.answer-markdown')].some(node=>node.textContent.includes(${JSON.stringify(text)}))&&!document.querySelector('.coach-thinking')`), 'completed answer');
    await until(() => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`), 'history ready');
    await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`);
    await until(() => js(`!!document.querySelector('.library-open')`), 'history library');
    await js(`[...document.querySelectorAll('.library-open')].find(b=>b.querySelector('strong')?.textContent==='Question recovery fixture').click();void 0`);
    await until(() => js(`!!document.querySelector('[data-caption-article="speech-0"]')`), 'saved captions');
    if (phase === 'reopen') {
      await error();
      assert.match(await js(`document.querySelector('.answer-error').textContent`), /HTTP 503/);
      await select(2, 'Restore this question.'); await action(2); await ready('Complete answer: Restore this question.');
      assert.equal(calls.get('Restore this question.').length, 1);
    } else {
      await select(0, 'What are queues?'); await action(0); await error();
      assert.equal(calls.get('What are queues?').length, 1);
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Unsent draft kept');
      await select(0, 'What are queues?'); await action(0); await error();
      assert.equal(calls.get('What are queues?').length, 2, 'Same selection must retry a failed question');
      await click('Retry answer', '.answer-recovery'); await error();
      assert.equal(calls.get('What are queues?').length, 3);
      assert.equal(await js(`document.querySelector('.answer-markdown').textContent`), 'Useful partial answer.');
      await click('Copy response'); assert.deepEqual(copied, ['Useful partial answer.']);
      await select(2, 'Describe caching.'); await action(2); await ready('Complete answer: Describe caching.');
      await select(0, 'What are queues?');
      await js(`(()=>{const button=document.querySelector('[data-caption-article="speech-0"] .caption-use');button.click();button.click()})()`);
      await ready('Recovered queue answer'); assert.equal(calls.get('What are queues?').length, 4, 'Double clicks cannot launch duplicate retries');
      assert.equal(await js(`(()=>{const paragraph=document.querySelector('.answer-markdown p'),node=paragraph.firstChild,range=document.createRange();paragraph.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:20,clientY:20}));range.setStart(node,0);range.setEnd(node,9);getSelection().removeAllRanges();getSelection().addRange(range);window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:100,clientY:35}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));return getSelection().toString()})()`), 'Recovered', 'Dragging across an answer must preserve native text selection');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Unsent draft kept');
      await select(0, 'What are queues?'); await action(0); assert.equal(calls.get('What are queues?').length, 4, 'Successful selection reuses saved answers');
      await input('Explain tradeoffs.'); await click('Send question'); await error();
      await click('Retry answer', '.answer-recovery'); await ready('Complete answer: Explain tradeoffs.');
      await select(2, 'Explain retries.'); await action(2);
      await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Stopped partial')`), 'partial before stop');
      await click('Stop answer'); await until(() => js(`!!document.querySelector('.answer-recovery')`), 'stopped recovery');
      assert.ok(partialController);
      await click('Retry answer', '.answer-recovery'); await ready('Complete answer: Explain retries.');
      await click('New question');
      await js(`(()=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0)),data=new DataTransfer();data.items.add(new File([bytes],'question.png',{type:'image/png'}));document.querySelector('.app').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}))})()`);
      await until(() => js(`document.querySelectorAll('.attachment-item').length===1`), 'screenshot attached');
      await input('Screenshot question.'); await click('Send question'); await error();
      await input('Draft survives retry'); await click('Retry answer', '.answer-recovery'); await ready('Complete answer: Screenshot question.');
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Draft survives retry');
      const images = calls.get('Screenshot question.')[1].messages[1].content;
      assert.equal(images.filter(part => part.type === 'image_url').length, 1);
      await click('Compact'); window.setSize(640, 700); await sleep(100);
      await select(2, 'Restore this question.'); await action(2); await error();
      assert.equal(await js(`(()=>{const r=document.querySelector('.answer-recovery').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`), true, 'Compact retry controls fit the window');
      await js(`getSelection()?.removeAllRanges()`);
      await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(profile, 'compact-error.png'), image.toPNG()));
    }
    completed = true; window.close();
  } catch (error) {
    console.error(error); console.error({ phase, rendererErrors, calls: [...calls].map(([question, list]) => ({ question, attempts: list.length })) });
    if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(`({answer:document.querySelector('.question-thread')?.textContent,toast:document.querySelector('.toast')?.textContent})`));
    app.exit(1);
  }
});
setTimeout(() => { console.error('Question recovery QA timed out'); app.exit(1); }, 60000);
