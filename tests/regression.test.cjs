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
    setInterval: () => 1, clearInterval() {}, document: { querySelectorAll: () => [] },
    chrome: { runtime: { onMessage: event(), sendMessage(message, cb) {
      messages.push(message); cb?.([]); return Promise.resolve({ ok: true });
    } } } });
  vm.runInContext(source('content-scripts/midjourney.js'), context);
  return { context, messages };
}

async function background(initial = {}) {
  let stored = { items: [], logs: [], downloads: {}, inputMode: 'dom', ...initial };
  const messages = [], calls = [], files = new Map();
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: { get: async () => ({ paf_state: structuredClone(stored) }),
      set: async data => { stored = structuredClone(data.paf_state); } } },
    runtime: { onMessage: event(), sendMessage: async message => { messages.push(message); } },
    tabs: { onUpdated: event(), onRemoved: event(), sendMessage(id, message, cb) { calls.push(message); cb({ ok: true, submitted: true }); },
      get: async id => ({ id, url: 'https://www.midjourney.com/imagine' }),
      query: async () => [{ id: 7, url: 'https://www.midjourney.com/imagine' }],
      setZoom: async () => {} },
    debugger: { onDetach: event(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ result: { value: true } }) },
    scripting: { executeScript: async () => {} },
    downloads: { onChanged: event(), onDeterminingFilename: event(), async download(options) {
      const id = files.size + 1;
      files.set(id, { id, state: 'in_progress', ...options }); return id;
    }, search: async ({ id }) => files.has(id) ? [files.get(id)] : [] }
  };
  const context = vm.createContext({ console, URL, structuredClone, setTimeout, clearTimeout, chrome });
  context.importScripts = file => vm.runInContext(source(file), context);
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

test('diagnoseNoMatch names exactly which assumption about the Midjourney page is failing', () => {
  const { context: c } = content();
  assert.match(c.diagnoseNoMatch('test', []), /Không tìm thấy lưới/);
  assert.match(c.diagnoseNoMatch('test', [{ text: '' }, { text: '' }]), /không đọc được nội dung prompt/);
  assert.match(c.diagnoseNoMatch('test prompt', [{ text: 'a different prompt' }]), /không cái nào khớp/);
  assert.match(c.diagnoseNoMatch('test prompt', [{ text: 'test prompt' }]), /chưa được tool coi là tải xong/);
});

test('promptMatchScore accepts Midjourney truncating the displayed prompt, never the reverse', () => {
  const { context: c } = content();
  const full = 'a'.repeat(50) + ' the rest of a very long sop prompt that midjourney truncates in the grid row';
  assert.equal(c.promptMatchScore(full, full), 1000);
  assert.equal(c.promptMatchScore(full, full.slice(0, 45) + '...'), 500);
  assert.equal(c.promptMatchScore(full, full.slice(0, 45) + '…'), 500);
  // A short submitted prompt must never "match" an unrelated long candidate
  // just because it happens to start with the same short text — only the
  // page's displayed text may be a truncated prefix of what was submitted,
  // not the other way around.
  assert.equal(c.promptMatchScore('a cat', 'a cat sitting on a mat in a sunny garden full of flowers and trees'), 0);
  assert.equal(c.promptMatchScore('short prompt', 'short prompt but this is actually a completely different job'), 0);
});

test('normalizePromptText strips the --ar/--seed parameter tail before comparing', () => {
  const { context: c } = content();
  const submitted = c.normalizePromptText('A caveman hunting mammoths --ar 16:9 --seed 52000101');
  const displayed = c.normalizePromptText('A caveman hunting mammoths');
  assert.equal(submitted, displayed);
});

test('normalizePromptText matches an en/em dash mid-sentence against a plain hyphen (Midjourney redisplay)', () => {
  const { context: c } = content();
  const submitted = c.normalizePromptText('approximately 60000–40000 years ago: a caveman --ar 16:9 --seed 1');
  const displayedAsHyphen = c.normalizePromptText('approximately 60000-40000 years ago: a caveman');
  assert.equal(submitted, displayedAsHyphen);
});

