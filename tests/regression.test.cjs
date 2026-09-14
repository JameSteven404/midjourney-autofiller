const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.MJ_TEST_SOURCE || path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });

function content() {
  const messages = [];
  const context = vm.createContext({ console, URL, structuredClone, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {}, document: {},
    chrome: { runtime: { onMessage: event(), sendMessage(message, cb) {
      messages.push(message); cb?.([]); return Promise.resolve({ ok: true });
    } } } });
  vm.runInContext(source('content-scripts/midjourney.js'), context);
  return { context, messages };
}

async function background(initial = {}) {
  let stored = { items: [], logs: [], downloads: {}, ...initial };
  const messages = [], calls = [], files = new Map();
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: { get: async () => ({ paf_state: structuredClone(stored) }),
      set: async data => { stored = structuredClone(data.paf_state); } } },
    runtime: { onMessage: event(), sendMessage: async message => { messages.push(message); } },
    tabs: { sendMessage(id, message, cb) { calls.push(message); cb({ ok: true, submitted: true }); },
      query: async () => [{ id: 7, url: 'https://www.midjourney.com/imagine' }] },
    scripting: { executeScript: async () => {} },
    downloads: { onChanged: event(), async download(options) {
      const id = files.size + 1;
      files.set(id, { id, state: 'in_progress', ...options }); return id;
    }, search: async ({ id }) => files.has(id) ? [files.get(id)] : [] }
  };
  const context = vm.createContext({ console, URL, structuredClone, setTimeout, clearTimeout, chrome });
  vm.runInContext(source('background.js'), context);
  await vm.runInContext('typeof startupReady === "undefined" ? Promise.resolve() : startupReady', context);
  return { context, chrome, files, messages, calls, state: () => stored,
    message(msg, sender = {}) { return new Promise(resolve => chrome.runtime.onMessage.listeners[0](msg, sender, resolve)); } };
}

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('download result preserves every CDN image when PNG conversion fails', async () => {
  const { context: c, messages } = content();
  c.getGridImageUrls = () => ['https://cdn.midjourney.com/a/0_0.webp', 'https://cdn.midjourney.com/a/0_1.webp'];
  c.convertUrlsToPngBlobUrls = async () => [];
  await c.reportJobDone('one', {});
  assert.equal(messages.at(-1).mediaUrls.length, 2);
  assert.match(messages.at(-1).mediaUrls[0], /^https:/);
});

test('queue full after click is detected even when composer does not clear', async () => {
  const { context: c } = content();
  let clicked = false;
  c.findPromptTextarea = () => ({ focus() {} });
  c.ensureDefaultSettings = async () => ({ ok: true });
  c.setNativeValue = () => {};
  c.sleep = async () => {};
  c.getAllMediaGrids = () => [];
  c.findSubmitButton = () => ({ click() { clicked = true; } });
  c.waitForPromptToClear = async () => false;
  c.findErrorBanner = () => clicked ? 'Queue is full' : null;
  assert.equal((await c.fillAndSubmit('test', 'one', {})).rateLimited, true);
});

test('existing page limit stops before entering or clicking another prompt', async () => {
  const { context: c } = content();
  c.findErrorBanner = () => 'Too many prompts';
  c.findPromptTextarea = () => { throw new Error('Should never access composer'); };
  const result = await c.fillAndSubmit('test', 'one', {});
  assert.equal(result.rateLimited, true);
  assert.equal(result.notSubmitted, true);
});

test('generation timeout must not be reported as success', () => {
  const { context: c, messages } = content();
  c.findErrorBanner = () => null;
  c.findGridForText = () => null;
  vm.runInContext('pendingJobs.set("one", { text: "test", startedAt: 0 }); checkPendingJobs()', c);
  assert.equal(messages.at(-1).ok, false);
});

test('a page limit does not discard already submitted jobs', () => {
  const { context: c, messages } = content();
  c.findErrorBanner = () => 'Queue is full';
  c.findGridForText = () => null;
  vm.runInContext('pendingJobs.set("one", { text: "test", startedAt: Date.now() }); checkPendingJobs()', c);
  assert.equal(vm.runInContext('pendingJobs.size', c), 1);
  assert.equal(messages.at(-1).type, 'MJ_PAGE_BLOCKED');
});

