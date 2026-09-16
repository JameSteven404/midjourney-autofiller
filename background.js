// Quản lý hàng đợi prompt và điều phối giữa side panel <-> content script.
// Bản dành riêng cho Midjourney web.
importScripts("lib/debugger-input.js");

const ACTION_TYPE = "FILL_AND_SUBMIT_MJ";
const STORAGE_KEY = "paf_state";

const MAX_LOGS = 300;
// Zoom tab về mức này khi chạy hàng đợi để nhiều lưới kết quả lọt vào khung
// nhìn hơn, tránh ảnh bị lazy-load/ảo hoá ngoài viewport không bao giờ render.
const RESULT_GRID_ZOOM = 0.5;

const DEFAULT_STATE = {
  items: [], // { id, text, status: 'pending'|'running'|'generating'|'done'|'error', note }
  running: false,
  paused: false,
  continuousMode: false,
  inputMode: "debugger",
  debuggerStatus: "off",
  debuggerTabId: null,
  nextSubmitAt: null,
  maxInFlight: 1,
  pauseReason: "",
  downloads: {},
  delayMinSeconds: 8,
  delayMaxSeconds: 20,
  tabId: null,
  autoDownload: false,
  downloadSubfolder: "midjourney-output",
  // Tên file theo SOP: {index} = số thứ tự prompt (đúng thứ tự dòng Excel),
  // {seed} lấy từ tham số --seed trong prompt, {n} = số ảnh trong prompt đó
  // → 001_52000101_1 … 001_52000101_4. Prompt không có --seed thì phần seed
  // tự lược bỏ, còn lại 001_1.
  filenameTemplate: "{index}_{seed}_{n}",
  startIndex: 1,
  // Ghi lại lần gần nhất trình duyệt tự đổi tên file so với yêu cầu, để side
  // panel cảnh báo ngay thay vì để người dùng tự phát hiện qua Downloads.
  lastFilenameMismatch: null,
  logs: [], // { ts, level: 'info'|'success'|'error', message }
  // Cấu hình mặc định áp trước khi gửi mỗi batch — field nào null/rỗng thì
  // giữ nguyên cài đặt hiện có trên Midjourney, không đổi gì cả.
  defaultSettings: {
    aspectRatio: null, // 'portrait' | 'square' | 'landscape'
    modelVersion: null, // 'standard' | 'hd'
    modelRaw: null, // 'standard' | 'raw'
    stylization: null, // 0-1000
    weirdness: null, // 0-3000
    variety: null, // 0-100
    speed: null, // 'relax' | 'fast'
    stealth: null, // 'on' | 'off'
    videoResolution: null, // 'sd' | 'hd'
    videoBatchSize: null, // 1 | 2 | 4
  },
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return { ...structuredClone(DEFAULT_STATE), ...data[STORAGE_KEY] };
}

// Serialize read/modify/write so job results cannot overwrite queue progress.
let stateWrites = Promise.resolve();
function setState(patch) {
  const write = stateWrites.then(async () => {
    const state = await getState();
    const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    broadcast(next);
    return next;
  });
  stateWrites = write.catch(() => {});
  return write;
}

function updateItem(id, patch) {
  return setState(state => ({ items: state.items.map(item => item.id === id ? { ...item, ...patch } : item) }));
}

// state.downloads chỉ hữu ích khi còn item tương ứng trong hàng đợi để hiển
// thị tiến độ tải/nút "Tải ảnh còn thiếu" — item bị xoá thì bản ghi tải của
// nó cũng nên mất theo. Không dọn thì downloads phình vô hạn suốt vòng đời
// lưu trữ (không được reset khi Xoá hàng đợi), làm mỗi lần đọc/ghi/broadcast
// state chậm dần và có thể chạm quota 10MB của chrome.storage.local.
function pruneDownloadsFor(downloads, survivingIds) {
  const keep = new Set(survivingIds);
  return Object.fromEntries(Object.entries(downloads).filter(([, record]) => keep.has(record.requestId)));
}

function broadcast(state) {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelayMs(minSec, maxSec) {
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  const sec = lo + Math.random() * (hi - lo);
  return Math.round(sec * 1000);
}

function findNextPendingIndex(state) {
  return state.items.findIndex((it) => it.status === "pending");
}

async function log(level, message) {
  const entry = { ts: Date.now(), level, message };
  await setState(state => ({ logs: [...state.logs, entry].slice(-MAX_LOGS) }));
}

function sanitizeFilename(text) {
  return (
    (text || "prompt")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .trim()
      .slice(0, 60)
      .replace(/\s+/g, "_") || "prompt"
  );
}

function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Keep CDN URLs durable across page reloads; preserve the source format.
function mediaExtension(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "cdn.midjourney.com") {
    throw new Error("Link tải không phải ảnh CDN Midjourney. Tải lại trang và kiểm tra job.");
  }
  const ext = url.pathname.match(/\.(png|webp|jpe?g|avif)$/i)?.[1]?.toLowerCase();
  if (!ext) throw new Error("Không xác định được định dạng ảnh từ link nguồn.");
  return ext;
}

