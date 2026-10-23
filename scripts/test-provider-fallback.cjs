// Real compiled renderer/IPC checks with isolated profiles and fixture providers.
// No real keys, hosted calls, or recording devices are used.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (typeof electron === 'string') {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'interview-provider-fallback-'));
  for (const scenario of ['success', 'none', 'exhausted', 'partial', 'openai', 'openai-stream', 'local', 'cancel', 'noncredit']) {
    const profile = path.join(root, scenario); fs.mkdirSync(profile);
    const profileId = randomUUID();
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ provider: scenario.startsWith('openai') ? 'openai' : 'openrouter', profiles: [{ id: profileId, name: 'Fixture candidate', details: 'PROFILE_PROOF: worked on queues.', resumeText: '', updatedAt: new Date().toISOString() }], activeProfileId: profileId, jobs: [], ...(['cancel', 'local'].includes(scenario) ? { lmStudio: { model: 'local-fixture', baseUrl: 'http://localhost:1234/v1' } } : {}) }));
    const env = { ...process.env, OPENROUTER_API_KEY: 'fixture-router-key', OPENROUTER_MODEL: 'fixture/router-model' };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'NANOGPT_API_KEY', 'OPENAI_MODEL', 'LMSTUDIO_MODEL']) delete env[name];
    if (!['none', 'openai', 'local'].includes(scenario)) env.NANOGPT_API_KEY = 'fixture-nano-key';
    if (scenario === 'success' || scenario.startsWith('openai')) env.OPENAI_API_KEY = 'fixture-openai-key';
    for (const phase of scenario === 'partial' ? ['exercise', 'reopen'] : ['exercise']) {
      const result = require('node:child_process').spawnSync(electron, [__filename, profile, scenario, phase], { env, stdio: 'inherit', timeout: 50000 });
      assert.equal(result.status, 0, scenario + '/' + phase + ' must finish cleanly');
    }
  }
  console.log(JSON.stringify({ success: true, root, checks: ['credit and in-flight failures use saved providers/models', 'OpenAI billing errors and bounded retries', 'same question/profile/images on every attempt', 'no alternative message and adding a saved key', 'all alternatives exhausted message', 'partial responses kept separate and saved across restart', 'default provider unchanged', 'Stop cancels fallback without starting a third provider', 'ordinary authentication errors do not switch', 'no hosted APIs or devices'] }));
  process.exit(0);
}
const { app, globalShortcut, session } = electron;
const profile = path.resolve(process.argv[2]), scenario = process.argv[3], phase = process.argv[4];
app.setPath('userData', profile); app.setAppPath(path.resolve(__dirname, '..'));
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
const calls = [], errors = [];
let window, completed = false, nanoStarted = false;
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created; window.setPosition(-20000, -20000); window.setFocusable(false); window.show = () => {}; window.showInactive = () => {}; window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
});
const sse = text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
const routerError = { code: 402, message: 'PRIVATE-ERROR fixture-router-key', metadata: { limit_source: 'openrouter_in_flight_budget' } };
async function fixtureFetch(url, init) {
  assert.equal(phase, 'exercise', 'Opening saved answers must not contact any provider');
  const host = new URL(String(url)).hostname;
  const provider = host === 'openrouter.ai' ? 'openrouter' : host === 'api.openai.com' ? 'openai' : host === 'nano-gpt.com' ? 'nanogpt' : 'lmstudio';
  const body = JSON.parse(init.body); calls.push({ provider, body });
  const text = provider === 'openai' ? body.input[0].content[0].text : typeof body.messages[1].content === 'string' ? body.messages[1].content : body.messages[1].content[0].text;
  assert.match(text, /PROFILE_PROOF/); assert.match(text, /Explain queue reliability/);
  const images = provider === 'openai' ? body.input[0].content.filter(part => part.type === 'input_image') : typeof body.messages[1].content === 'string' ? [] : body.messages[1].content.filter(part => part.type === 'image_url');
  assert.equal(images.length, 1, 'Every attempt keeps the original screenshot');
  if (provider === 'lmstudio') {
    assert.equal(scenario, 'local', 'Local fallback must never start after Stop'); assert.equal(body.model, 'local-fixture');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    return new Response(sse('Complete answer from LM Studio.') + 'data: [DONE]\n\n');
  }
  if (provider === 'openai') {
    if (scenario === 'openai-stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Original partial answer from OpenAI."}\n\n'));
      setTimeout(() => { controller.enqueue(new TextEncoder().encode('event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"credit_balance_exhausted","message":"PRIVATE-ERROR"}}}\n\n')); controller.close(); }, 150);
    } }));
    return Response.json({ error: { code: 'credit_balance_exhausted', type: 'insufficient_quota', message: 'PRIVATE-ERROR fixture-openai-key' } }, { status: 429 });
  }
  if (provider === 'openrouter') {
    assert.equal(body.model, 'fixture/router-model');
    if (scenario === 'openai') return new Response(sse('Complete answer from OpenRouter.') + 'data: [DONE]\n\n');
    if (scenario === 'noncredit') return Response.json({ error: { code: 'invalid_api_key', message: 'PRIVATE-ERROR' } }, { status: 401 });
    if (scenario === 'partial') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse('Original partial answer from OpenRouter.')));
      setTimeout(() => { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ error: routerError }) + '\n\n')); controller.close(); }, 150);
    } }));
    return Response.json({ error: routerError }, { status: 402 });
  }
  nanoStarted = true;
  if (scenario === 'exhausted') return Response.json({ error: { message: 'PRIVATE-ERROR fixture-nano-key' } }, { status: 503 });
  if (scenario === 'cancel') return new Promise((_resolve, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
  return new Response(sse('Complete answer from NanoGPT.') + 'data: [DONE]\n\n');
}
global.fetch = fixtureFetch;
app.whenReady().then(() => { session.defaultSession.fetch = fixtureFetch; });
app.on('will-quit', () => { assert.equal(completed, true); assert.deepEqual(errors, []); console.log(JSON.stringify({ scenario, phase, success: true, providers: calls.map(call => call.provider) })); });
require(path.resolve(__dirname, '../out/main/index.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let n = 0; n < 700; n++) { if (await check()) return; await sleep(25); } throw new Error('Timed out: ' + label); }
app.whenReady().then(async () => {
  try {
    await until(() => window && !window.webContents.isLoading(), 'renderer');
    const js = code => window.webContents.executeJavaScript(code, true);
    const click = async label => { await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing/disabled '+${JSON.stringify(label)});b.click()})()`); await sleep(60); };
    await until(() => js(`!!document.querySelector('.composer textarea')&&!document.querySelector('.composer textarea').disabled`), 'composer');
    if (phase === 'reopen') {
      await js(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Conversation history')).click();void 0`);
      await until(() => js(`!!document.querySelector('.library-open')`), 'history'); await js(`document.querySelector('.library-open').click();void 0`);
      await until(() => js(`!!document.querySelector('.answer-previous')`), 'saved partial');
      assert.match(await js(`document.querySelector('.answer-markdown').textContent`), /Complete answer from NanoGPT/);
      assert.match(await js(`document.querySelector('.answer-previous').textContent`), /Original partial answer/);
      assert.match(await js(`document.querySelector('.answer-provider').textContent`), /NanoGPT/);
      assert.equal(calls.length, 0);
    } else {
      await until(async () => (await js(`window.studio.listProfiles()`)).profiles.length === 1, 'profile loaded');
      await js(`(()=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0)),data=new DataTransfer();data.items.add(new File([bytes],'reference.png',{type:'image/png'}));document.querySelector('.app').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}))})()`);
      await until(() => js(`document.querySelectorAll('.attachment-item').length===1`), 'image');
      await js(`(()=>{const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Explain queue reliability.');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await sleep(50); await click('Send question');
      if (scenario === 'none') {
        await until(() => js(`document.querySelector('.answer-error')?.textContent.includes('No other saved provider is configured')`), 'missing-provider notice');
        assert.deepEqual(calls.map(call => call.provider), ['openrouter'], 'Default unsaved LM Studio must not become a fallback');
        await js(`window.studio.configureProvider({provider:'nanogpt',apiKey:'fixture-nano-key',model:'fixture/nano-saved-model'})`);
        await click('Retry answer');
      }
      if (scenario === 'exhausted' || scenario === 'noncredit') {
        await until(() => js(`!!document.querySelector('.generated-answer.error')`), 'failure message');
        const text = await js(`document.querySelector('.answer-error').textContent`);
        assert.match(text, scenario === 'exhausted' ? /No saved provider could complete this answer/ : /401/);
        assert.equal(calls.length, scenario === 'exhausted' ? 2 : 1);
      } else if (scenario === 'cancel') {
        await until(() => nanoStarted, 'pending fallback');
        await until(() => js(`document.querySelector('.answer-fallback')?.textContent.includes('NanoGPT')`), 'visible pending fallback status');
        await click('Stop answer'); await until(() => js(`document.querySelector('.answer-label')?.textContent.includes('partial answer')`), 'stopped');
        assert.deepEqual(calls.map(call => call.provider), ['openrouter', 'nanogpt']);
      } else {
        const expected = scenario === 'openai' ? 'OpenRouter' : scenario === 'local' ? 'LM Studio' : 'NanoGPT';
        await until(() => js(`document.querySelector('.answer-markdown')?.textContent.includes('Complete answer from ${expected}')&&!document.querySelector('.coach-thinking')`), 'successful fallback');
        assert.match(await js(`document.querySelector('.answer-provider').textContent`), new RegExp(expected));
        assert.equal(await js(`!!document.querySelector('.generated-answer.error')`), false);
        if (scenario === 'success') assert.deepEqual(calls.map(call => call.provider), ['openrouter', 'openai', 'nanogpt']);
        if (scenario === 'openai') assert.deepEqual(calls.map(call => call.provider), ['openai', 'openrouter']);
        if (scenario === 'local') assert.deepEqual(calls.map(call => call.provider), ['openrouter', 'lmstudio']);
        if (scenario === 'openai-stream') {
          assert.deepEqual(calls.map(call => call.provider), ['openai', 'nanogpt']);
          assert.match(await js(`document.querySelector('.answer-previous').textContent`), /Original partial answer from OpenAI/);
          assert.doesNotMatch(await js(`document.querySelector('.answer-markdown').textContent`), /Original partial/);
        }
        if (scenario === 'partial') {
          assert.doesNotMatch(await js(`document.querySelector('.answer-markdown').textContent`), /Original partial/);
          assert.match(await js(`document.querySelector('.answer-previous').textContent`), /Original partial answer from OpenRouter/);
          assert.equal(calls.length, 2);
        }
      }
      assert.equal((await js(`window.studio.getSettings()`)).provider, scenario.startsWith('openai') ? 'openai' : 'openrouter', 'Saved preferred provider is unchanged');
      assert.doesNotMatch(await js(`document.querySelector('.question-thread').textContent`), /PRIVATE-ERROR|fixture-router-key|fixture-nano-key|fixture-openai-key/);
    }
    completed = true; window.close();
  } catch (error) {
    console.error(error); console.error({ scenario, phase, errors, providers: calls.map(call => call.provider) });
    if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(`document.querySelector('.question-thread')?.textContent`)); app.exit(1);
  }
});
setTimeout(() => { console.error('Provider fallback QA timed out'); app.exit(1); }, 45000);