test('similar prompts and historical grids cannot be selected for download', () => {
  const { context: c } = content();
  const old = { text: 'test prompt', key: 'old' };
  const near = { text: 'test prompt with a different subject', key: 'near' };
  const fresh = { text: 'test prompt', key: 'fresh' };
  c.getAllMediaGrids = () => [old, near];
  c.getPromptTextForGrid = grid => grid.text;
  c.gridKey = grid => grid.key;
  assert.equal(c.findGridForText('test prompt', { excludedKeys: ['old'] }), null);
  c.getAllMediaGrids = () => [old, near, fresh];
  assert.equal(c.findGridForText('test prompt', { excludedKeys: ['old'] }), fresh);
});

test('download is not complete at acceptance; extension matches source bytes format', async () => {
  const b = await background();
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.webp'], 'test', 'folder', 'one');
  assert.equal(b.files.get(1).filename, 'folder/one_test_1.webp');
  assert.equal(b.state().downloads[1].status, 'downloading');
  assert.equal(b.state().logs.some(log => /Đã tải xong/.test(log.message)), false);
  b.files.get(1).state = 'complete';
  b.chrome.downloads.onChanged.listeners[0]({ id: 1, state: { current: 'complete' } });
  await until(() => b.state().downloads[1].status === 'complete');
});

test('interrupted download can be retried without duplicating successful files', async () => {
  const b = await background();
  const urls = ['https://cdn.midjourney.com/a/0_0.png', 'https://cdn.midjourney.com/a/0_1.webp'];
  await b.context.downloadMedia(urls, 'test', '', 'one');
  Object.assign(b.files.get(1), { state: 'complete' });
  Object.assign(b.files.get(2), { state: 'interrupted', error: 'NETWORK_FAILED' });
  await b.context.recordDownloadStatus(1);
  await b.context.recordDownloadStatus(2);
  await b.context.downloadMedia(urls, 'test', '', 'one');
  assert.equal(b.files.size, 3);
  assert.equal(b.files.get(3).url, urls[1]);
});

test('very fast completion is recovered by search after download registration', async () => {
  const b = await background();
  b.chrome.downloads.download = async options => {
    b.files.set(1, { id: 1, state: 'complete', ...options });
    b.chrome.downloads.onChanged.listeners[0]({ id: 1, state: { current: 'complete' } });
    return 1;
  };
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.png'], 'test', '', 'one');
  assert.equal(b.state().downloads[1].status, 'complete');
});

test('continuous mode waits for the in-flight limit before submitting', async () => {
  const b = await background({ tabId: 7, continuousMode: true, maxInFlight: 1, items: [
    { id: 'one', text: 'first', status: 'generating', tabId: 7 },
    { id: 'two', text: 'second', status: 'pending' }
  ] });
  const running = b.context.runQueue();
  await until(() => b.state().logs.some(log => /chờ chỗ trống/.test(log.message)));
  assert.equal(b.calls.length, 0);
  await b.context.handleJobResult({ requestId: 'one', ok: true }, { tab: { id: 7 } });
  await running;
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].requestId, 'two');
});

test('limit pauses queue and keeps unsubmitted prompts pending', async () => {
  const b = await background({ tabId: 7, continuousMode: true, items: [
    { id: 'one', text: 'first', status: 'pending' }, { id: 'two', text: 'second', status: 'pending' }
  ] });
  b.chrome.tabs.sendMessage = (id, msg, cb) => { b.calls.push(msg); cb({ ok: false, rateLimited: true, notSubmitted: true, note: 'Queue is full' }); };
  await b.context.runQueue();
  assert.equal(b.calls.length, 1);
  assert.equal(b.state().paused, true);
  assert.equal(b.state().items.every(item => item.status === 'pending'), true);
});