function downloadFolder(value) {
  return String(value || "").replace(/\\/g, "/").split("/")
    .filter(part => part.trim() && part !== "." && part !== "..")
    .map(part => part.replace(/[\x00-\x1f:*?"<>|]/g, "_").replace(/[. ]+$/g, "_")).join("/");
}

function pad3(value) {
  return String(Math.max(0, Math.floor(Number(value) || 0))).padStart(3, "0");
}

function jobIdFromUrl(value) {
  try {
    return new URL(value).pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

// Seed nằm ngay trong prompt dưới dạng tham số Midjourney "--seed 52000101"
// (đúng SOP người dùng đang dùng), nên lấy thẳng từ prompt đã gửi — chính xác
// tuyệt đối, không phụ thuộc DOM. Midjourney chỉ hiển thị chip seed khi prompt
// có tham số này; nếu prompt không có thì không tồn tại seed để lấy.
function seedFromPrompt(text) {
  const m = String(text || "").match(/[-–—]{1,2}\s*seed\s+(\d{1,20})/i);
  return m ? m[1] : "";
}

// Cắt phần tham số ("--ar 16:9 --seed ...") khỏi phần mô tả để {prompt} chỉ
// còn nội dung thật, không lẫn cờ tham số. Chấp nhận 1-2 gạch ngang giống hệt
// seedFromPrompt (Excel/Word có thể tự co "--" thành 1 gạch ngang dài "–") —
// trước đây chỉ nhận đúng 2 ký tự nên khi bị tự động co lại, {prompt} không
// cắt được dù {seed} vẫn lấy đúng, làm token {prompt} dính cả đuôi tham số.
function promptWithoutParams(text) {
  const s = String(text || "");
  const at = s.search(/\s[-–—]{1,2}[a-z]/i);
  return at > 0 ? s.slice(0, at) : s;
}

// {index} số thứ tự prompt · {n} số ảnh trong prompt · {seq} số chạy liên tục
// · {seed} · {date} {time} {prompt} {job} {jobfull}. Biến rỗng (vd. prompt
// không có seed) được thu gọn để không để lại dấu "_" thừa.
function buildFilename(template, ctx) {
  const at = new Date(ctx.completedAt || Date.now());
  const jobId = sanitizeFilename(jobIdFromUrl(ctx.sourceUrl));
  const tokens = {
    index: pad3(ctx.index),
    n: String(ctx.n),
    seq: pad3(ctx.seq),
    seed: seedFromPrompt(ctx.prompt),
    date: timestampSlug(at).split("-")[0],
    time: timestampSlug(at).split("-")[1],
    prompt: sanitizeFilename(promptWithoutParams(ctx.prompt)),
    job: jobId.slice(0, 12),
    jobfull: jobId,
  };
  const base = String(template || "{index}_{n}")
    .replace(/\{(index|n|seq|seed|date|time|prompt|jobfull|job)\}/g, (_, key) => tokens[key])
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "")
    .trim()
    .slice(0, 120)
    .replace(/[._ ]+$/g, "") || `${tokens.index}_${tokens.n}`;
  return base + "." + ctx.ext;
}

// `filename` truyền vào downloads.download() chỉ là GỢI Ý ban đầu; quyết định
// cuối cùng thuộc về sự kiện onDeterminingFilename. Nếu extension khác (trình
// quản lý tải…) đăng ký sự kiện này và gọi suggest() mặc định, gợi ý của mình
// bị ghi đè — đúng hiện tượng đã đo được: yêu cầu "midjourney-output/001_1.webp"
// nhưng Brave lưu "0_0_640_N.webp" ngay tại Downloads. Đăng ký ở đây để khẳng
// định lại tên mình muốn ngay trong bước quyết định đó.
const pendingFilenames = new Map(); // url -> filename mong muốn

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const wanted = pendingFilenames.get(item.url) || pendingFilenames.get(item.finalUrl);
  if (wanted) {
    pendingFilenames.delete(item.url);
    pendingFilenames.delete(item.finalUrl);
    suggest({ filename: wanted, conflictAction: "uniquify" });
    return;
  }
  // Service worker có thể đã khởi động lại sau khi đặt lệnh tải — tra lại ý
  // định đã lưu trong storage trước khi nhường quyền quyết định.
  getState().then((state) => {
    const rec = Object.values(state.downloads).find(
      (d) => (d.url === item.url || d.sourceUrl === item.url) && ["starting", "downloading"].includes(d.status)
    );
    if (rec?.filename) suggest({ filename: rec.filename, conflictAction: "uniquify" });
    else suggest();
  }).catch(() => suggest());
  return true;
});

const MAX_DOWNLOAD_RESUME_ATTEMPTS = 3;

async function recordDownloadStatus(downloadId) {
  const state = await getState();
  const saved = state.downloads[downloadId];
  // "complete" là trạng thái chấm dứt thật duy nhất. Trước đây guard này chỉ
  // xử lý khi status hiện tại còn là "downloading" — nên ngay khi mạng
  // chậm/chập chờn khiến Chrome báo "interrupted" một lần, bản ghi bị đóng
  // băng: dù download sau đó (tự Chrome hay do resume() dưới đây) tải xong
  // thật, sự kiện onChanged tiếp theo cũng bị bỏ qua vì saved.status không
  // còn là "downloading" nữa. Ảnh nặng/mạng chậm dễ gặp interrupted tạm thời
  // hơn ảnh nhỏ, nên đây là nguyên nhân trực tiếp khiến "ảnh chậm không tải
  // về được" dù thực tế Chrome vẫn tải được.
  if (!saved || saved.status === "complete") return;
  const [download] = await chrome.downloads.search({ id: Number(downloadId) });
  if (download && download.state === "in_progress") {
    if (saved.status !== "downloading") {
      await setState(current => {
        const previous = current.downloads[downloadId];
        if (!previous || previous.status === "complete") return {};
        return { downloads: { ...current.downloads, [downloadId]: { ...previous, status: "downloading" } } };
      });
    }
    return;
  }
  if (download?.state === "interrupted" && download.canResume && (saved.resumeAttempts || 0) < MAX_DOWNLOAD_RESUME_ATTEMPTS) {
    // Chrome không tự nối lại các lượt tải "interrupted" — phải tự gọi
    // resume(). Thử trước khi chốt là lỗi, vì gián đoạn do mạng chậm/chập
    // chờn thường resume được ngay.
    await setState(current => {
      const previous = current.downloads[downloadId];
      if (!previous || previous.status === "complete") return {};
      return { downloads: { ...current.downloads,
        [downloadId]: { ...previous, resumeAttempts: (previous.resumeAttempts || 0) + 1 } } };
    });
    const resumed = await chrome.downloads.resume(Number(downloadId)).then(() => true).catch(() => false);
    if (resumed) return;
  }
  const status = download?.state === "complete" ? "complete" : "interrupted";
  const error = status === "complete" ? "" : (download?.error || "Không tìm thấy lượt tải trong Chrome.");
  // Đối chiếu với đường dẫn Chrome THỰC SỰ dùng để lưu — trước đây log chỉ
  // lặp lại tên đã yêu cầu (saved.filename) nên dù trình duyệt âm thầm đổi
  // tên/bỏ qua thư mục con, log vẫn báo "thành công" với tên sai, khiến lỗi
  // không bị phát hiện.
  const actualPath = (download?.filename || "").replace(/\\/g, "/");
  const actualName = actualPath.split("/").pop() || "";
  const expectedName = saved.filename.split("/").pop() || "";
  const mismatch = status === "complete" && actualName && actualName !== expectedName;
  let changed = false;
  await setState(current => {
    const previous = current.downloads[downloadId];
    if (!previous || previous.status === "complete") return {};
    changed = true;
    return { downloads: { ...current.downloads, [downloadId]: { ...previous, status, error, actualPath } } };
  });
  if (!changed) return;
  if (mismatch) {
    await setState({ lastFilenameMismatch: { wanted: saved.filename, actual: actualPath, ts: Date.now() } });
    await log("error", "Chrome/Brave đã lưu file KHÁC tên/khác thư mục so với yêu cầu — yêu cầu: " +
      saved.filename + " — thực tế: " + actualPath);
  } else {
    await log(status === "complete" ? "success" : "error",
      status === "complete" ? "Đã tải xong: " + (actualPath || saved.filename) : "Tải bị gián đoạn: " + saved.filename + " — " + error);
  }
}

async function findReconcileMatch(record) {
  const matches = (await chrome.downloads.search({ url: record.url })).filter(file => {
    const filename = (file.filename || "").replace(/\\/g, "/");
    return (filename === record.filename || filename.endsWith("/" + record.filename)) &&
      Date.parse(file.startTime) >= record.startedAt - 2000;
  });
  return matches.length === 1 ? matches[0] : null;
}

// Service worker khởi động lại đúng lúc đang await chrome.downloads.download()
// (giữa lúc gọi và lúc Chrome trả downloadId) chỉ để lại bản ghi "starting".
// Chrome cần một chút thời gian để lượt tải đó xuất hiện trong lịch sử tải —
// tìm ngay lần đầu có thể ra 0 kết quả dù lượt tải (đặc biệt ảnh nặng/mạng
// chậm) vẫn đang chạy tốt. Thử lại vài lần trước khi chốt là lỗi.
async function reconcileDownloadIntent(key, record) {
  let match = await findReconcileMatch(record);
  for (let attempt = 0; !match && attempt < 3; attempt++) {
    await sleep(1500);
    match = await findReconcileMatch(record);
  }
  if (match) {
    const id = match.id;
    await setState(state => {
      const downloads = { ...state.downloads };
      delete downloads[key];
      downloads[id] = { ...record, status: "downloading" };
      return { downloads };
    });
    await recordDownloadStatus(id);
  } else {
    await setState(state => ({ downloads: { ...state.downloads, [key]: { ...record,
      status: "interrupted", error: "Chưa đối chiếu được lượt tải sau khi tiện ích khởi động lại. Kiểm tra Downloads trước khi tải lại." } } }));
    await log("error", "Cần kiểm tra Downloads trước khi tải lại: " + record.filename);
  }
}

const downloadsInProgress = new Set();
async function downloadMedia(urls, promptText, subfolder, requestId, completedAt, orderIndex, template) {
  if (downloadsInProgress.has(requestId)) return;
  downloadsInProgress.add(requestId);
  try {
    for (let i = 0; i < urls.length; i++) {
      const sourceUrl = urls[i];
      const before = await getState();
      const prior = Object.values(before.downloads).find(d => d.requestId === requestId && d.sourceUrl === sourceUrl &&
        ["complete", "downloading", "starting"].includes(d.status));
      if (prior) continue;
      const key = "starting:" + requestId + ":" + i;
      let filename = "";
      // Tải thẳng link CDN https thật — KHÔNG chuyển qua blob:/data: URL, vì
      // với blob:/data: thì Chrome tự đặt tên theo UUID nội bộ và bỏ luôn thư
      // mục con. Tên cuối cùng được khẳng định lại trong onDeterminingFilename.
      try {
        const ext = mediaExtension(sourceUrl);
        const folder = downloadFolder(subfolder);
        const name = buildFilename(template, {
          index: orderIndex, n: i + 1, seq: (Math.max(1, orderIndex) - 1) * urls.length + i + 1,
          prompt: promptText, sourceUrl, completedAt, ext,
        });
        filename = folder ? folder + "/" + name : name;
        // Save intent before asking Chrome, so suspension is visible, not silent.
        // Xoá bản ghi "interrupted" cũ (nếu có) của chính URL này trước khi
        // tạo lượt tải lại — nếu không, bản ghi lỗi cũ vẫn nằm lại song song
        // với lượt tải mới, khiến side panel hiện lỗi cũ dù ảnh đang được tải
        // lại/đã tải lại xong.
        await setState(state => {
          const downloads = { ...state.downloads };
          for (const [k, d] of Object.entries(downloads)) {
            if (d.requestId === requestId && d.sourceUrl === sourceUrl && d.status === "interrupted") delete downloads[k];
          }
          downloads[key] = { requestId, sourceUrl, url: sourceUrl, filename, status: "starting", startedAt: Date.now() };
          return { downloads };
        });
        pendingFilenames.set(sourceUrl, filename);
        const id = await chrome.downloads.download({ url: sourceUrl, filename, conflictAction: "uniquify" });
        if (typeof id !== "number") throw new Error("Chrome không trả về mã lượt tải.");
        await setState(state => {
          const downloads = { ...state.downloads };
          delete downloads[key];
          downloads[id] = { requestId, sourceUrl, url: sourceUrl, filename, status: "downloading", startedAt: Date.now() };
          return { downloads };
        });
        await log("info", "Đã bắt đầu tải: " + filename);
        // Covers completion before the onChanged listener can see the saved ID.
        await recordDownloadStatus(id);
      } catch (err) {
        pendingFilenames.delete(sourceUrl);
        await setState(state => ({ downloads: { ...state.downloads,
          [key]: { requestId, sourceUrl, url: sourceUrl, filename, status: "interrupted", error: String(err.message || err) } } }));
        await log("error", "Không tải được ảnh " + (i + 1) + ": " + String(err.message || err));
      }
    }
  } finally {
    downloadsInProgress.delete(requestId);
  }
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.error) recordDownloadStatus(delta.id).catch(console.error);
});

