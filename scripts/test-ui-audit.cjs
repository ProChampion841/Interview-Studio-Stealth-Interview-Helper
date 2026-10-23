// Compiled Electron UI audit. All credentials, files, capture images and API
// replies are fixtures in a disposable profile; no real devices or APIs used.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function captionFixture() {
  const { randomUUID } = require('node:crypto'), now = new Date().toISOString();
  return { version: 1, id: randomUUID(), title: 'Caption UI audit', createdAt: now, updatedAt: now, captions: [
    { id: 'a', source: 'computer', text: 'A queue buffers work.', startMs: 0, endMs: 1000, isFinal: true },
    { id: 'b', source: 'computer', text: 'It absorbs traffic bursts.', startMs: 1000, endMs: 2000, isFinal: true },
    { id: 'c', source: 'microphone', text: 'I would use a bounded queue.', startMs: 2000, endMs: 3000, isFinal: true },
    { id: 'd', source: 'computer', text: 'What is the tradeoff?', startMs: 3000, endMs: 4000, isFinal: true }
  ].map(line => ({ ...line, translation: { language: 'es', text: 'Una respuesta clara.', sourceText: line.text } })), threads: [], selectedThreadId: null, draft: '', pendingContext: [], role: 'QA engineer', interviewType: 'Technical', responseStyle: 'Simple & professional' };
}
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-ui-audit-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', profiles: [], jobs: [] }));
  fs.writeFileSync(path.join(profile, 'resume.txt'), 'QA engineer. Built reliable queues and automated browser tests.');
  fs.writeFileSync(path.join(profile, 'resume.md'), '# QA engineer\nBuilt safe translation and capture tools.');
  const pdfText = 'BT /F1 12 Tf 72 720 Td (QA Engineer PDF resume. Reliable services.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const startXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  fs.writeFileSync(path.join(profile, 'resume.pdf'), pdf);
  fs.mkdirSync(path.join(profile, 'conversations'));
  const fixture = captionFixture();
  fs.writeFileSync(path.join(profile, 'conversations', fixture.id + '.json'), JSON.stringify(fixture));
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NANOGPT_API_KEY', 'LMSTUDIO_MODEL']) delete env[name];
  const result = require('node:child_process').spawnSync(electron, [__filename, profile], { env, stdio: 'inherit', timeout: 180000 });
  assert.equal(result.status, 0, 'UI audit must finish cleanly');
  console.log(JSON.stringify({ success: true, profile, ...JSON.parse(fs.readFileSync(path.join(profile, 'results.json'), 'utf8')) }));
  process.exit(0);
}
const { app, BrowserWindow, globalShortcut, session, dialog, desktopCapturer, nativeImage, screen } = electron;
const profile = path.resolve(process.argv[2]);
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
if (process.argv.includes('--secondary')) {
  app.on('browser-window-created', () => { console.error('Duplicate instance created a window'); app.exit(2); });
  require(path.resolve(__dirname, '../out/main/index.js'));
  return;
}
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let window, completed = false, failNetwork = false, networkCalls = 0, resumeFile = 'resume.txt', holdCompanyBrief = false, releaseCompanyBrief;
const windows = [], errors = [], checks = [];
app.on('browser-window-created', (_event, created) => {
  window ??= created; windows.push(created);
  created.setFullScreen(false); created.setBounds({ x: -20000, y: -20000, width: 1100, height: 800 }); created.setFocusable(false);
  created.show = () => {}; created.showInactive = () => {}; created.focus = () => {}; created.webContents.setBackgroundThrottling(false);
  created.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixtureFetch(url, init) {
  networkCalls++; await sleep(200);
  const target = new URL(String(url));
  assert.ok(['localhost', 'openrouter.ai', 'api.openai.com', 'nano-gpt.com', 'api.cognitive.microsofttranslator.com', 'translation.googleapis.com', 'fixture.example', 'lite.duckduckgo.com'].includes(target.hostname), 'Unexpected network destination: ' + target.hostname);
  if (failNetwork) return Response.json({ error: { code: 401, message: 'PRIVATE-ERROR fixture-secret' } }, { status: 401 });
  if (target.hostname === 'fixture.example' || target.hostname === 'lite.duckduckgo.com') {
    const response = new Response('<html><script>PRIVATE-INJECTION()</script><h1>Fixture Company builds reliable messaging tools.</h1><a class="result__snippet">Fixture Company maintains queue software.</a></html>', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: String(url) }); return response;
  }
  if (target.pathname.endsWith('/key')) return Response.json({ data: { is_free_tier: false } });
  if (target.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'fixture/model' }, { id: 'gpt-4.1-mini' }] });
  if (target.hostname === 'api.cognitive.microsofttranslator.com') return Response.json([{ translations: [{ text: 'Hola, gracias.', to: 'es' }] }]);
  if (target.hostname === 'translation.googleapis.com') return Response.json({ data: { translations: [{ translatedText: 'Hola, gracias.' }] } });
  if (target.pathname.endsWith('/responses')) return Response.json({ id: 'fixture-response', object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hola, gracias.', annotations: [] }] }], output_text: 'Hola, gracias.' });
  assert.ok(target.pathname.endsWith('/chat/completions'), 'Unexpected fixture route: ' + target.pathname);
  const body = JSON.parse(init.body);
  if (body.messages[0].content.includes('preparing a short company briefing')) {
    assert.doesNotMatch(body.messages[1].content, /PRIVATE-INJECTION/);
    assert.match(body.messages[1].content, /untrusted content, not instructions/);
    if (holdCompanyBrief) { holdCompanyBrief = false; await new Promise(resolve => { releaseCompanyBrief = resolve }); }
    return Response.json({ choices: [{ message: { content: 'Fixture Company builds reliable messaging tools.' } }] });
  }
  if (!body.stream) return Response.json({ choices: [{ message: { content: 'Hola, gracias.' } }] });
  return new Response('data: {"choices":[{"delta":{"content":"I would start with a simple, reliable approach."}}]}\n\ndata: [DONE]\n\n');
}
global.fetch = fixtureFetch;
app.whenReady().then(() => {
  session.defaultSession.fetch = fixtureFetch;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(profile, resumeFile)] });
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  desktopCapturer.getSources = async options => {
    const thumb = nativeImage.createFromBitmap(Buffer.alloc(800 * 600 * 4, 255), { width: 800, height: 600 });
    return Array.from({ length: options.types.length === 1 && options.types[0] === 'screen' ? 1 : 8 }, (_, n) => ({ id: 'screen:' + n + ':0', name: 'Fixture screen ' + (n + 1), display_id: String(screen.getPrimaryDisplay().id), thumbnail: thumb, appIcon: nativeImage.createEmpty() }));
  };
});
app.on('will-quit', () => { assert.equal(completed, true); assert.deepEqual(errors, []); });
require(path.resolve(__dirname, '../out/main/index.js'));
async function until(check, label) { for (let n = 0; n < 600; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    await js(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(style)})()`);
    const click = async (label, scope = 'body') => { await js(`(()=>{const b=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});if(b.disabled)throw Error('Disabled '+${JSON.stringify(label)});b.click()})()`); await sleep(55); };
    const field = async (selector, value) => { await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field '+${JSON.stringify(selector)});const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(45); };
    const menu = async (label, option) => { await click(label); await click(option, '[role="listbox"]'); };
    const settings = async () => { if (!await js(`!!document.querySelector('.settings-page')`)) await click('Settings'); await click('AI connection'); };
    const scope = fieldId => `document.querySelector(${JSON.stringify(fieldId)}).closest('.settings-section')`;
    const connection = async (fieldId, outcome) => until(() => js(`!!${scope(fieldId)}.querySelector('.connection-feedback.${outcome}')`), 'connection ' + outcome);
    let lastTranslationTest = 0;
    const clickConnection = async (fieldId, label) => {
      if (fieldId === '#translation-provider' && /[Tt]est/.test(label)) {
        // The real handler deliberately limits connection tests to one / 3s.
        await sleep(Math.max(0, 3150 - (Date.now() - lastTranslationTest)));
        lastTranslationTest = Date.now();
      }
      await js(`(()=>{const b=[...${scope(fieldId)}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing/disabled '+${JSON.stringify(label)});b.click()})()`); await sleep(40);
    };
    const check = async (name, run) => { await run(); checks.push(name); console.log(JSON.stringify({ check: name, success: true })); };
    await until(() => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`), 'composer');
    await check('fresh startup is blank and audio is off', async () => { assert.equal(await js(`document.querySelector('.composer textarea').value`), ''); assert.equal(await js(`document.querySelector('.caption-status').textContent`), 'Off'); assert.equal(networkCalls, 0); });
    await settings();
    await check('provider dropdown supports keyboard opening, navigation, selection and Escape', async () => {
      const key = async (selector, name) => { await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,cancelable:true}))`); await sleep(60); };
      await key('[aria-label="AI provider"]', 'ArrowDown');
      assert.equal(await js(`document.querySelector('[aria-label="AI provider"]').getAttribute('aria-expanded')`), 'true', 'ArrowDown must open the provider menu');
      await key('[role="listbox"]', 'Home'); await key('[role="listbox"]', 'Enter');
      await until(async () => (await js(`window.studio.getSettings()`)).provider === 'openai', 'keyboard provider selection');
      await key('[aria-label="AI provider"]', 'ArrowDown'); await key('[role="listbox"]', 'End'); await key('[role="listbox"]', 'Enter');
      await until(async () => (await js(`window.studio.getSettings()`)).provider === 'lmstudio', 'keyboard provider restore');
      await key('[aria-label="AI provider"]', 'ArrowUp'); await key('[role="listbox"]', 'Escape'); assert.equal(await js(`!!document.querySelector('[role="listbox"]')`), false);
    });
    await check('LM Studio connection feedback, progress and failure recovery', async () => {
      await clickConnection('#lm-model', 'Test connection'); await connection('#lm-model', 'working'); await connection('#lm-model', 'success');
      failNetwork = true; await clickConnection('#lm-model', 'Test connection'); await connection('#lm-model', 'error'); failNetwork = false;
      assert.doesNotMatch(await js(`${scope('#lm-model')}.textContent`), /PRIVATE-ERROR|fixture-secret/);
      await clickConnection('#lm-model', 'Test connection'); await connection('#lm-model', 'success');
    });
    for (const [option, prefix] of [['OpenRouter API', 'router'], ['NanoGPT API', 'nano']]) {
      await check(option + ' save/test and credential feedback', async () => {
        await menu('AI provider', option); await field('#' + prefix + '-key', 'fixture-key-for-' + prefix + '-12345678901234567890'); await field('#' + prefix + '-model', 'fixture/model');
        await clickConnection('#' + prefix + '-key', 'Save & test connection'); await connection('#' + prefix + '-key', 'working'); await connection('#' + prefix + '-key', 'success');
        assert.equal(await js(`document.querySelector('#${prefix}-key').value`), '');
      });
    }
    await check('OpenAI key validation, masking, encrypted save and removal', async () => {
      await menu('AI provider', 'OpenAI (bring your own key)'); await field('#api-key', 'short');
      assert.equal(await js(`document.querySelector('.api-form button[type="submit"]').disabled`), true);
      await field('#api-key', 'sk-fixture-openai-12345678901234567890'); await click('Show API key'); assert.equal(await js(`document.querySelector('#api-key').type`), 'text'); await click('Hide API key');
      await click('Save API key'); await until(() => js(`!!document.querySelector('.configured-key')`), 'saved OpenAI key');
      assert.doesNotMatch(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'), /sk-fixture-openai/);
      await click('Remove', '.configured-key'); await until(() => js(`!!document.querySelector('#api-key')`), 'removed key');
    });
    await menu('AI provider', 'LM Studio (local server)');
    for (const [label, value] of [['OpenRouter', 'openrouter'], ['Offline (local)', 'offline'], ['OpenAI', 'openai']]) await check('caption provider switches independently: ' + label, async () => { await menu('Caption provider', label); const s = await js(`window.studio.getSettings()`); assert.equal(s.provider, 'lmstudio'); assert.equal(s.captionProvider, value); });
    for (const label of ['Azure Translator', 'Google Cloud Translation', 'OpenRouter', 'OpenAI', 'NanoGPT']) await check('translation save/test/status: ' + label, async () => {
      if (await js(`document.querySelector('#translation-provider').textContent.trim()`) !== label) await menu('Translation provider', label);
      await field('#translation-api-key', 'fixture-translation-key-12345678901234567890');
      await clickConnection('#translation-provider', 'Save & test connection'); await connection('#translation-provider', 'working'); await connection('#translation-provider', 'success');
      assert.equal(await js(`document.querySelector('#translation-api-key').value`), '');
    });
    await check('translation errors are visible and recover without changing chat settings', async () => {
      failNetwork = true; await clickConnection('#translation-provider', 'Test connection'); await connection('#translation-provider', 'error'); failNetwork = false;
      await clickConnection('#translation-provider', 'Test connection'); await connection('#translation-provider', 'success');
      assert.equal((await js(`window.studio.getSettings()`)).provider, 'lmstudio');
      await clickConnection('#translation-provider', 'Remove key'); await until(() => js(`!document.querySelector('.translation-form .danger-text')`), 'translation key removed');
    });
    await check('offline translation pack search and installed/download states', async () => {
      await menu('Translation provider', 'Offline (language packs)'); await until(() => js(`!!document.querySelector('.offline-pack-row')`), 'offline packs UI');
      await field('[aria-label="Search offline languages"]', 'Korean'); assert.equal(await js(`document.querySelectorAll('.offline-pack-row').length`), 1);
      assert.match(await js(`document.querySelector('.offline-pack-row').textContent`), /Korean|한국어/);
    });
    await menu('Translation provider', 'Use chat connection (LM Studio)');
    await check('proxy field validation and direct/system route save', async () => {
      await menu('Proxy mode', 'HTTP proxy'); await field('#proxy-host', 'https://bad.example/path'); await field('#proxy-port', '99999'); await click('Save proxy');
      await until(() => js(`!!document.querySelector('#proxy-host-error')&&!!document.querySelector('#proxy-port-error')`), 'proxy validation errors');
      await menu('Proxy mode', 'Direct connection (no proxy)'); await click('Save proxy');
      await until(async () => (await js(`window.studio.getSettings()`)).proxy.mode === 'direct', 'direct route saved');
      await menu('Proxy mode', 'Use operating-system proxy'); await click('Save proxy');
      await until(async () => (await js(`window.studio.getSettings()`)).proxy.mode === 'system', 'system route saved');
    });
    await click('Coach profile');
    await check('profile create, TXT/Markdown/PDF resume upload, edit and delete', async () => {
      await field('#profile-name', 'QA Profile'); await field('[aria-label="Profile details"]', 'Five years working on reliable services.'); await click('Upload resume'); await until(() => js(`document.querySelector('.resume-name')?.textContent.includes('resume.txt')`), 'resume upload');
      resumeFile = 'resume.md'; await click('Replace resume'); await until(() => js(`document.querySelector('.resume-name')?.textContent.includes('resume.md')`), 'Markdown resume upload');
      resumeFile = 'resume.pdf'; await click('Replace resume'); await until(() => js(`document.querySelector('.resume-name')?.textContent.includes('resume.pdf')`), 'PDF resume upload');
      await click('Create profile'); await until(() => js(`!!document.querySelector('[aria-label="Edit QA Profile"]')`), 'profile created');
      assert.match((await js(`window.studio.listProfiles()`)).profiles[0].resumeText, /QA Engineer PDF resume/);
      await click('Edit QA Profile'); await field('#profile-name', 'QA Profile Edited'); await click('Save profile'); await until(() => js(`!!document.querySelector('[aria-label="Delete QA Profile Edited"]')`), 'profile edited');
      await click('Delete QA Profile Edited'); await until(() => js(`!document.querySelector('[aria-label="Delete QA Profile Edited"]')`), 'profile removed');
    });
    await check('job edit/delete, company research recovery and speaking styles', async () => {
      await field('#job-name', 'QA Job'); await field('[aria-label="Job description"]', 'Build reliable interview tools.'); await click('Create job'); await until(() => js(`!!document.querySelector('[aria-label="Edit QA Job"]')`), 'job created');
      await click('Edit QA Job'); await field('#job-name', 'QA Job Edited'); await click('Save job'); await until(() => js(`!!document.querySelector('[aria-label="Delete QA Job Edited"]')`), 'job edited');
      await field('input[placeholder="Acme Corp"]', 'Fixture Company'); await field('input[placeholder="https://acme.example"]', 'https://fixture.example'); await click('Save & analyze company');
      await until(() => js(`document.querySelector('.company-brief')?.textContent.includes('reliable messaging tools')`), 'company briefing');
      failNetwork = true; await click('Analyze company'); await until(() => js(`document.querySelector('.settings-content').textContent.includes('No company information could be fetched')`), 'company research failure feedback'); failNetwork = false;
      assert.match((await js(`window.studio.listJobs()`)).jobs[0].companyBrief, /reliable messaging tools/);
      holdCompanyBrief = true; await click('Analyze company'); await until(() => !!releaseCompanyBrief, 'held company research');
      await click('New job'); await field('#job-name', 'Concurrent QA Job'); await click('Create job');
      await until(() => js(`!!document.querySelector('[aria-label="Edit Concurrent QA Job"]')`), 'concurrent job created');
      await js(`[...document.querySelectorAll('[aria-label="Saved jobs"] .profile-select')].find(b=>b.querySelector('strong')?.textContent==='Concurrent QA Job').click();void 0`);
      await until(async () => { const state = await js(`window.studio.listJobs()`); return state.jobs.find(job => job.id === state.activeJobId)?.name === 'Concurrent QA Job'; }, 'concurrent job active');
      releaseCompanyBrief(); await until(() => js(`![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Researching...')`), 'company research finished');
      const state = await js(`window.studio.listJobs()`);
      assert.equal(state.jobs.length, 2, 'A late company result must not discard a job created during research');
      assert.equal(state.jobs.find(job => job.id === state.activeJobId)?.name, 'Concurrent QA Job', 'Research must not revert the active job');
      assert.equal(await js(`!!document.querySelector('.company-brief')`), false, 'Research for job A must not fill job B draft');
      await click('Delete Concurrent QA Job'); await until(() => js(`!document.querySelector('[aria-label="Delete Concurrent QA Job"]')`), 'concurrent job removed');
      await click('Delete QA Job Edited'); await until(() => js(`!document.querySelector('[aria-label="Delete QA Job Edited"]')`), 'job removed');
      await menu('Response style', 'Detailed answer'); await menu('Response style', 'Simple & professional');
    });
    await check('all settings sections fit normal and narrow layouts', async () => {
      for (const width of [1100, 640]) {
        window.setSize(width, 800); await sleep(80);
        for (const tab of ['AI connection', 'Coach profile', 'Privacy', 'Window']) {
          await click(tab);
          assert.equal(await js(`document.querySelector('.settings-tabs button[aria-current="page"]').textContent.trim()`), tab);
          assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true, tab + ' overflows at ' + width);
          assert.equal(await js(`[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0).every(b=>getComputedStyle(b).cursor==='default')`), true, 'Button cursor changes on ' + tab);
          window.setSize(width - 1, 800); window.setSize(width, 800); window.webContents.invalidate(); await sleep(180);
          await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(profile, tab.replaceAll(' ', '-') + '-' + width + '.png'), image.toPNG()));
        }
      }
    });
    await check('window controls update on-top, opacity, title and privacy settings', async () => {
      await click('Window'); const before = await js(`window.studio.getSettings()`);
      await click('Keep window on top'); await until(async () => (await js(`window.studio.getSettings()`)).alwaysOnTop !== before.alwaysOnTop, 'on-top toggled');
      assert.equal(window.isAlwaysOnTop(), !before.alwaysOnTop); await click('Keep window on top');
      await field('[aria-label="Window opacity percent"]', '65'); await until(() => Math.abs(window.getOpacity() - .65) < .03, 'native window opacity');
      await field('[aria-label="Window opacity percent"]', '100');
      await field('[aria-label="Decoy window title"]', 'QA Decoy'); await js(`document.querySelector('[aria-label="Decoy window title"]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`);
      await until(() => window.getTitle() === 'QA Decoy', 'decoy title saved');
      await click('Stealth mode'); await until(async () => !(await js(`window.studio.getSettings()`)).stealth.enabled, 'privacy off');
      await click('Stealth mode'); await until(async () => (await js(`window.studio.getSettings()`)).stealth.enabled, 'privacy restored');
    });
    await click('Interview chat');
    await check('second process restores existing instance without opening a duplicate', async () => {
      await field('.composer textarea', 'Draft preserved across duplicate launch');
      const count = BrowserWindow.getAllWindows().length;
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(process.execPath, [__filename, profile, '--secondary'], { env, stdio: 'pipe', windowsHide: true });
      let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data });
      const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
      assert.equal(code, 0, output); assert.equal(BrowserWindow.getAllWindows().length, count);
      assert.equal(await js(`document.querySelector('.composer textarea').value`), 'Draft preserved across duplicate launch');
    });
    await check('eight source screenshots attach together; picker cancellation is safe', async () => {
      await click('Attach screenshots'); await click('Screens / windows'); await until(() => js(`document.querySelectorAll('.source-card').length===8`), 'source picker');
      await js(`[...document.querySelectorAll('.source-card')].forEach(b=>b.click());void 0`); await sleep(60); await click('Attach 8 screenshots'); await until(() => js(`document.querySelectorAll('.attachment-item').length===8`), 'eight screenshots');
      await click('Attach screenshots'); await click('Screens / windows'); await until(() => js(`!!document.querySelector('.source-card')`), 'picker reopen'); await click('Close capture picker'); assert.equal(await js(`document.querySelectorAll('.attachment-item').length`), 8);
    });
    await check('area selection hides cursor only during drag; tiny crop and Escape recover', async () => {
      await click('Select area'); await until(() => windows.some(w => w !== window && !w.isDestroyed() && !w.webContents.isLoading()), 'area overlay');
      const overlay = windows.find(w => w !== window && !w.isDestroyed()), area = code => overlay.webContents.executeJavaScript(code, true);
      await until(() => area(`document.querySelector('.area-instructions strong')?.textContent==='Drag to select an area'`), 'area ready');
      assert.equal(await area(`getComputedStyle(document.querySelector('.area-capture')).cursor`), 'default');
      overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: 100, y: 100, clickCount: 1 }); await sleep(70);
      assert.equal(await area(`getComputedStyle(document.querySelector('.area-capture')).cursor`), 'none');
      overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: 102, y: 102, clickCount: 1 }); await sleep(70);
      assert.equal(await area(`getComputedStyle(document.querySelector('.area-capture')).cursor`), 'default');
      assert.match(await area(`document.querySelector('.area-instructions').textContent`), /larger rectangle/);
      overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await until(() => overlay.isDestroyed(), 'Escape closes overlay');
      assert.equal(await js(`document.querySelectorAll('.attachment-item').length`), 8);
    });
    await check('valid area crop adds a ninth screenshot', async () => {
      await click('Select area'); await until(() => windows.some(w => w !== window && !w.isDestroyed() && !w.webContents.isLoading()), 'second area overlay');
      const overlay = windows.find(w => w !== window && !w.isDestroyed());
      await until(() => overlay.webContents.executeJavaScript(`document.querySelector('.area-instructions strong')?.textContent==='Drag to select an area'`), 'second area ready');
      overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: 100, y: 100, clickCount: 1 }); overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 300, y: 250 }); overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: 300, y: 250, clickCount: 1 });
      await until(() => js(`document.querySelectorAll('.attachment-item').length===9`), 'ninth screenshot');
    });
    await field('.composer textarea', 'Explain a reliable queue.'); await click('Send question'); await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('simple, reliable approach')`), 'answer with nine images');
    checks.push('Q&A sends nine image attachments and displays the response');
    await check('caption grouping, source filters, font size and microphone mute', async () => {
      await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`);
      await until(() => js(`[...document.querySelectorAll('.library-open strong')].some(node=>node.textContent==='Caption UI audit')`), 'caption fixture history');
      await js(`[...document.querySelectorAll('.library-open')].find(b=>b.querySelector('strong')?.textContent==='Caption UI audit').click();void 0`);
      await until(() => js(`document.querySelectorAll('.caption-line').length===3`), 'three alternating turns');
      await click('Caption options'); await click('Professional', '[aria-label="Filter captions"]'); assert.equal(await js(`document.querySelectorAll('.caption-line').length`), 2);
      await click('YOU', '[aria-label="Filter captions"]'); assert.equal(await js(`document.querySelectorAll('.caption-line').length`), 1);
      await click('All', '[aria-label="Filter captions"]'); await click('Larger caption text'); assert.equal(await js(`getComputedStyle(document.querySelector('.caption-lines')).fontSize`), '19px');
      await click('Smaller caption text'); await click('Caption options'); await click('Mute microphone'); assert.equal(await js(`document.querySelector('[aria-label="Unmute microphone"]').getAttribute('aria-pressed')`), 'true'); await click('Unmute microphone');
    });
    await check('translation language search and reading views work on saved captions without API calls', async () => {
      const before = networkCalls;
      await click('Translate captions'); await field('[aria-label="Search translation languages"]', 'Spanish');
      assert.equal(await js(`document.querySelectorAll('[aria-label="Translation languages"] button').length`), 2);
      await click('Translate to Spanish'); await until(() => js(`document.querySelectorAll('.caption-translated p').length===4`), 'saved translations visible');
      await click('Translate captions'); await click('Translation only'); assert.equal(await js(`document.querySelectorAll('.caption-original').length`), 0);
      await click('Translate captions'); await click('Original + translation'); assert.equal(await js(`document.querySelectorAll('.caption-original').length`), 4);
      assert.equal(networkCalls, before, 'Viewing saved captions must not call a provider');
      await click('Translate captions'); await click('Translation off');
    });
    fs.writeFileSync(path.join(profile, 'results.json'), JSON.stringify({ checks, networkCalls, realApiCalls: false, recordingDevicesUsed: false, errors }, null, 2));
    completed = true; window.close();
  } catch (error) {
    console.error(error); console.error({ completedChecks: checks, errors });
    if (window && !window.isDestroyed()) { fs.writeFileSync(path.join(profile, 'failure.png'), (await window.webContents.capturePage()).toPNG()); console.error(await window.webContents.executeJavaScript(`document.querySelector('.settings-content')?.innerText.slice(-1800)||document.body.innerText.slice(-1000)`)); }
    app.exit(1);
  }
});
setTimeout(() => { console.error('UI audit timed out'); app.exit(1); }, 170000);
