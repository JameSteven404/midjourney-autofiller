// Real unpacked extension + Chrome debugger against a fully intercepted fixture.
// No Midjourney account, generation request, or production page is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const testRuntime = path.resolve(root, '../.test-runtime');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(testRuntime, 'browsers');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const fixture = `<!doctype html><html><head><style>
body {font-family: sans-serif;padding: 32px;background:#fff}textarea {width:600px;height:100px}button {padding:18px}
img {width:64px;height:64px} .row {margin-top:20px}
</style></head><body><h1>Local Midjourney input fixture</h1>
<form><textarea id="desktop_input_bar" placeholder="Imagine"></textarea><button type="submit" aria-label="Imagine">Imagine</button></form>
<button type="button" id="settingsTrigger"><svg width="16" height="16"><path d="M8.6543 15.3408"/></svg>Settings</button>
<div id="settingsPanel" style="display:none">
 <div id="presets"><button>Portrait</button><button class="bg-splash/test">Square</button><button>Landscape</button></div>
 <div id="speed"><span>Speed</span><button>Relax</button><button class="bg-splash/test">Fast</button></div>
</div>
<div role="alert" id="error" style="display:none"></div><div id="results"></div>
<script>
window.receipts=[]; window.inputEvents=[]; window.withhold=false;
window.settingsOpens=0;window.settingsTrusted=[];
document.querySelector('#settingsTrigger').addEventListener('click',e=>{if(e.isTrusted){settingsOpens++;document.querySelector('#settingsPanel').style.display='block'}});
for(const id of ['presets','speed'])document.querySelector('#'+id).addEventListener('click',e=>{
 if(e.target.tagName!=='BUTTON'||!e.isTrusted)return;
 settingsTrusted.push(e.isTrusted);
 for(const b of e.currentTarget.querySelectorAll('button'))b.className='';e.target.className='bg-splash/test';
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&e.isTrusted)document.querySelector('#settingsPanel').style.display='none'});
const textarea=document.querySelector('textarea'), button=document.querySelector('button');
textarea.addEventListener('input', e=>inputEvents.push({trusted:e.isTrusted,value:textarea.value}));
button.addEventListener('click', e=>{if(!e.isTrusted)e.preventDefault()});
document.querySelector('form').addEventListener('submit', e=>{
 e.preventDefault();const text=textarea.value;receipts.push({text,trusted:e.isTrusted});
 textarea.value='';textarea.dispatchEvent(new Event('input',{bubbles:true}));
 if(withhold)return;
 const count=receipts.length;
 setTimeout(()=>{
  const row=document.createElement('div');row.className='row';
  const prompt=document.createElement('div');prompt.className='group/promptText';
  const span=document.createElement('span');span.className='relative';span.textContent=text;prompt.append(span);
  const grid=document.createElement('div');grid.className='group/mediaGrid';
  for(let i=0;i<4;i++){const img=document.createElement('img');img.src='https://cdn.midjourney.com/fixture-'+count+'/0_'+i+'.png';grid.append(img)}
  row.append(prompt,grid);document.querySelector('#results').prepend(row);
 },200);
});
</script></body></html>`;

(async () => {
  fs.mkdirSync(testRuntime, { recursive: true });
  const profile = fs.mkdtempSync(path.join(testRuntime, 'smoke-profile-'));
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  try {
    const png = fs.readFileSync(path.join(root, 'icons/icon16.png'));
    await browser.route('https://**/*', route => {
      if (route.request().url().startsWith('https://cdn.midjourney.com/fixture-')) return route.fulfill({ contentType: 'image/png', body: png });
      return route.fulfill({ contentType: 'text/html', body: fixture });
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const errors = [];
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://www.midjourney.com/imagine');
    const extensionId = new URL(worker.url()).host;
    const panel = await browser.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await panel.waitForSelector('#startBtn');
    const prompt = 'Bầu trời "xanh" — dòng một\r\nDòng hai --ar 16:9';
    await worker.evaluate(async ({ prompt }) => {
      await startupReady;
      const [tab] = await chrome.tabs.query({ url: 'https://www.midjourney.com/imagine' });
      await setState({ items: [{ id: 'debug-fixture-1', text: prompt, status: 'pending' },
        { id: 'debug-fixture-2', text: 'Second fixture prompt', status: 'pending' }], logs: [], downloads: {},
        tabId: tab.id, inputMode: 'debugger', continuousMode: true, maxInFlight: 1, autoDownload: false,
        defaultSettings: { aspectRatio: 'landscape', speed: 'relax' } });
    }, { prompt });
    await panel.locator('#startBtn').click();
    await page.waitForFunction(() => receipts.length === 2, { timeout: 15000 });
    await panel.waitForFunction(() => document.querySelector('#queueProgress').textContent.includes('2/2'), { timeout: 15000 });
    const receipt = await page.evaluate(() => ({ receipts, inputEvents }));
    const textareaText = prompt.replace(/\r\n/g, '\n');
    assert.equal(receipt.receipts[0].text, textareaText);
    assert.equal(receipt.receipts.length, 2);
    assert.ok(receipt.inputEvents.some(event => event.trusted && event.value === textareaText));
    const settings = await page.evaluate(() => ({ opens: settingsOpens, trusted: settingsTrusted,
      closed: document.querySelector('#settingsPanel').style.display === 'none',
      landscape: document.querySelector('#presets .bg-splash\\/test')?.textContent,
      speed: document.querySelector('#speed .bg-splash\\/test')?.textContent }));
    assert.equal(settings.opens, 1);
    assert.equal(settings.closed, true);
    assert.equal(settings.landscape, 'Landscape');
    assert.equal(settings.speed, 'Relax');
    assert.deepEqual(settings.trusted, [true, true]);
    const state = await worker.evaluate(() => getState());
    assert.equal(state.items.every(item => item.status === 'done'), true);
    assert.equal(state.items.every(item => item.mediaUrls.length === 4), true);
    assert.equal(state.inputMode, 'debugger');
    await panel.waitForFunction(() => document.querySelector('#debugStatus').textContent.includes('chưa kết nối'));
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await panel.screenshot({ path: path.join(testRuntime, 'panel-debug-smoke.png'), fullPage: true });
    console.log('PASS real unpacked extension: CDP trusted input, exact multiline text, two distinct submits, 4 images/job, slot wakeup, final detach');
    console.log('PASS real CDP settings: trusted option clicks, verified values, Escape closes panel, settings applied once per batch');

    // Closing the debug target produces a real browser onDetach event.
    // canceled_by_user is covered separately in the deterministic tests.
    await page.evaluate(() => { withhold = true; });
    await worker.evaluate(async () => {
      await setState({ items: [{ id: 'cancel-1', text: 'held fixture', status: 'pending' },
        { id: 'cancel-2', text: 'must remain pending', status: 'pending' }] });
    });
    await panel.locator('#startBtn').click();
    await page.waitForFunction(() => receipts.length === 3);
    const submittedBeforeClose = await page.evaluate(() => receipts.length);
    await page.close();
    await panel.waitForFunction(() => document.querySelector('#queuePauseReason').textContent.includes('Debug đã ngắt'));
    const canceled = await worker.evaluate(() => getState());
    assert.equal(canceled.running, false);
    assert.equal(canceled.paused, true);
    assert.equal(canceled.items[1].status, 'pending');
    assert.equal(submittedBeforeClose, 3);
    assert.deepEqual(errors, []);
    console.log('PASS real target-close debugger detach: pauses queue and keeps remaining prompt pending');
    await panel.locator('[data-tab="settings"]').click();
    await panel.screenshot({ path: path.join(testRuntime, 'panel-debug-settings.png'), fullPage: true });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