function sendToTabRaw(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-scripts/midjourney.js"],
  });
}

// Sau khi extension được reload trong chrome://extensions, các tab Midjourney
// đang mở từ trước KHÔNG tự có lại content script (chỉ tab mở/tải mới mới
// được tiêm code mới) — sendMessage sẽ báo "Could not establish connection.
// Receiving end does not exist." Thay vì bắt người dùng phải nhớ tải lại
// trang mỗi lần, tự tiêm lại content script rồi gửi lại 1 lần khi gặp đúng
// lỗi này.
async function sendToTab(tabId, message) {
  try {
    return await sendToTabRaw(tabId, message);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (!msg.includes("Receiving end does not exist")) throw err;

    await log("info", "Tab chưa có content script (thường do vừa reload extension) — tự tiêm lại và thử gửi lại.");
    await injectContentScript(tabId);
    await new Promise((r) => setTimeout(r, 300));
    return await sendToTabRaw(tabId, message);
  }
}

function inFlightCount(state) {
  return state.items.filter(item => ["running", "generating", "review"].includes(item.status)).length;
}

function flightLimit(state) {
  return Math.max(1, Math.min(10, Math.floor(Number(state.maxInFlight) || 1)));
}

let queueTask = null;
let queueEpoch = 0;
let queueWake = null;
function wakeQueue() { queueWake?.(); }
function waitForQueue(ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); if (queueWake === done) queueWake = null; resolve(); };
    const timer = setTimeout(done, ms);
    queueWake = done;
  });
}

