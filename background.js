// Quản lý hàng đợi prompt và điều phối giữa side panel <-> content script.
// Bản dành riêng cho Midjourney web.

const ACTION_TYPE = "FILL_AND_SUBMIT_MJ";
const STORAGE_KEY = "paf_state";

const MAX_LOGS = 300;

const DEFAULT_STATE = {
  items: [], // { id, text, status: 'pending'|'running'|'generating'|'done'|'error', note }
  running: false,
  paused: false,
  delayMinSeconds: 8,
  delayMaxSeconds: 20,
  tabId: null,
  autoDownload: false,
  downloadSubfolder: "midjourney-output",
  logs: [], // { ts, level: 'info'|'success'|'error', message }
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || structuredClone(DEFAULT_STATE);
}

async function setState(patch) {
  const state = await getState();
  const next = { ...state, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  broadcast(next);
  return next;
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
  const state = await getState();
  const entry = { ts: Date.now(), level, message };
  const logs = [...state.logs, entry].slice(-MAX_LOGS);
  await setState({ logs });
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

// Ảnh trong lưới kết quả của Midjourney là .webp — chuyển sang .png theo yêu
// cầu bằng OffscreenCanvas + createImageBitmap (đều dùng được trong service
// worker của Manifest V3, không cần DOM/thẻ <img> hay <canvas> thật).
async function convertToPngBlob(sourceUrl) {
  const resp = await fetch(sourceUrl);
  if (!resp.ok) throw new Error(`Tải ảnh gốc thất bại (HTTP ${resp.status})`);
  const sourceBlob = await resp.blob();
  const bitmap = await createImageBitmap(sourceBlob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function downloadMedia(urls, promptText, subfolder) {
  if (!urls || urls.length === 0) return { successCount: 0, total: 0 };
  const base = sanitizeFilename(promptText);
  const stamp = timestampSlug();
  const folder = (subfolder || "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  let successCount = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const name = urls.length > 1 ? `${stamp}_${base}_${i + 1}.png` : `${stamp}_${base}.png`;
    const filename = folder ? `${folder}/${name}` : name;
    let objectUrl = null;
    try {
      const pngBlob = await convertToPngBlob(url);
      objectUrl = URL.createObjectURL(pngBlob);
      await chrome.downloads.download({ url: objectUrl, filename, conflictAction: "uniquify" });
      successCount++;
    } catch (err) {
      console.warn("Tải/chuyển sang PNG thất bại:", url, err);
    } finally {
      if (objectUrl) {
        // Trì hoãn thu hồi object URL để chắc chắn download đã đọc xong dữ liệu.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      }
    }
  }
  return { successCount, total: urls.length };
}

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

async function runOnePrompt(text, tabId, requestId) {
  if (!tabId) throw new Error("Chưa chọn tab đích. Mở tab Midjourney rồi bấm 'Gắn tab này'.");

  const response = await sendToTab(tabId, { type: ACTION_TYPE, text, requestId });

  if (!response) {
    throw new Error("Không nhận được phản hồi từ trang. Trang có thể chưa tải xong hoặc sai URL.");
  }
  if (response.rateLimited) {
    throw new Error("Phát hiện giới hạn tốc độ / lỗi trên trang: " + (response.note || ""));
  }
  return { ok: response.ok, note: response.note, submitted: !!response.submitted };
}

async function runQueue() {
  let state = await getState();
  if (state.running) return;
  state = await setState({ running: true, paused: false });
  await log("info", "Bắt đầu chạy hàng đợi.");

  while (true) {
    state = await getState();
    if (!state.running || state.paused) break;

    const idx = findNextPendingIndex(state);
    if (idx === -1) break;

    const item = state.items[idx];
    state.items[idx] = { ...item, status: "running" };
    state = await setState({ items: state.items });
    await log("info", `Đang gửi: "${item.text.slice(0, 60)}"`);

    try {
      // Không chờ ảnh render xong ở đây — chỉ chờ xác nhận đã gửi thành công
      // rồi chuyển ngay sang chờ/gửi prompt kế tiếp theo đúng khoảng thời
      // gian ngẫu nhiên đã đặt. Việc theo dõi khi nào ảnh thực sự xong (để
      // cập nhật "Xong" + tự tải file) chạy bất đồng bộ trong content script
      // và báo kết quả về qua message "MJ_JOB_RESULT" (xem handler bên dưới).
      const result = await runOnePrompt(item.text, state.tabId, item.id);
      state = await getState();
      state.items[idx] = {
        ...state.items[idx],
        status: result.ok ? "generating" : "error",
        note: result.note || "",
      };
      await setState({ items: state.items });
      await log(
        result.ok ? "info" : "error",
        result.ok ? "Đã gửi, đang chờ Midjourney tạo ảnh..." : `Thất bại: ${result.note || ""}`
      );
    } catch (err) {
      state = await getState();
      const msg = String(err && err.message ? err.message : err);
      state.items[idx] = { ...state.items[idx], status: "error", note: msg };
      await setState({ items: state.items, running: false });
      await log("error", `Dừng hàng đợi do lỗi: ${msg}`);
      break;
    }

    state = await getState();
    if (!state.running || state.paused) break;
    const waitMs = randomDelayMs(state.delayMinSeconds || 8, state.delayMaxSeconds || 20);
    await log("info", `Chờ ${Math.round(waitMs / 1000)}s trước prompt tiếp theo...`);
    await sleep(waitMs);
  }

  state = await getState();
  if (findNextPendingIndex(state) === -1) {
    await setState({ running: false });
    await log("info", "Đã gửi hết hàng đợi (ảnh đang \"Đang tạo\" vẫn được theo dõi ngầm để cập nhật khi xong).");
  }
}

async function handleJobResult(msg) {
  const state = await getState();
  const idx = state.items.findIndex((it) => it.id === msg.requestId);
  if (idx === -1) return; // hàng đợi đã bị xoá/thay đổi trước khi có kết quả

  const item = state.items[idx];
  state.items[idx] = {
    ...item,
    status: msg.ok ? "done" : "error",
    note: msg.note || "",
  };
  await setState({ items: state.items });
  await log(msg.ok ? "success" : "error", msg.ok ? "Đã tạo xong ảnh." : `Thất bại: ${msg.note || ""}`);

  if (msg.ok && state.autoDownload && msg.mediaUrls && msg.mediaUrls.length > 0) {
    const result = await downloadMedia(msg.mediaUrls, item.text, state.downloadSubfolder);
    if (result.successCount === result.total) {
      await log("info", `Đã tải ${result.successCount} file PNG.`);
    } else {
      await log(
        "error",
        `Chỉ tải được ${result.successCount}/${result.total} file PNG — kiểm tra Downloads hoặc thử tải thủ công.`
      );
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "MJ_JOB_RESULT") {
    handleJobResult(msg);
    return false; // content script không cần chờ phản hồi cho message này
  }

  (async () => {
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
          .filter((it) => it.status === "generating")
          .map((it) => ({ requestId: it.id, text: it.text }));
        sendResponse(items);
        break;
      }
      case "SET_ITEMS":
        sendResponse(await setState({ items: msg.items }));
        break;
      case "SET_DELAY_RANGE":
        sendResponse(
          await setState({ delayMinSeconds: msg.delayMinSeconds, delayMaxSeconds: msg.delayMaxSeconds })
        );
        break;
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
        sendResponse(await setState({ tabId: tab ? tab.id : null }));
        break;
      }
      case "START":
        runQueue();
        sendResponse(await getState());
        break;
      case "PAUSE":
        sendResponse(await setState({ paused: true, running: false }));
        break;
      case "STOP": {
        const state = await getState();
        const items = state.items.map((it) => (it.status === "running" ? { ...it, status: "pending" } : it));
        sendResponse(await setState({ items, running: false, paused: false }));
        break;
      }
      case "CLEAR":
        sendResponse(await setState({ items: [] }));
        break;
      default:
        sendResponse(null);
    }
  })();
  return true;
});