test('a stalled job is warned about once after 90s, not spammed every tick', () => {
  const { context: c, messages } = content();
  c.findErrorBanner = () => null;
  c.getAllMediaGrids = () => [];
  vm.runInContext('pendingJobs.set("one", { text: "test", startedAt: Date.now() - 91000 }); checkPendingJobs()', c);
  let warnings = messages.filter(m => m.type === 'MJ_JOB_STALL_WARNING');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].note, /Không tìm thấy lưới/);
  vm.runInContext('checkPendingJobs()', c);
  warnings = messages.filter(m => m.type === 'MJ_JOB_STALL_WARNING');
  assert.equal(warnings.length, 1);
});

test('download is not complete at acceptance; extension matches source bytes format', async () => {
  const b = await background();
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.webp'], 'test', 'folder', 'one', Date.now(), 7, '{index}_{n}');
  assert.equal(b.files.get(1).filename, 'folder/007_1.webp');
  assert.equal(b.state().downloads[1].status, 'downloading');
  assert.equal(b.state().logs.some(log => /Đã tải xong/.test(log.message)), false);
  b.files.get(1).state = 'complete';
  b.chrome.downloads.onChanged.listeners[0]({ id: 1, state: { current: 'complete' } });
  await until(() => b.state().downloads[1].status === 'complete');
});

test('filename is reasserted during determination, not only suggested at download', async () => {
  const b = await background();
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.webp'], 'test', 'out', 'one', Date.now(), 2, '{index}_{n}');
  const listener = b.chrome.downloads.onDeterminingFilename.listeners[0];
  assert.ok(listener, 'phải đăng ký onDeterminingFilename, nếu không extension khác sẽ ghi đè tên');
  let suggested = null;
  listener({ id: 1, url: 'https://cdn.midjourney.com/a/0_0.webp', filename: '0_0.webp' }, s => { suggested = s; });
  assert.equal(suggested.filename, 'out/002_1.webp');
});

test('determination leaves unrelated downloads to the browser', async () => {
  const b = await background();
  let called = 'none';
  b.chrome.downloads.onDeterminingFilename.listeners[0](
    { id: 9, url: 'https://example.com/other.zip', filename: 'other.zip' },
    s => { called = s === undefined ? 'default' : s; });
  await until(() => called !== 'none');
  assert.equal(called, 'default');
});

test('SOP numbering follows queue order and survives removals', async () => {
  const b = await background();
  await b.message({ type: 'APPEND_ITEMS', items: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }, { id: 'c', text: 'three' }] });
  assert.deepEqual(b.state().items.map(it => it.orderIndex), [1, 2, 3]);
  await b.message({ type: 'REMOVE_ITEM', id: 'b' });
  await b.message({ type: 'APPEND_ITEMS', items: [{ id: 'd', text: 'four' }] });
  // 'c' giữ số 3 dù 'b' đã bị xoá; mục mới nối tiếp số lớn nhất, không tái sử dụng số cũ.
  assert.deepEqual(b.state().items.map(it => [it.id, it.orderIndex]), [['a', 1], ['c', 3], ['d', 4]]);
});

test('each image of one prompt keeps the prompt number with its own image index', async () => {
  const b = await background();
  const urls = [0, 1, 2, 3].map(i => `https://cdn.midjourney.com/a/0_${i}.webp`);
  await b.context.downloadMedia(urls, 'test', '', 'one', Date.now(), 12, '{index}_{n}');
  assert.deepEqual([1, 2, 3, 4].map(id => b.files.get(id).filename),
    ['012_1.webp', '012_2.webp', '012_3.webp', '012_4.webp']);
});

const SOP_PROMPT = 'A single cinematic documentary reconstruction in a non-site-specific western Eurasian landscape, '
  + 'Late Pleistocene, approximately 60000–40000 years ago: A small Neanderthal group shelters beneath limestone '
  + 'while sleet closes the valley.; no text, no captions, no logos --ar 16:9 --seed 52000101';