const debugInput = new MidjourneyDebuggerInput(chrome, {
  onStatus: (debuggerStatus, debuggerTabId) => setState({ debuggerStatus, debuggerTabId }),
  onDetach: (reason, tabId) => {
    const paused = pauseQueue("Debug đã ngắt (" + reason + "). Kiểm tra job rồi bấm Chạy khi muốn tiếp tục.");
    if (reason === "target_closed") setState(state => ({ tabId: state.tabId === tabId ? null : state.tabId,
      items: state.items.map(item => item.tabId === tabId && ["running", "generating"].includes(item.status)
        ? { ...item, status: "review", note: "Tab đã đóng; kiểm tra kết quả trên Midjourney trước khi tiếp tục." } : item) })).catch(console.error);
    paused.catch(console.error);
  },
});
let debugCommands = Promise.resolve();

function handleDebugInput(msg, sender) {
  const operation = debugCommands.then(async () => {
    const guard = async () => {
      const state = await getState();
      const item = state.items.find(it => it.id === msg.requestId);
      if (state.inputMode !== "debugger" || !state.running || state.paused ||
          sender.frameId !== 0 || sender.tab?.id !== state.tabId || item?.tabId !== state.tabId || item?.status !== "running") {
        throw new Error("Lệnh debug không thuộc prompt/tab đang chạy.");
      }
      return item;
    };
    const item = await guard();
    if (!["insertText", "click", "submit", "escape", "clickOutside"].includes(msg.action)) throw new Error("Lệnh debug không hỗ trợ.");
    if (!["escape", "clickOutside"].includes(msg.action) && (typeof msg.marker !== "string" || !msg.marker.startsWith(item.id + ":") || msg.marker.length > 160)) {
      throw new Error("Đích thao tác không hợp lệ.");
    }
    if (item.debugSubmitAttempted) throw new Error("Đã thử gửi prompt này; không tự gửi lần hai.");
    if (msg.action === "insertText") {
      if (item.debugTextInserted) throw new Error("Prompt đã được nhập trong lần gửi này.");
      await debugInput.insertText(msg.marker, item.text, guard);
      await updateItem(item.id, { debugTextInserted: true });
    } else if (msg.action === "escape") {
      await debugInput.escape(guard);
    } else if (msg.action === "clickOutside") {
      await debugInput.clickOutside(guard);
    } else {
      if (msg.action === "submit") {
        if (!item.debugTextInserted) throw new Error("Chưa xác nhận nhập prompt.");
        // Persist before the input event: a lost response must never cause a second click.
        await updateItem(item.id, { debugSubmitAttempted: true });
      }
      await debugInput.click(msg.marker, msg.ratio, guard);
    }
    return { ok: true };
  });
  debugCommands = operation.catch(() => {});
  return operation;
}