test('STOP while submit is outstanding never requeues that prompt', async () => {
  const b = await background({ tabId: 7, continuousMode: true, items: [{ id: 'one', text: 'first', status: 'pending' }] });
  let finish;
  b.chrome.tabs.sendMessage = (id, msg, cb) => { finish = cb; b.calls.push(msg); };
  const running = b.context.runQueue();
  await until(() => finish);
  await b.message({ type: 'STOP' });
  assert.equal(b.state().items[0].status, 'running');
  finish({ ok: true, submitted: true });
  await running;
  assert.equal(b.state().items[0].status, 'generating');
  assert.equal(b.calls.length, 1);
});

test('async result is not overwritten by submit acknowledgement', async () => {
  const b = await background({ tabId: 7, continuousMode: true, items: [{ id: 'one', text: 'first', status: 'pending' }] });
  let finish;
  b.chrome.tabs.sendMessage = (id, msg, cb) => { finish = cb; };
  const running = b.context.runQueue();
  await until(() => finish);
  await b.context.handleJobResult({ requestId: 'one', ok: true }, { tab: { id: 7 } });
  finish({ ok: true, submitted: true });
  await running;
  assert.equal(b.state().items[0].status, 'done');
});

test('concurrent state updates retain both completion and settings', async () => {
  const b = await background({ items: [{ id: 'one', text: 'first', status: 'generating' }] });
  await Promise.all([b.context.handleJobResult({ requestId: 'one', ok: true }),
    b.context.setState({ maxInFlight: 2 }), b.context.log('info', 'test')]);
  assert.equal(b.state().items[0].status, 'done');
  assert.equal(b.state().maxInFlight, 2);
  assert.equal(b.state().logs.length, 2);
});

test('restart keeps unconfirmed submit in review instead of submitting twice', async () => {
  const b = await background({ running: true, items: [{ id: 'one', status: 'running', text: 'first' }] });
  assert.equal(b.state().running, false);
  assert.equal(b.state().paused, true);
  assert.equal(b.state().items[0].status, 'review');
});

test('review blocks further prompts even when configured limit has free slots', async () => {
  const b = await background({ tabId: 7, maxInFlight: 10, items: [
    { id: 'one', text: 'first', status: 'review' }, { id: 'two', text: 'second', status: 'pending' }
  ] });
  await b.context.runQueue();
  assert.equal(b.calls.length, 0);
  assert.equal(b.state().paused, true);
});

test('parallel START calls cannot submit a prompt twice', async () => {
  const b = await background({ tabId: 7, continuousMode: true, items: [{ id: 'one', text: 'first', status: 'pending' }] });
  await Promise.all([b.context.runQueue(), b.context.runQueue()]);
  assert.equal(b.calls.length, 1);
});

test('failed initiation keeps the failed URL and still downloads remaining images', async () => {
  const b = await background();
  const download = b.chrome.downloads.download;
  b.chrome.downloads.download = async options => {
    if (options.url.endsWith('0_0.png')) throw new Error('NETWORK_FAILED');
    return download(options);
  };
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.png', 'https://cdn.midjourney.com/a/0_1.png'], 'test', '', 'one');
  assert.equal(b.files.size, 1);
  const failed = Object.values(b.state().downloads).find(record => record.status === 'interrupted');
  assert.match(failed.url, /0_0.png$/);
  assert.equal(failed.error, 'NETWORK_FAILED');
});

test('interrupted registration is reconciled with actual Chrome download history', async () => {
  const b = await background();
  const record = { requestId: 'one', url: 'https://cdn.midjourney.com/a/0_0.png', filename: 'one_test_1.png', status: 'starting', startedAt: Date.now() };
  await b.context.setState({ downloads: { intent: record } });
  const file = { id: 12, url: record.url, filename: 'C:/Downloads/' + record.filename, startTime: new Date().toISOString(), state: 'complete' };
  b.chrome.downloads.search = async () => [file];
  await b.context.reconcileDownloadIntent('intent', record);
  assert.equal(b.state().downloads.intent, undefined);
  assert.equal(b.state().downloads[12].status, 'complete');
});