test('seed is taken from the --seed parameter inside the prompt', async () => {
  const b = await background();
  const urls = [0, 1].map(i => `https://cdn.midjourney.com/a/0_${i}.webp`);
  await b.context.downloadMedia(urls, SOP_PROMPT, '', 'one', Date.now(), 1, '{index}_{seed}_{n}');
  assert.deepEqual([1, 2].map(id => b.files.get(id).filename),
    ['001_52000101_1.webp', '001_52000101_2.webp']);
});

test('prompt without a seed collapses the empty slot instead of leaving a stray separator', async () => {
  const b = await background();
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.webp'], 'a caveman --ar 16:9', '', 'one', Date.now(), 3, '{index}_{seed}_{n}');
  assert.equal(b.files.get(1).filename, '003_1.webp');
});

test('{prompt} drops Midjourney parameter flags', async () => {
  const b = await background();
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.webp'], 'a bearded caveman --ar 16:9 --seed 7', '', 'one', Date.now(), 1, '{prompt}_{seed}');
  assert.equal(b.files.get(1).filename, 'a_bearded_caveman_7.webp');
});

test('{prompt} also drops a single-dash parameter tail (Excel/Word autocorrect shrinks -- to one dash)', async () => {
  const b = await background();
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.webp'], 'a bearded caveman –seed 7', '', 'one', Date.now(), 1, '{prompt}_{seed}');
  assert.equal(b.files.get(1).filename, 'a_bearded_caveman_7.webp');
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

test('a resumable interrupted download is resumed instead of given up on, and later completion is not ignored', async () => {
  const b = await background();
  await b.context.downloadMedia(['https://cdn.midjourney.com/a/0_0.webp'], 'test', '', 'one', Date.now(), 1, '{index}_{n}');
  let resumeCalls = 0;
  b.chrome.downloads.resume = async () => { resumeCalls++; };
  Object.assign(b.files.get(1), { state: 'interrupted', canResume: true, error: 'NETWORK_TIMEOUT' });
  await b.context.recordDownloadStatus(1);
  assert.equal(resumeCalls, 1);
  assert.equal(b.state().downloads[1].status, 'downloading');
  Object.assign(b.files.get(1), { state: 'complete' });
  await b.context.recordDownloadStatus(1);
  assert.equal(b.state().downloads[1].status, 'complete');
});

test('retrying a failed image clears its old interrupted record instead of leaving it alongside the new attempt', async () => {
  const b = await background();
  const url = 'https://cdn.midjourney.com/a/0_0.png';
  await b.context.setState({ downloads: { 99: { requestId: 'one', sourceUrl: url, url, filename: 'old.png', status: 'interrupted', error: 'NETWORK_FAILED' } } });
  await b.context.downloadMedia([url], 'test', '', 'one', Date.now(), 1, '{index}_{n}');
  const records = Object.values(b.state().downloads);
  assert.equal(records.some(r => r.status === 'interrupted'), false);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'downloading');
});

test('reconcileDownloadIntent retries before giving up on a download not yet indexed by Chrome', async () => {
  const b = await background();
  b.context.sleep = async () => {};
  const record = { requestId: 'one', url: 'https://cdn.midjourney.com/a/0_0.png', filename: 'one_test_1.png', status: 'starting', startedAt: Date.now() };
  await b.context.setState({ downloads: { intent: record } });
  let calls = 0;
  const file = { id: 12, url: record.url, filename: 'C:/Downloads/' + record.filename, startTime: new Date().toISOString(), state: 'complete' };
  // Chỉ đếm lượt search theo url (của reconcileDownloadIntent) — recordDownloadStatus
  // gọi lại search theo id ngay sau khi khớp, không liên quan tới số lần thử ở đây.
  b.chrome.downloads.search = async (query) => {
    if (!query.url) return [file];
    calls++;
    return calls < 3 ? [] : [file];
  };
  await b.context.reconcileDownloadIntent('intent', record);
  assert.equal(calls, 3);
  assert.equal(b.state().downloads.intent, undefined);
  assert.equal(b.state().downloads[12].status, 'complete');
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

test('a stall warning only logs a diagnostic; it never touches item status or pauses the queue', async () => {
  const b = await background({ tabId: 7,
    items: [{ id: 'one', text: 'a caveman prompt', status: 'generating', tabId: 7 }] });
  b.chrome.runtime.onMessage.listeners[0](
    { type: 'MJ_JOB_STALL_WARNING', requestId: 'one', note: 'ly do chan doan test' },
    { tab: { id: 7 } }, () => {});
  await until(() => b.state().logs.some(l => /ly do chan doan test/.test(l.message)));
  assert.equal(b.state().items[0].status, 'generating');
  assert.equal(b.state().paused, false);
  assert.equal(b.state().pauseReason, '');
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

test('removing an item also prunes its download records', async () => {
  const b = await background({
    items: [{ id: 'a', text: 'one', status: 'done', orderIndex: 1 }, { id: 'b', text: 'two', status: 'pending', orderIndex: 2 }],
    downloads: { 101: { requestId: 'a', status: 'complete' }, 102: { requestId: 'b', status: 'complete' } },
  });
  await b.message({ type: 'REMOVE_ITEM', id: 'a' });
  assert.deepEqual(Object.keys(b.state().downloads), ['102']);
});

test('clearing completed items prunes only their own download records', async () => {
  const b = await background({
    items: [{ id: 'a', text: 'one', status: 'done', orderIndex: 1 }, { id: 'b', text: 'two', status: 'pending', orderIndex: 2 }],
    downloads: { 101: { requestId: 'a', status: 'complete' }, 102: { requestId: 'b', status: 'complete' } },
  });
  await b.message({ type: 'CLEAR_COMPLETED' });
  assert.deepEqual(Object.keys(b.state().downloads), ['102']);
});

test('clearing the queue wipes every download record instead of leaking them forever', async () => {
  const b = await background({
    items: [{ id: 'a', text: 'one', status: 'done', orderIndex: 1 }],
    downloads: { 101: { requestId: 'a', status: 'complete' } },
  });
  await b.message({ type: 'CLEAR' });
  assert.deepEqual(b.state().downloads, {});
});

test('startup prunes download records orphaned by removals from before this fix existed', async () => {
  const b = await background({
    items: [{ id: 'b', text: 'two', status: 'done', orderIndex: 2 }],
    downloads: { 101: { requestId: 'a', status: 'complete' }, 102: { requestId: 'b', status: 'complete' } },
  });
  assert.deepEqual(Object.keys(b.state().downloads), ['102']);
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

test('watcher scans the DOM once for 100 pending jobs', () => {
  const { context: c } = content();
  let scans = 0;
  c.getAllMediaGrids = () => { scans++; return []; };
  c.findErrorBanner = () => null;
  vm.runInContext('for(let i=0;i<100;i++)pendingJobs.set(String(i),{text:"prompt "+i,startedAt:Date.now()});checkPendingJobs()', c);
  assert.equal(scans, 1);
});

test('debugger connects once per queue and detaches after the final submit', async () => {
  const b = await background({ tabId: 7, inputMode: 'debugger', continuousMode: true,
    items: [{ id: 'one', text: 'first', status: 'pending' }] });
  let attached = 0, detached = 0;
  b.chrome.debugger.attach = async () => { attached++; };
  b.chrome.debugger.detach = async () => { detached++; };
  await b.context.runQueue();
  assert.equal(attached, 1);
  assert.equal(detached, 1);
  assert.equal(b.calls[0].inputMode, 'debugger');
});

test('queue zooms the result tab out while running and restores zoom on exit', async () => {
  const b = await background({ tabId: 7, continuousMode: true, items: [{ id: 'one', text: 'first', status: 'pending' }] });
  const zooms = [];
  b.chrome.tabs.setZoom = async (tabId, factor) => { zooms.push([tabId, factor]); };
  await b.context.runQueue();
  assert.deepEqual(zooms, [[7, 0.5], [7, 0]]);
});

test('debugger attach failure does not attempt input or submit', async () => {
  const b = await background({ tabId: 7, inputMode: 'debugger', items: [{ id: 'one', text: 'first', status: 'pending' }] });
  b.chrome.debugger.attach = async () => { throw new Error('Another debugger is already attached'); };
  await b.context.runQueue();
  assert.equal(b.calls.length, 0);
  assert.equal(b.state().items[0].status, 'pending');
  assert.equal(b.state().paused, true);
});

test('user cancel while waiting for a slot stops without reattaching', async () => {
  const b = await background({ tabId: 7, inputMode: 'debugger', continuousMode: true,
    items: [{ id: 'one', text: 'first', status: 'generating' }, { id: 'two', text: 'second', status: 'pending' }] });
  let attaches = 0;
  b.chrome.debugger.attach = async () => { attaches++; };
  const run = b.context.runQueue();
  await until(() => b.state().debuggerStatus === 'attached');
  b.chrome.debugger.onDetach.listeners[0]({ tabId: 7 }, 'canceled_by_user');
  await run;
  assert.equal(b.state().paused, true);
  assert.equal(b.calls.length, 0);
  assert.equal(attaches, 1);
});

test('debug input only accepts the current request in the selected main frame', async () => {
  const b = await background({ tabId: 7, inputMode: 'debugger' });
  await b.context.setState({ running: true, items: [{ id: 'one', text: 'actual prompt', status: 'running', tabId: 7 }] });
  const response = await b.message({ type: 'MJ_DEBUG_INPUT', action: 'insertText', requestId: 'one', marker: 'one:1' }, { tab: { id: 8 }, frameId: 0 });
  assert.equal(response.ok, false);
  assert.match(response.error, /không thuộc/);
});

test('debug submit is persisted before clicking and cannot run twice', async () => {
  const b = await background({ tabId: 7, inputMode: 'debugger' });
  await b.context.setState({ running: true, items: [{ id: 'one', text: 'actual prompt', status: 'running', tabId: 7, debugTextInserted: true }] });
  const transport = vm.runInContext('debugInput', b.context);
  let clicks = 0;
  transport.click = async () => {
    assert.equal(b.state().items[0].debugSubmitAttempted, true);
    clicks++;
  };
  const msg = { type: 'MJ_DEBUG_INPUT', action: 'submit', requestId: 'one', marker: 'one:2' };
  const sender = { tab: { id: 7 }, frameId: 0 };
  assert.equal((await b.message(msg, sender)).ok, true);
  assert.equal((await b.message(msg, sender)).ok, false);
  assert.equal(clicks, 1);
});

test('stop during slow debugger attach prevents all input commands', async () => {
  const b = await background({ tabId: 7, inputMode: 'debugger', items: [{ id: 'one', text: 'first', status: 'pending' }] });
  let finish, detachCount = 0;
  b.chrome.debugger.attach = () => new Promise(resolve => { finish = resolve; });
  b.chrome.debugger.detach = async () => { detachCount++; };
  const run = b.context.runQueue();
  await until(() => finish);
  await b.message({ type: 'STOP' });
  finish();
  await run;
  assert.equal(b.calls.length, 0);
  assert.equal(detachCount, 1);
  assert.equal(b.state().items[0].status, 'pending');
});

test('composer is reselected after settings rerender the input', async () => {
  const { context: c } = content();
  const old = { focus() { throw new Error('stale input'); } }, fresh = { focus() {} };
  let reads = 0, filled;
  c.findPromptTextarea = () => ++reads === 1 ? old : fresh;
  c.findErrorBanner = () => null;
  c.ensureDefaultSettings = async () => ({ ok: true });
  c.setNativeValue = el => { filled = el; };
  c.sleep = async () => {};
  c.findSubmitButton = () => ({ click() {} });
  c.waitForPromptToClear = async () => true;
  assert.equal((await c.fillAndSubmit('test', 'one', {})).ok, true);
  assert.equal(filled, fresh);
});