async function pauseQueue(reason) {
  queueEpoch++;
  wakeQueue();
  await setState({ running: false, paused: true, pauseReason: reason, nextSubmitAt: null });
  await debugInput.detach();
  await log("error", reason);
}

async function runQueue() {
  if (queueTask) return queueTask;
  const epoch = ++queueEpoch;
  queueTask = processQueue(epoch).finally(() => { queueTask = null; });
  return queueTask;
}

async function processQueue(epoch) {
  let zoomTabId = null;
  try {
    let state = await getState();
    if (!state.tabId) throw new Error("Chưa gắn tab Midjourney.");
    const attachedTab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!attachedTab || !/^https:\/\/(www\.)?midjourney\.com\//i.test(attachedTab.url || "")) {
      await setState({ tabId: null });
      throw new Error("Tab đã gắn không còn tồn tại hoặc không phải Midjourney. Gắn lại tab rồi chạy lại.");
    }
    await setState({ running: true, paused: false, pauseReason: "" });
    // Midjourney nhiều khả năng ảo hoá/lazy-load ảnh nằm ngoài khung nhìn —
    // job xong nhưng lưới của nó chưa từng thực sự render/tải trong DOM thì
    // gridIsFullyLoaded() ở content script không bao giờ đúng, kẹt "Đang tạo"
    // mãi. Thu nhỏ zoom tab để nhiều lưới kết quả hơn lọt vào khung nhìn;
    // khôi phục lại zoom gốc (0 = mặc định của trình duyệt) ở finally bên
    // dưới, dù dừng bằng cách nào (xong hàng đợi, lỗi, Dừng, Tạm dừng).
    zoomTabId = state.tabId;
    await chrome.tabs.setZoom(zoomTabId, RESULT_GRID_ZOOM).catch(() => {});
    if (state.inputMode === "debugger") await debugInput.attach(state.tabId);
    await log("info", "Bắt đầu hàng đợi. Tối đa " + flightLimit(state) + " prompt đang tạo.");
    let reportedWait = false;
    while (epoch === queueEpoch) {
      state = await getState();
      if (!state.running || state.paused) break;
      if (state.items.some(it => it.status === "review")) {
        await pauseQueue("Có prompt chưa rõ kết quả. Kiểm tra trên Midjourney rồi đánh dấu bỏ qua trước khi tiếp tục.");
        break;
      }
      const idx = findNextPendingIndex(state);
      if (idx === -1) {
        await setState({ running: false });
        await log("info", "Đã gửi hết hàng đợi; tiếp tục theo dõi ảnh và tải xuống.");
        break;
      }
      if (inFlightCount(state) >= flightLimit(state)) {
        if (!reportedWait) await log("info", "Đang chờ chỗ trống cho prompt tiếp theo.");
        reportedWait = true;
        await waitForQueue(1000);
        continue;
      }
      reportedWait = false;
      const item = state.items[idx];
      await updateItem(item.id, { status: "running", tabId: state.tabId, startedAt: Date.now(), note: "",
        debugTextInserted: false, debugSubmitAttempted: false });
      await log("info", "Đang gửi: " + item.text.slice(0, 60));
      let result;
      try {
        result = await sendToTab(state.tabId, { type: ACTION_TYPE, text: item.text,
          requestId: item.id, settingsConfig: state.defaultSettings, inputMode: state.inputMode });
        if (!result) throw new Error("Không nhận được phản hồi từ trang; chưa rõ prompt đã được gửi hay chưa.");
      } catch (err) {
        await updateItem(item.id, { status: "review", note: String(err.message || err) });
        await pauseQueue("Mất xác nhận gửi. Kiểm tra job trên Midjourney trước khi tiếp tục: " + String(err.message || err));
        break;
      }
      // The asynchronous watcher can complete before the submit reply arrives.
      await setState(current => ({ items: current.items.map(it => {
        if (it.id !== item.id || it.status !== "running") return it;
        return { ...it, status: result.ok ? "generating" : (result.notSubmitted ? "pending" : "review"),
          note: result.note || "", excludedKeys: result.excludedKeys || [], startedAt: result.startedAt || it.startedAt,
          submitDurationMs: Date.now() - it.startedAt };
      }) }));
      if (!result.ok || result.rateLimited) {
        await pauseQueue((result.rateLimited ? "Midjourney báo giới hạn/lỗi: " : "Chưa xác nhận gửi: ") + (result.note || "Kiểm tra trang."));
        break;
      }
      await log("info", "Đã gửi, đang chờ Midjourney tạo ảnh.");
      if (epoch !== queueEpoch) break;
      state = await getState();
      if (!state.continuousMode && findNextPendingIndex(state) !== -1) {
        const until = Date.now() + randomDelayMs(state.delayMinSeconds ?? 8, state.delayMaxSeconds ?? 20);
        await setState({ nextSubmitAt: until });
        while (epoch === queueEpoch && Date.now() < until) await waitForQueue(Math.min(1000, until - Date.now()));
        await setState({ nextSubmitAt: null });
      }
    }
  } catch (err) {
    await pauseQueue(String(err.message || err));
  } finally {
    await debugInput.detach();
    if (zoomTabId != null) await chrome.tabs.setZoom(zoomTabId, 0).catch(() => {});
  }
}

