// Capture the real desktop UI with fictional, saved conversations.
// No device capture, external requests, or real credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const electron = require('electron');

if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-readme-'));
  const profileId = randomUUID(), threadId = randomUUID();
  const question = 'How would you design a reliable background job queue?';
  const lines = [
    ['computer', question, '¿Cómo diseñarías una cola fiable de trabajos en segundo plano?'],
    ['microphone', 'I would first clarify the workload, latency target, and what should happen when a job fails.', 'Primero aclararía la carga de trabajo, el objetivo de latencia y qué debería ocurrir si falla una tarea.'],
    ['computer', 'How would you handle retries without running a job twice?', '¿Cómo gestionarías los reintentos sin ejecutar una tarea dos veces?']
  ].map(([source, text, translated], i) => ({ id: 'sample-' + i, source, text, startMs: i * 18000, endMs: i * 18000 + 10000, isFinal: true, translation: { language: 'es', text: translated, sourceText: text } }));
  const now = new Date().toISOString();
  const conversation = {
    version: 1, id: randomUUID(), title: 'System design practice — reliable job queues', createdAt: now, updatedAt: now,
    captions: lines, threads: [{ id: threadId, question, captionIds: ['sample-0'], exchanges: [{ id: randomUUID(), question,
      answer: 'I would put a durable queue between the API and the workers. The API would validate the request, assign a stable job ID, and return once the queue has accepted it. That lets the system absorb traffic bursts without making the user wait for the work to finish.\n\nEach worker would acknowledge a job only after saving its result. I would make the handler safe to retry, use a delay between retries, and move repeatedly failing jobs to a separate queue for investigation.\n\nI would monitor queue depth, the age of the oldest job, and the failure rate. Those signals would help me decide when to add workers and when the system needs attention.',
      createdAt: now, status: 'ready', provider: 'lmstudio', model: 'local-model', context: [{ id: 'sample-0', source: 'computer', text: question }], sourceNames: [], demo: false }] }],
    selectedThreadId: threadId, draft: '', pendingContext: [], role: 'Senior software engineer', interviewType: 'Technical', responseStyle: 'Simple & professional'
  };
  fs.mkdirSync(path.join(profile, 'conversations'));
  const histories = [conversation, ...['Behavioral practice — taking ownership', 'Technical practice — caching and tradeoffs'].map((title, i) => ({ ...conversation, id: randomUUID(), title, threads: [], selectedThreadId: null, createdAt: new Date(Date.now() - (i + 1) * 86400000).toISOString(), updatedAt: new Date(Date.now() - (i + 1) * 86400000).toISOString() }))];
  for (const record of histories) fs.writeFileSync(path.join(profile, 'conversations', record.id + '.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', lmStudio: { baseUrl: 'http://localhost:1234/v1', model: 'local-model' }, captionProvider: 'openai', stealth: { enabled: false }, profiles: [{ id: profileId, name: 'Alex Morgan', details: 'Software engineer practicing system design and clear technical communication.', resumeText: '', updatedAt: now }], activeProfileId: profileId, jobs: [] }));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENROUTER_API_KEY', 'NANOGPT_API_KEY', 'LMSTUDIO_MODEL']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, profile, conversation.id], { env, stdio: 'inherit', timeout: 60000 });
  assert.equal(result.status, 0, 'README screenshot capture must finish cleanly');
  console.log(JSON.stringify({ success: true, profile, output: path.resolve(__dirname, '../docs/screenshots') }));
  process.exit(0);
}

const { app, globalShortcut, session } = electron;
const profile = path.resolve(process.argv[2]);
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
global.fetch = async () => { throw new Error('Documentation screenshots must not contact external services.'); };
app.whenReady().then(() => { session.defaultSession.fetch = global.fetch; });
let window, completed = false;
const errors = [];
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created;
  created.setBounds({ x: -20000, y: -20000, width: 1440, height: 960 });
  created.setFocusable(false); created.show = () => {}; created.showInactive = () => {}; created.focus = () => {};
  created.webContents.setBackgroundThrottling(false);
  created.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) { for (let i = 0; i < 500; i++) { if (await check()) return; await sleep(30); } throw new Error('Timed out: ' + description); }
require(path.resolve(__dirname, '../out/main/index.js'));
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'workspace');
    const js = code => window.webContents.executeJavaScript(code, true);
    const click = label => js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')?.startsWith(${JSON.stringify(label)}));if(!b||b.disabled)throw Error('Missing control: '+${JSON.stringify(label)});b.click()})()`);
    await until(() => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`), 'ready composer');
    await js(`(()=>{const s=document.createElement('style');s.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(s)})()`);
    await click('Conversation history');
    await until(() => js(`document.querySelectorAll('.library-open').length===3`), 'sample history');
    await js(`[...document.querySelectorAll('.library-open')].find(b=>b.querySelector('strong')?.textContent.includes('reliable job queues')).click();void 0`);
    await until(() => js(`!!document.querySelector('.answer-markdown')&&document.querySelectorAll('.caption-line').length===3`), 'saved transcript and answer');
    await click('Translate captions'); await click('Translate to Spanish');
    await until(() => js(`document.querySelectorAll('.caption-translated p').length===3`), 'saved bilingual captions');
    await js(`document.querySelector('.caption-lines').scrollTop=0;void 0`);
    const output = path.resolve(__dirname, '../docs/screenshots'); fs.mkdirSync(output, { recursive: true });
    async function capture(name) {
      await js(`document.fonts.ready`);
      window.setSize(1439, 960); await sleep(100); window.setSize(1440, 960);
      window.webContents.invalidate(); await sleep(500);
      fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    }
    await capture('workspace.png');
    await click('Conversation history'); await until(() => js(`document.querySelectorAll('.library-open').length===3`), 'conversation library');
    await capture('history.png');
    assert.deepEqual(errors, [], 'Screenshot run should have no renderer errors');
    completed = true; window.close();
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('will-quit', () => { assert.equal(completed, true); });
setTimeout(() => { console.error('README screenshot capture timed out'); app.exit(1); }, 45000);
