// Real Electron passage retries. Provider rejection/success are fixtures. When
// an installed Korean pack exists, a copied pack exercises real native fallback.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-translation-retry-'));
  const id = randomUUID(), now = new Date().toISOString();
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', translation: { provider: 'chat' }, profiles: [], jobs: [] }));
  const texts = [['online', 'Online success: explain the design.', 'ko'], ['native', 'Hello, thank you for joining the interview.', 'ko'], ['cancel', 'Pending request: cancel when language changes.', 'ko'], ['source', '한국어 원문입니다.', 'ko'], ['missing', 'This passage needs a Spanish translation pack.', 'es'], ['unsupported', 'No offline Tamil pack is available.', 'ta']];
  fs.mkdirSync(path.join(profile, 'conversations'));
  fs.writeFileSync(path.join(profile, 'conversations', id + '.json'), JSON.stringify({ version: 1, id, title: 'Passage retry fixture', createdAt: now, updatedAt: now, captions: texts.map(([id, text, language], n) => ({ id, source: 'computer', text, startMs: n * 1000, endMs: n * 1000 + 500, isFinal: true, translation: { language, text: '', sourceText: text, engine: 'chat:lmstudio:0', skipped: 'content_filter' } })), threads: [], selectedThreadId: null, draft: '', pendingContext: [], role: '', interviewType: '', responseStyle: '' }));
  const source = path.join(process.env.APPDATA || '', 'interview-studio', 'translation-packs', 'en-ko');
  const native = fs.existsSync(path.join(source, 'installed.json'));
  if (native) fs.cpSync(source, path.join(profile, 'translation-packs', 'en-ko'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'scenario.json'), JSON.stringify({ id, native }));
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NANOGPT_API_KEY']) delete env[name];
  for (const phase of ['exercise', 'reopen']) {
    const result = require('node:child_process').spawnSync(electron, [__filename, phase, profile], { env, stdio: 'inherit', timeout: 90000 });
    assert.equal(result.status, 0, phase + ' must finish cleanly');
  }
  const record = JSON.parse(fs.readFileSync(path.join(profile, 'conversations', id + '.json'), 'utf8'));
  assert.ok(!record.captions.find(line => line.id === 'online').translation.skipped);
  if (native) { const translated = record.captions.find(line => line.id === 'native').translation; assert.equal(translated.via, 'offline'); assert.match(translated.text, /[가-힣]/u); }
  console.log(JSON.stringify({ success: true, nativeOfflineTested: native, profile, checks: ['retry icon beside skipped passage', 'selected provider retry and spinner', 'only chosen passage updated', 'native offline fallback when Korean pack is installed', 'missing pack message and download action', 'unsupported language/source', 'language change cancels pending retry', 'saved retries retain provider and offline marker across restart', 'no recording devices or hosted calls'] }));
  process.exit(0);
}
const { app, BrowserWindow, globalShortcut, ipcMain, session } = electron;
const phase = process.argv[2], profile = path.resolve(process.argv[3]);
const meta = JSON.parse(fs.readFileSync(path.join(profile, 'scenario.json'), 'utf8'));
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let window, completed = false, pendingAborted = false, downloadRequested = false;
const requests = [], errors = [];
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created; window.setPosition(-20000, -20000); window.setFocusable(false); window.show = () => {}; window.showInactive = () => {}; window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
global.fetch = async (url, init) => {
  assert.equal(String(url), 'http://localhost:1234/v1/chat/completions');
  const request = JSON.parse(init.body), text = request.messages.at(-1).content; requests.push(text);
  if (text.startsWith('Pending request')) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { pendingAborted = true; reject(init.signal.reason); }, { once: true }));
  if (text.startsWith('Online success')) {
    await new Promise(resolve => setTimeout(resolve, 250));
    return Response.json({ choices: [{ message: { content: '온라인 번역입니다.' }, finish_reason: 'stop' }] });
  }
  return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });
};
app.whenReady().then(() => { session.defaultSession.fetch = async () => { throw new Error('Hosted API and download access disabled in retry fixture'); }; });
app.on('will-quit', () => { assert.equal(completed, true); assert.deepEqual(errors, []); console.log(JSON.stringify({ phase, success: true, calls: requests.length, nativeOfflineTested: meta.native })); });
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let n = 0; n < 1000; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    const click = async label => { await js(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing '+${JSON.stringify(label)});button.click()})()`); await sleep(50); };
    const pair = id => `document.querySelector('[data-caption-part="${id}"]').closest('.caption-pair')`;
    const retry = async id => { await js(`${pair(id)}.querySelector('.caption-passage-retry').click();void 0`); await sleep(40); };
    const language = async name => { await click('Translate captions'); await click('Translate to ' + name); };
    await until(() => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`), 'fresh session');
    await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`);
    await until(() => js(`!!document.querySelector('.library-open')`), 'history');
    await js(`document.querySelector('.library-open').click();void 0`);
    await until(() => js(`document.querySelectorAll('.caption-line').length>0`), 'open saved skipped captions');
    await language('Korean');
    assert.equal(await js(`document.querySelector('.caption-status').textContent`), 'Off', 'Saved text retries do not start recording');
    if (phase === 'exercise') {
      const before = requests.length; await retry('online');
      assert.equal(await js(`${pair('online')}.querySelector('.caption-passage-retry').disabled`), true);
      assert.match(await js(`${pair('online')}.textContent`), /Retrying translation/);
      await until(() => js(`${pair('online')}.textContent.includes('온라인 번역입니다.')`), 'online retry result');
      assert.equal(requests.length, before + 1); assert.equal(await js(`!!${pair('native')}.querySelector('.caption-translation-skipped')`), true);
      await retry('native');
      if (meta.native) {
        await until(() => js(`${pair('native')}.textContent.includes('Offline · English source')`), 'real offline inference');
        assert.match(await js(`${pair('native')}.querySelector('.caption-translated p').textContent`), /[가-힣]/u);
      } else await until(() => js(`${pair('native')}.textContent.includes('Download')`), 'missing Korean pack');
      await retry('source'); await until(() => js(`${pair('source')}.textContent.includes('English source captions only')`), 'incompatible offline source');
      await retry('cancel'); await until(() => requests.some(text => text.startsWith('Pending request')), 'pending provider retry');
      await language('Spanish'); await until(() => pendingAborted, 'language change cancellation');
      await retry('missing'); await until(() => js(`${pair('missing')}.textContent.includes('Download this language')`), 'missing Spanish pack');
      assert.equal(await js(`!!${pair('missing')}.querySelector('.caption-passage-error button')`), true);
      // Verify the explicit download action without downloading a model.
      ipcMain.removeHandler('translation:packs:download'); ipcMain.handle('translation:packs:download', (_event, target) => { assert.equal(target, 'es'); downloadRequested = true; return { packs: [] }; });
      await js(`${pair('missing')}.querySelector('.caption-passage-error button').click();void 0`); await until(() => downloadRequested, 'explicit pack download action');
      await language('Tamil'); await retry('unsupported');
      await until(() => js(`${pair('unsupported')}.textContent.includes('No offline English source pack')`), 'unsupported language');
      await language('Korean'); await click('Compact'); await until(() => js(`!!document.querySelector('.compact-app')`), 'compact retry layout');
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`), true);
      await js(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(style)})()`);
      window.setSize(559, 740); await sleep(150);
      fs.writeFileSync(path.join(profile, 'retry-compact.png'), (await window.webContents.capturePage()).toPNG());
    } else {
      assert.equal(requests.length, 0, 'Reopening successful retries does not call a provider');
      assert.equal(await js(`!!${pair('online')}.querySelector('.caption-translation-skipped')`), false);
      if (meta.native) assert.match(await js(`${pair('native')}.textContent`), /Offline · English source/);
    }
    completed = true; window.close();
  } catch (error) { console.error(error, { errors, requests }); app.exit(1); }
});
setTimeout(() => { console.error('Translation retry UI test timed out'); app.exit(1); }, 80000);