async function handleJobResult(msg, sender) {
  let accepted = false;
  let item;
  const completedAt = Date.now();
  const state = await setState(current => ({ items: current.items.map(it => {
    if (it.id !== msg.requestId || !["running", "generating"].includes(it.status)) return it;
    if (sender?.tab?.id !== it.tabId && it.tabId != null) return it;
    accepted = true;
    item = it;
    return { ...it, status: msg.ok ? "done" : "review", note: msg.note || "",
      mediaUrls: msg.mediaUrls || [], gridKey: msg.gridKey || "", completedAt };
  }) }));
  if (!accepted) return;
  wakeQueue();
  await log(msg.ok ? "success" : "error", msg.note || (msg.ok ? "Đã tạo xong ảnh." : "Chưa xác nhận được ảnh."));
  if (!msg.ok) await pauseQueue(msg.note || "Job cần kiểm tra thủ công trước khi gửi tiếp.");
  if (msg.ok && state.autoDownload && msg.mediaUrls?.length) {
    await downloadMedia(msg.mediaUrls, item.text, state.downloadSubfolder, item.id, completedAt,
      item.orderIndex, state.filenameTemplate);
  }
}

// Worker restart does not prove that an interrupted submit failed.
const startupReady = (async () => {
  await setState(state => {
    // Mục thêm từ bản cũ chưa có orderIndex — gán theo đúng vị trí hiện tại
    // để tên file vẫn đánh số liền mạch thay vì rơi về 000.
    const items = state.items.map((it, i) => {
      const withOrder = it.orderIndex ? it : { ...it, orderIndex: i + 1 };
      return withOrder.status === "running"
        ? { ...withOrder, status: "review", note: "Tiện ích khởi động lại khi đang gửi; cần kiểm tra trên Midjourney." }
        : withOrder;
    });
    return { running: false, debuggerStatus: "off", debuggerTabId: null, nextSubmitAt: null,
      // Nâng mẫu tên file cũ lên mẫu có seed; chỉ đụng vào khi người dùng vẫn
      // đang để đúng mẫu mặc định trước đây, không ghi đè mẫu tự đặt.
      filenameTemplate: state.filenameTemplate === "{index}_{n}" ? "{index}_{seed}_{n}" : state.filenameTemplate,
      paused: state.running ? true : state.paused,
      pauseReason: state.running ? "Tiện ích vừa khởi động lại. Kiểm tra job đang gửi rồi bấm Chạy để tiếp tục." : state.pauseReason,
      items,
      // Dọn một lần lúc khởi động các bản ghi tải của item đã không còn trong
      // hàng đợi (vd. bị xoá ở bản cũ trước khi có pruneDownloadsFor) — giải
      // phóng ngay phần đã tích tụ, không phải đợi người dùng bấm Xoá hàng đợi.
      downloads: pruneDownloadsFor(state.downloads, items.map(it => it.id)),
    };
  });
  const state = await getState();
  for (const [id, record] of Object.entries(state.downloads)) {
    if (record.status === "downloading") await recordDownloadStatus(id);
    if (record.status === "starting") {
      await reconcileDownloadIntent(id, record);
    }
  }
})().catch(console.error);

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (!changes.url || /^https:\/\/(www\.)?midjourney\.com\//i.test(changes.url)) return;
  startupReady.then(async () => {
    const state = await getState();
    if (state.running && state.tabId === tabId) await pauseQueue("Tab đã rời Midjourney; dừng gửi prompt.");
  }).catch(console.error);
});

