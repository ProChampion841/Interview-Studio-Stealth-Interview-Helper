// Real Electron safety check with isolated, generated data and localhost only.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-http-cache-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  for (const key of ['OPENAI_API_KEY', 'NANOGPT_API_KEY', 'OPENROUTER_API_KEY']) delete env[key];
  for (const phase of ['seed', 'recover', 'reset-fails', 'reset-stalls']) {
    const result = spawnSync(electron, [__filename, phase, profile], { env, stdio: 'inherit', timeout: 45000 });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log(JSON.stringify({ success: true, checks: ['existing HTTP cache seeded', 'real compiled app startup', 'cache bypassed before UI', 'cache reset awaited before UI', 'settings and encrypted key preserved', 'caption and translation files preserved', 'localStorage and IndexedDB preserved', 'cookies preserved', 'reset failure still opens app', 'stalled reset cannot hold startup indefinitely'] }));
  process.exit(0);
}
const { app, BrowserWindow, session, safeStorage, globalShortcut } = electron;
const http = require('node:http');
const phase = process.argv[2], profile = path.resolve(process.argv[3]);
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..')); app.setName('Cache safety fixture');
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
const sentinelFiles = ['settings.json', 'caption-models/english-v1/encoder.onnx', 'translation-packs/en-es/model.bin', 'exported-session.md'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(profile, file))).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let window, resetCalls = 0, resetFinished = false, resetStarted = 0, requests = 0, server;
app.on('browser-window-created', (_event, created) => {
  window ??= created;
  created.setPosition(-20000, -20000); created.setFocusable(false); created.show = () => {}; created.showInactive = () => {};
  if (phase !== 'seed') assert.equal(resetFinished, true, 'Cache reset must complete before any app window');
});
const timeout = setTimeout(() => { console.error('Cache fixture timed out'); app.exit(1); }, 40000);
const ready = app.whenReady().then(async () => {
  const ses = session.defaultSession;
  const fetchImpl = ses.fetch.bind(ses);
  ses.fetch = (url, init) => { if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('Fixture allows localhost only'); return fetchImpl(url, init); };
  if (phase !== 'seed') {
    assert.equal(app.commandLine.hasSwitch('disable-http-cache'), true);
    const clear = ses.clearCache.bind(ses);
    ses.clearCache = async () => {
      resetCalls++;
      resetStarted = Date.now();
      await sleep(150);
      if (phase === 'reset-fails') { resetFinished = true; throw new Error('Synthetic reset failure'); }
      if (phase === 'reset-stalls') { resetFinished = true; return new Promise(() => {}); }
      await clear(); resetFinished = true;
    };
    ses.clearStorageData = async () => { throw new Error('Broad storage deletion is forbidden'); };
  }
});
if (phase !== 'seed') require(path.resolve(__dirname, '../out/main/index.js'));
ready.then(async () => {
  try {
    const ses = session.defaultSession;
    const saved = phase === 'seed' ? null : JSON.parse(fs.readFileSync(path.join(profile, 'fixture-state.json'), 'utf8'));
    server = http.createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' }); res.end('cacheable-fixture-'.repeat(6000)); });
    await new Promise(resolve => server.listen(saved?.port ?? 0, '127.0.0.1', resolve));
    const port = server.address().port, url = `http://127.0.0.1:${port}/cacheable`;
    if (phase === 'seed') {
      for (const file of sentinelFiles) { const target = path.join(profile, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture-preserved-data'); }
      const encryptedApiKey = safeStorage.encryptString('fixture-key-never-real').toString('base64');
      fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'lmstudio', jobs: [], profiles: [], encryptedApiKey }));
      await ses.cookies.set({ url: 'https://cache-fixture.invalid', name: 'preserve', value: 'fixture-cookie', expirationDate: Date.now() / 1000 + 86400 });
      window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await window.loadFile(path.resolve(__dirname, '../out/renderer/index.html'));
      await window.webContents.executeJavaScript(`(async()=>{ localStorage.setItem('cache-safety-fixture','preserved'); await new Promise((resolve,reject)=>{const request=indexedDB.open('cache-safety-fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('data');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('data','readwrite');tx.objectStore('data').put('preserved','key');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}})})()`);
      await (await ses.fetch(url)).text(); await (await ses.fetch(url, { cache: 'force-cache' })).text();
      assert.equal(requests, 1, 'Seeded profile must actually reuse cached response');
      assert.ok(await ses.getCacheSize() > 1000);
      ses.flushStorageData(); await ses.cookies.flushStore();
      fs.writeFileSync(path.join(profile, 'fixture-state.json'), JSON.stringify({ port, hashes: Object.fromEntries(sentinelFiles.map(file => [file, hash(file)])) }));
    } else {
      for (let i = 0; i < 500 && (!window || window.webContents.isLoading() || !window.webContents.getURL()); i++) await sleep(30);
      assert.ok(window && !window.webContents.isLoading(), 'App must finish loading');
      assert.equal(resetCalls, 1);
      if (phase === 'reset-stalls') assert.ok(Date.now() - resetStarted >= 3000 && Date.now() - resetStarted < 10000, 'Stalled reset must time out and open the UI');
      assert.ok(await window.webContents.executeJavaScript(`!!document.querySelector('.composer')`));
      for (const file of sentinelFiles) assert.equal(hash(file), saved.hashes[file], `${file} must be unchanged`);
      const settings = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
      assert.equal(safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64')), 'fixture-key-never-real');
      assert.equal(await window.webContents.executeJavaScript(`localStorage.getItem('cache-safety-fixture')`), 'preserved');
      assert.equal(await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const request=indexedDB.open('cache-safety-fixture',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,read=db.transaction('data').objectStore('data').get('key');read.onsuccess=()=>{resolve(read.result);db.close()};read.onerror=()=>reject(read.error)}})`), 'preserved');
      assert.equal((await ses.cookies.get({ name: 'preserve' }))[0]?.value, 'fixture-cookie');
      await (await ses.fetch(url, { cache: 'force-cache' })).text(); await (await ses.fetch(url, { cache: 'force-cache' })).text();
      assert.equal(requests, 2, 'Disabled cache must fetch fresh responses even with force-cache');
    }
    console.log(JSON.stringify({ phase, success: true, requests, resetCalls }));
    await new Promise(resolve => server.close(resolve)); clearTimeout(timeout);
    if (phase === 'seed') app.quit(); else app.exit(0);
  } catch (error) { console.error(error); server?.close(); clearTimeout(timeout); app.exit(1); }
});
