// Compiled desktop QA with a disposable profile and synthetic OpenRouter replies.
// No real API credentials, hosted requests, or recording devices are used.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-openrouter-budget-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'openrouter', profiles: [], jobs: [] }));
  const env = { ...process.env, OPENROUTER_API_KEY: 'fixture-openrouter-key', OPENROUTER_MODEL: 'fixture/model' };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'NANOGPT_API_KEY']) delete env[name];
  const result = require('node:child_process').spawnSync(electron, [__filename, profile], { env, stdio: 'inherit', timeout: 60000 });
  assert.equal(result.status, 0, 'Desktop credit recovery must complete cleanly');
  const saved = fs.readdirSync(path.join(profile, 'conversations')).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(profile, 'conversations', name), 'utf8')));
  const conversation = saved.find(item => item.threads.length === 6);
  assert.ok(conversation, 'All six question outcomes must be saved together');
  assert.deepEqual(conversation.threads.map(thread => thread.exchanges[0].status), ['ready', 'error', 'error', 'error', 'error', 'error']);
  assert.match(conversation.threads[4].exchanges[0].answer, /Partial answer remains available/);
  assert.doesNotMatch(JSON.stringify(conversation), /PRIVATE-ERROR|fixture-openrouter-key|remedy_hint|limit_source/);
  console.log(JSON.stringify({ success: true, profile, checks: ['2200/2151 recovery', 'one bounded retry', 'key cap and in-flight limits', 'HTTP 200 errors never replayed', 'partial answer retained', 'safe IPC and persisted errors', 'no hosted requests'] }));
  process.exit(0);
}
const { app, globalShortcut, session } = electron;
const profile = path.resolve(process.argv[2]);
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let window, completed = false;
const requests = new Map(), rendererErrors = [];
app.on('browser-window-created', (_event, created) => {
  if (window) return;
  window = created; window.setPosition(-20000, -20000); window.setFocusable(false);
  window.show = () => {}; window.showInactive = () => {}; window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
});
const errorBody = source => ({ error: { code: 402, message: 'PRIVATE-ERROR fixture-openrouter-key: You requested up to 2200 tokens, but can only afford 2151.', metadata: { limit_source: source, remedy_hint: 'PRIVATE-ERROR' } } });
app.whenReady().then(() => {
  session.defaultSession.fetch = async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-openrouter-key');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body), text = body.messages[1].content;
    assert.equal(body.model, 'fixture/model');
    const scenario = ['recovery', 'exhausted', 'keycap', 'inflight', 'partial', 'streamerror'].find(name => text.includes('Scenario ' + name));
    assert.ok(scenario, 'Only expected QA questions may call the provider');
    const calls = requests.get(scenario) || []; calls.push(body); requests.set(scenario, calls);
    assert.ok(calls.length <= 2, 'Automatic retries must remain bounded');
    if (['recovery', 'exhausted', 'keycap', 'inflight'].includes(scenario)) {
      if (scenario !== 'recovery' || calls.length === 1) return Response.json(errorBody(scenario === 'keycap' ? 'openrouter_key_limit' : scenario === 'inflight' ? 'openrouter_in_flight_budget' : 'openrouter_credits'), { status: 402 });
      assert.deepEqual(body, { ...calls[0], max_tokens: 1935 });
      return new Response('data: {"choices":[{"delta":{"content":"Recovered answer with a smaller output budget."}}]}\n\ndata: [DONE]\n\n');
    }
    return new Response(new ReadableStream({ start(controller) {
      const encoder = new TextEncoder();
      if (scenario === 'partial') controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Partial answer remains available."}}]}\n\n'));
      controller.enqueue(encoder.encode('data: ' + JSON.stringify(errorBody('openrouter_credits')) + '\n\n'));
      controller.close();
    } }));
  };
});
app.on('will-quit', () => { assert.equal(completed, true); assert.deepEqual(rendererErrors, []); });
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let n = 0; n < 500; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    await until(() => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`), 'composer');
    const click = async label => { await js(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing '+${JSON.stringify(label)});button.click()})()`); await sleep(50); };
    for (const [n, scenario] of ['recovery', 'exhausted', 'keycap', 'inflight', 'partial', 'streamerror'].entries()) {
      if (n) await click('New question');
      await js(`(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify('Scenario ' + scenario)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await sleep(50); await click('Send question');
      await until(() => js(scenario === 'recovery' ? `document.querySelector('.answer-markdown')?.textContent.includes('Recovered answer')&&!document.querySelector('button[aria-label="Stop answer"]')` : `!!document.querySelector('.generated-answer.error')`), scenario + ' outcome');
      const text = await js(`document.querySelector('.generated-answer').textContent`);
      if (scenario === 'recovery') assert.match(text, /Recovered answer/);
      else if (scenario === 'keycap') assert.match(text, /API key spending limit/);
      else if (scenario === 'inflight') assert.match(text, /still processing or settling/);
      else assert.match(text, /Check the selected provider's credit settings/);
      if (scenario === 'partial') assert.match(text, /Partial answer remains available/);
      assert.doesNotMatch(text, /PRIVATE-ERROR|fixture-openrouter-key|remedy_hint|limit_source/);
      assert.equal(requests.get(scenario).length, ['recovery', 'exhausted'].includes(scenario) ? 2 : 1);
    }
    completed = true; window.close();
  } catch (error) {
    console.error(error); console.error({ rendererErrors, requests: [...requests].map(([scenario, calls]) => ({ scenario, budgets: calls.map(body => body.max_tokens) })) });
    if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(`document.querySelector('.question-thread')?.textContent`));
    app.exit(1);
  }
});
setTimeout(() => { console.error('OpenRouter credit QA timed out'); app.exit(1); }, 55000);