// Tab đã gắn có thể bị đóng trong lúc hàng đợi không chạy (idle) — nếu không
// dọn state.tabId thì side panel vẫn báo "Đã gắn tab" dù tab đó không còn
// tồn tại, và lần bấm Chạy kế tiếp sẽ báo lỗi khó hiểu ("Receiving end does
// not exist") thay vì một thông báo rõ ràng.
chrome.tabs.onRemoved.addListener((tabId) => {
  startupReady.then(async () => {
    const state = await getState();
    if (state.tabId !== tabId) return;
    if (state.running) await pauseQueue("Tab Midjourney đã gắn vừa bị đóng; dừng gửi prompt.");
    await setState({ tabId: null });
  }).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "MJ_DEBUG_INPUT") {
    startupReady.then(() => handleDebugInput(msg, sender)).then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === "MJ_JOB_RESULT") {
    startupReady.then(() => handleJobResult(msg, sender)).then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === "MJ_PAGE_BLOCKED") {
    startupReady.then(async () => {
      const state = await getState();
      if (sender.tab?.id === state.tabId && state.running) await pauseQueue(msg.note);
    }).catch(console.error);
    return false;
  }
  if (msg.type === "MJ_JOB_STALL_WARNING") {
    // Chỉ ghi log để biết chính xác lý do chưa khớp được kết quả — không đổi
    // trạng thái item, không dừng hàng đợi (job có thể vẫn đang tạo bình
    // thường, chỉ là selector dò lưới kết quả chưa khớp được).
    startupReady.then(async () => {
      const state = await getState();
      const item = state.items.find((it) => it.id === msg.requestId);
      // Prompt theo mẫu SOP dài thường chung hệt đoạn mở đầu — cắt 60 ký tự
      // đầu không phân biệt được job nào, nên ưu tiên hiện seed (khác nhau
      // mỗi dòng) nếu có, kèm số thứ tự trong hàng đợi.
      const seed = item ? seedFromPrompt(item.text) : "";
      const label = item ? (seed ? `#${item.orderIndex} seed ${seed}` : `#${item.orderIndex} ${item.text.slice(0, 60)}`) : msg.requestId;
      await log("error", `Chưa xác nhận được kết quả cho ${label} sau 90s: ${msg.note}`);
    }).catch(console.error);
    return false;
  }

  (async () => {
    await startupReady;
    switch (msg.type) {
      case "GET_STATE":
        sendResponse(await getState());
        break;
      case "MJ_GET_GENERATING": {
        // Content script gọi khi vừa được (tiêm lại) để lấy danh sách job
        // đang "generating" mà nó chưa biết (vd. sau khi extension reload
        // làm mất bộ theo dõi cũ) — tiếp tục canh từ đây thay vì kẹt mãi.
        const state = await getState();
        const items = state.items
          .filter((it) => it.status === "generating" && (it.tabId ?? state.tabId) === sender.tab?.id)
          .map((it) => ({ requestId: it.id, text: it.text, startedAt: it.startedAt,
            excludedKeys: [...(it.excludedKeys || []), ...state.items.filter(done => done.status === "done" && done.gridKey).map(done => done.gridKey)] }));
        sendResponse(items);
        break;
      }
      case "APPEND_ITEMS":
        // orderIndex gắn cố định lúc thêm vào hàng đợi (nối tiếp số lớn nhất
        // đang có) để tên file luôn khớp thứ tự dòng trong Excel, kể cả khi
        // sau đó có xoá bớt mục hay chạy lại.
        sendResponse(await setState(state => {
          const base = state.items.reduce((max, it) => Math.max(max, Number(it.orderIndex) || 0),
            Math.max(0, (Number(state.startIndex) || 1) - 1));
          return { items: [...state.items, ...msg.items.map((item, i) => ({ ...item, orderIndex: base + i + 1 }))] };
        }));
        break;
      case "REMOVE_ITEM":
        sendResponse(await setState(state => {
          const items = state.items.filter(item => item.id !== msg.id);
          return { items, downloads: pruneDownloadsFor(state.downloads, items.map(it => it.id)) };
        }));
        break;
      case "CLEAR_COMPLETED":
        sendResponse(await setState(state => {
          const items = state.items.filter(item => item.status !== "done");
          return { items, downloads: pruneDownloadsFor(state.downloads, items.map(it => it.id)) };
        }));
        break;
      case "RETRY_FAILED":
        // Đưa các mục Lỗi/Cần kiểm tra về Chờ để gửi lại; giữ nguyên orderIndex
        // nên tên file vẫn đúng số thứ tự cũ.
        sendResponse(await setState(state => ({ items: state.items.map(item =>
          ["error", "review"].includes(item.status)
            ? { ...item, status: "pending", note: "", debugTextInserted: false, debugSubmitAttempted: false }
            : item) })));
        break;
      case "SET_FILENAME_TEMPLATE":
        sendResponse(await setState({ filenameTemplate: String(msg.template || "").trim() || "{index}_{n}" }));
        break;
      case "SET_START_INDEX":
        sendResponse(await setState({ startIndex: Math.max(1, Math.min(9999, Math.floor(Number(msg.startIndex) || 1))) }));
        break;
      case "DISMISS_FILENAME_MISMATCH":
        sendResponse(await setState({ lastFilenameMismatch: null }));
        break;
      case "SET_MAX_IN_FLIGHT":
        sendResponse(await setState({ maxInFlight: flightLimit(msg) }));
        wakeQueue();
        break;
      case "SET_INPUT_MODE": {
        if (queueTask) throw new Error("Dừng hàng đợi trước khi đổi chế độ điều khiển.");
        await debugInput.detach();
        sendResponse(await setState({ inputMode: msg.inputMode === "dom" ? "dom" : "debugger" }));
        break;
      }
      case "RETRY_DOWNLOAD": {
        const state = await getState();
        const item = state.items.find(it => it.id === msg.id);
        if (item?.mediaUrls?.length) await downloadMedia(item.mediaUrls, item.text, state.downloadSubfolder, item.id,
          item.completedAt, item.orderIndex, state.filenameTemplate);
        sendResponse(await getState());
        break;
      }
      case "RETRY_ALL_DOWNLOADS": {
        const state = await getState();
        for (const item of state.items.filter(it => it.mediaUrls?.length)) {
          await downloadMedia(item.mediaUrls, item.text, state.downloadSubfolder, item.id,
            item.completedAt, item.orderIndex, state.filenameTemplate);
        }
        sendResponse(await getState());
        break;
      }
      case "CONFIRM_REVIEW":
        sendResponse(await setState(state => ({ items: state.items.map(item =>
          item.id === msg.id && item.status === "review" ? { ...item, status: "error", note: "Đã kiểm tra thủ công. Không tự gửi lại prompt này." } : item) })));
        break;
      case "SET_DELAY_RANGE":
        sendResponse(
          await setState({ delayMinSeconds: msg.delayMinSeconds, delayMaxSeconds: msg.delayMaxSeconds })
        );
        break;
      case "SET_CONTINUOUS_MODE":
        sendResponse(await setState({ continuousMode: !!msg.continuousMode }));
        break;
      case "SET_DEFAULT_SETTINGS": {
        sendResponse(await setState(state => ({ defaultSettings: { ...state.defaultSettings, ...msg.patch } })));
        break;
      }
      case "SET_AUTO_DOWNLOAD":
        sendResponse(await setState({ autoDownload: !!msg.autoDownload }));
        break;
      case "SET_SUBFOLDER":
        sendResponse(await setState({ downloadSubfolder: msg.subfolder || "" }));
        break;
      case "CLEAR_LOGS":
        sendResponse(await setState({ logs: [] }));
        break;
      case "DIAG_TEST_DOWNLOAD": {
        // Chẩn đoán tạm thời: tải 1 file KHÔNG liên quan tới Midjourney (để
        // loại trừ CDN/host_permissions) với tên tuỳ chỉnh, rồi đối chiếu
        // tên Chrome/Brave thực sự lưu — xác định đây là hành vi chung của
        // trình duyệt hay chỉ riêng với link CDN Midjourney.
        const testFilename = "midjourney-output/_diag_test_" + Date.now() + ".ico";
        await log("info", "Chẩn đoán: yêu cầu tải favicon Google với tên " + testFilename);
        const id = await chrome.downloads.download({ url: "https://www.google.com/favicon.ico", filename: testFilename, conflictAction: "uniquify" });
        await new Promise((r) => setTimeout(r, 1500));
        const [dl] = await chrome.downloads.search({ id });
        await log("info", "Chẩn đoán kết quả — yêu cầu: " + testFilename + " — Chrome/Brave thực tế lưu: " +
          (dl?.filename || "(không rõ)") + " — trạng thái: " + (dl?.state || "?"));
        sendResponse(await getState());
        break;
      }
      case "ATTACH_ACTIVE_TAB": {
        if (queueTask) throw new Error("Dừng hàng đợi trước khi đổi tab.");
        const MJ_URL_RE = /^https:\/\/(www\.)?midjourney\.com\//i;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // Tab đang active trong cửa sổ hiện tại (nơi vừa bấm nút) là ưu tiên
        // hàng đầu — đúng cái người dùng đang nhìn. Chỉ khi đó KHÔNG phải tab
        // Midjourney (vd. side panel mở trong cửa sổ khác tab đích) mới tìm
        // trong mọi cửa sổ, ưu tiên tab được dùng gần nhất.
        let tab = activeTab && MJ_URL_RE.test(activeTab.url || "") ? activeTab : null;
        if (!tab) {
          const candidates = await chrome.tabs.query({ url: ["https://www.midjourney.com/*", "https://midjourney.com/*"] });
          candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          tab = candidates[0] || null;
        }
        if (!tab) throw new Error("Hãy mở tab Midjourney trước khi gắn tab.");
        sendResponse(await setState({ tabId: tab.id }));
        break;
      }
      case "START":
        runQueue();
        sendResponse(await getState());
        break;
      case "PAUSE":
        queueEpoch++;
        wakeQueue();
        await debugInput.detach();
        sendResponse(await setState({ paused: true, running: false }));
        break;
      case "STOP": {
        queueEpoch++;
        wakeQueue();
        await debugInput.detach();
        sendResponse(await setState({ running: false, paused: false, pauseReason: "Đã dừng gửi. Job đã gửi vẫn được theo dõi." }));
        break;
      }
      case "CLEAR":
        queueEpoch++;
        wakeQueue();
        await debugInput.detach();
        sendResponse(await setState({ items: [], downloads: {}, running: false, paused: false, pauseReason: "" }));
        break;
      default:
        sendResponse(null);
    }
  })().catch(err => sendResponse({ error: String(err.message || err) }));
  return true;
});
