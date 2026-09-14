// Quản lý hàng đợi prompt và điều phối giữa side panel <-> content script.
// Bản dành riêng cho Midjourney web.

const ACTION_TYPE = "FILL_AND_SUBMIT_MJ";
const STORAGE_KEY = "paf_state";

const MAX_LOGS = 300;

const DEFAULT_STATE = {
  items: [], // { id, text, status: 'pending'|'running'|'generating'|'done'|'error', note }
  running: false,
  paused: false,
  continuousMode: false,
  maxInFlight: 1,
  pauseReason: "",
  downloads: {},
  delayMinSeconds: 8,
  delayMaxSeconds: 20,
  tabId: null,
  autoDownload: false,
  downloadSubfolder: "midjourney-output",
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

async function recordDownloadStatus(downloadId) {
  const state = await getState();
  const saved = state.downloads[downloadId];
  if (!saved || saved.status !== "downloading") return;
  const [download] = await chrome.downloads.search({ id: Number(downloadId) });
  if (download && download.state === "in_progress") return;
  const status = download?.state === "complete" ? "complete" : "interrupted";
  const error = status === "complete" ? "" : (download?.error || "Không tìm thấy lượt tải trong Chrome.");
  let changed = false;
  await setState(current => {
    const previous = current.downloads[downloadId];
    if (!previous || previous.status !== "downloading") return {};
    changed = true;
    return { downloads: { ...current.downloads, [downloadId]: { ...previous, status, error } } };
  });
  if (changed) await log(status === "complete" ? "success" : "error",
    status === "complete" ? "Đã tải xong: " + saved.filename : "Tải bị gián đoạn: " + saved.filename + " — " + error);
}

async function reconcileDownloadIntent(key, record) {
  const matches = (await chrome.downloads.search({ url: record.url })).filter(file => {
    const filename = (file.filename || "").replace(/\\/g, "/");
    return (filename === record.filename || filename.endsWith("/" + record.filename)) &&
      Date.parse(file.startTime) >= record.startedAt - 2000;
  });
  if (matches.length === 1) {
    const id = matches[0].id;
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
async function downloadMedia(urls, promptText, subfolder, requestId) {
  if (downloadsInProgress.has(requestId)) return;
  downloadsInProgress.add(requestId);
  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const before = await getState();
      const prior = Object.values(before.downloads).find(d => d.requestId === requestId && d.url === url &&
        ["complete", "downloading", "starting"].includes(d.status));
      if (prior) continue;
      const key = "starting:" + requestId + ":" + i;
      let filename = "";
      try {
        const ext = mediaExtension(url);
        const folder = downloadFolder(subfolder);
        const name = sanitizeFilename(requestId) + "_" + sanitizeFilename(promptText) + "_" + (i + 1) + "." + ext;
        filename = folder ? folder + "/" + name : name;
        // Save intent before asking Chrome, so suspension is visible, not silent.
        await setState(state => ({ downloads: { ...state.downloads,
          [key]: { requestId, url, filename, status: "starting", startedAt: Date.now() } } }));
        const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
        if (typeof id !== "number") throw new Error("Chrome không trả về mã lượt tải.");
        await setState(state => {
          const downloads = { ...state.downloads };
          delete downloads[key];
          downloads[id] = { requestId, url, filename, status: "downloading", startedAt: Date.now() };
          return { downloads };
        });
        await log("info", "Đã bắt đầu tải: " + filename);
        // Covers completion before the onChanged listener can see the saved ID.
        await recordDownloadStatus(id);
      } catch (err) {
        await setState(state => ({ downloads: { ...state.downloads,
          [key]: { requestId, url, filename, status: "interrupted", error: String(err.message || err) } } }));
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

async function pauseQueue(reason) {
  queueEpoch++;
  await setState({ running: false, paused: true, pauseReason: reason });
  await log("error", reason);
}

async function runQueue() {
  if (queueTask) return queueTask;
  const epoch = ++queueEpoch;
  queueTask = processQueue(epoch).finally(() => { queueTask = null; });
  return queueTask;
}

async function processQueue(epoch) {
  try {
    let state = await getState();
    if (!state.tabId) throw new Error("Chưa gắn tab Midjourney.");
    await setState({ running: true, paused: false, pauseReason: "" });
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
        await sleep(1000);
        continue;
      }
      reportedWait = false;
      const item = state.items[idx];
      await updateItem(item.id, { status: "running", tabId: state.tabId, startedAt: Date.now(), note: "" });
      await log("info", "Đang gửi: " + item.text.slice(0, 60));
      let result;
      try {
        result = await sendToTab(state.tabId, { type: ACTION_TYPE, text: item.text,
          requestId: item.id, settingsConfig: state.defaultSettings });
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
          note: result.note || "", excludedKeys: result.excludedKeys || [], startedAt: result.startedAt || it.startedAt };
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
        while (epoch === queueEpoch && Date.now() < until) await sleep(Math.min(500, until - Date.now()));
      }
    }
  } catch (err) {
    await pauseQueue(String(err.message || err));
  }
}

async function handleJobResult(msg, sender) {
  let accepted = false;
  let item;
  const state = await setState(current => ({ items: current.items.map(it => {
    if (it.id !== msg.requestId || !["running", "generating"].includes(it.status)) return it;
    if (sender?.tab?.id !== it.tabId && it.tabId != null) return it;
    accepted = true;
    item = it;
    return { ...it, status: msg.ok ? "done" : "review", note: msg.note || "",
      mediaUrls: msg.mediaUrls || [], gridKey: msg.gridKey || "", completedAt: Date.now() };
  }) }));
  if (!accepted) return;
  await log(msg.ok ? "success" : "error", msg.note || (msg.ok ? "Đã tạo xong ảnh." : "Chưa xác nhận được ảnh."));
  if (!msg.ok) await pauseQueue(msg.note || "Job cần kiểm tra thủ công trước khi gửi tiếp.");
  if (msg.ok && state.autoDownload && msg.mediaUrls?.length) {
    await downloadMedia(msg.mediaUrls, item.text, state.downloadSubfolder, item.id);
  }
}

// Worker restart does not prove that an interrupted submit failed.
const startupReady = (async () => {
  await setState(state => ({ running: false,
    paused: state.running ? true : state.paused,
    pauseReason: state.running ? "Tiện ích vừa khởi động lại. Kiểm tra job đang gửi rồi bấm Chạy để tiếp tục." : state.pauseReason,
    items: state.items.map(it => it.status === "running" ? { ...it, status: "review",
      note: "Tiện ích khởi động lại khi đang gửi; cần kiểm tra trên Midjourney." } : it) }));
  const state = await getState();
  for (const [id, record] of Object.entries(state.downloads)) {
    if (record.status === "downloading") await recordDownloadStatus(id);
    if (record.status === "starting") {
      await reconcileDownloadIntent(id, record);
    }
  }
})().catch(console.error);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
      case "SET_ITEMS":
        sendResponse(await setState(state => ({ items: msg.items.map(item =>
          state.items.find(existing => existing.id === item.id) || item) })));
        break;
      case "APPEND_ITEMS":
        sendResponse(await setState(state => ({ items: [...state.items, ...msg.items] })));
        break;
      case "REMOVE_ITEM":
        sendResponse(await setState(state => ({ items: state.items.filter(item => item.id !== msg.id) })));
        break;
      case "SET_MAX_IN_FLIGHT":
        sendResponse(await setState({ maxInFlight: flightLimit(msg) }));
        break;
      case "RETRY_DOWNLOAD": {
        const state = await getState();
        const item = state.items.find(it => it.id === msg.id);
        if (item?.mediaUrls?.length) await downloadMedia(item.mediaUrls, item.text, state.downloadSubfolder, item.id);
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
      case "ATTACH_ACTIVE_TAB": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !/^https:\/\/(www\.)?midjourney\.com\//i.test(tab.url)) throw new Error("Hãy mở tab Midjourney trước khi gắn tab.");
        sendResponse(await setState({ tabId: tab ? tab.id : null }));
        break;
      }
      case "START":
        runQueue();
        sendResponse(await getState());
        break;
      case "PAUSE":
        queueEpoch++;
        sendResponse(await setState({ paused: true, running: false }));
        break;
      case "STOP": {
        queueEpoch++;
        sendResponse(await setState({ running: false, paused: false, pauseReason: "Đã dừng gửi. Job đã gửi vẫn được theo dõi." }));
        break;
      }
      case "CLEAR":
        queueEpoch++;
        sendResponse(await setState({ items: [], running: false, paused: false, pauseReason: "" }));
        break;
      default:
        sendResponse(null);
    }
  })().catch(err => sendResponse({ error: String(err.message || err) }));
  return true;
});
