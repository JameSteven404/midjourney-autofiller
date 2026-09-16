const tabs = document.querySelectorAll(".tab");
const tabPanels = {
  control: document.getElementById("tab-control"),
  settings: document.getElementById("tab-settings"),
  logs: document.getElementById("tab-logs"),
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    Object.entries(tabPanels).forEach(([key, el]) => {
      el.classList.toggle("hidden", key !== tab.dataset.tab);
    });
  });
});

const attachTabBtn = document.getElementById("attachTab");
const attachedInfo = document.getElementById("attachedInfo");
const delayMinEl = document.getElementById("delayMin");
const delayMaxEl = document.getElementById("delayMax");
const continuousModeEl = document.getElementById("continuousMode");
const continuousHintEl = document.getElementById("continuousHint");
const maxInFlightEl = document.getElementById("maxInFlight");
const queueProgressEl = document.getElementById("queueProgress");
const queuePauseReasonEl = document.getElementById("queuePauseReason");
const inputModeEl = document.getElementById("inputMode");
const debugStatusEl = document.getElementById("debugStatus");
const queueTimingEl = document.getElementById("queueTiming");
const retryAllDownloadsBtn = document.getElementById("retryAllDownloads");
const retryFailedBtn = document.getElementById("retryFailed");
const clearCompletedBtn = document.getElementById("clearCompleted");
const progressFillEl = document.getElementById("progressFill");
const filenameAlertEl = document.getElementById("filenameAlert");
const filenameAlertDetailEl = document.getElementById("filenameAlertDetail");
const dismissFilenameAlertBtn = document.getElementById("dismissFilenameAlert");
const filenameTemplateEl = document.getElementById("filenameTemplate");
const startIndexEl = document.getElementById("startIndex");
const filenamePreviewEl = document.getElementById("filenamePreview");
const exportReportBtn = document.getElementById("exportReport");
const pasteArea = document.getElementById("pasteArea");
const addFromPasteBtn = document.getElementById("addFromPaste");
const importTextFile = document.getElementById("importTextFile");
const importXlsxFile = document.getElementById("importXlsxFile");
const queueListEl = document.getElementById("queueList");
const queueCountEl = document.getElementById("queueCount");
const emptyHintEl = document.getElementById("emptyHint");
const clearQueueBtn = document.getElementById("clearQueue");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const autoDownloadEl = document.getElementById("autoDownload");
const downloadSubfolderEl = document.getElementById("downloadSubfolder");
const logListEl = document.getElementById("logList");
const emptyLogHintEl = document.getElementById("emptyLogHint");
const clearLogsBtn = document.getElementById("clearLogs");
const tabStatusBar = document.getElementById("tabStatusBar");
const tabStatusIcon = document.getElementById("tabStatusIcon");
const tabStatusText = document.getElementById("tabStatusText");
const attachTabQuickBtn = document.getElementById("attachTabQuick");
const runWarningEl = document.getElementById("runWarning");
const xlsxModalOverlay = document.getElementById("xlsxModalOverlay");
const xlsxModalClose = document.getElementById("xlsxModalClose");
const xlsxFileNameEl = document.getElementById("xlsxFileName");
const xlsxSheetSelect = document.getElementById("xlsxSheetSelect");
const xlsxColumnSelect = document.getElementById("xlsxColumnSelect");
const xlsxPreviewList = document.getElementById("xlsxPreviewList");
const xlsxPreviewHint = document.getElementById("xlsxPreviewHint");
const xlsxCancelBtn = document.getElementById("xlsxCancelBtn");
const xlsxImportBtn = document.getElementById("xlsxImportBtn");
const xlsxImportCountEl = document.getElementById("xlsxImportCount");
const cfgAspectRatioEl = document.getElementById("cfgAspectRatio");
const cfgModelVersionEl = document.getElementById("cfgModelVersion");
const cfgModelRawEl = document.getElementById("cfgModelRaw");
const cfgStylizationEl = document.getElementById("cfgStylization");
const cfgWeirdnessEl = document.getElementById("cfgWeirdness");
const cfgVarietyEl = document.getElementById("cfgVariety");
const cfgSpeedEl = document.getElementById("cfgSpeed");
const cfgStealthEl = document.getElementById("cfgStealth");
const cfgVideoResolutionEl = document.getElementById("cfgVideoResolution");
const cfgVideoBatchSizeEl = document.getElementById("cfgVideoBatchSize");

function sendMsg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, response => {
    const error = chrome.runtime.lastError?.message || response?.error;
    if (error) {
      runWarningEl.textContent = error;
      runWarningEl.classList.remove("hidden");
      resolve(null);
    } else resolve(response);
  }));
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const STATUS_LABEL = {
  pending: "Chờ",
  running: "Đang gửi",
  generating: "Đang tạo",
  done: "Xong",
  error: "Lỗi",
  review: "Cần kiểm tra",
};

let lastState = null;
let lastQueueRenderKey = "";
let lastLogsRenderKey = "";
// Giữ lại đúng phần tử <li> của mỗi item giữa các lần render (khớp theo
// item.id) — trước đây mỗi lần state.items/state.downloads đổi (rất thường
// xuyên lúc chạy: mỗi lần đổi trạng thái, mỗi ảnh bắt đầu/xong tải) code xoá
// sạch cả <ul> rồi dựng lại từ đầu, khiến animation "xuất hiện" của .queue-list
// li (itemIn, xem sidepanel.css) replay cho toàn bộ danh sách mỗi lần — đó là
// hiện tượng nhấp nháy. Giờ chỉ tạo <li> mới cho item thật sự mới, cập nhật
// nội dung tại chỗ cho item đã có, và chỉ xoá <li> của item đã rời hàng đợi.
const queueItemEls = new Map();

// Xem trước tên file đúng như background.js sẽ tạo, để chỉnh mẫu thấy ngay
// kết quả thay vì phải chạy thử rồi mới biết sai.
function renderFilenamePreview(state) {
  const pad3 = (v) => String(Math.max(0, Math.floor(Number(v) || 0))).padStart(3, "0");
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  const index = Number(state.startIndex) || 1;
  // Lấy seed thật từ prompt đầu tiên trong hàng đợi nếu có, để xem trước đúng
  // với dữ liệu thật thay vì số minh hoạ.
  const realSeed = (state.items || []).map(it => (String(it.text || "").match(/[-–—]{1,2}\s*seed\s+(\d{1,20})/i) || [])[1])
    .find(Boolean);
  const tokens = {
    index: pad3(index),
    n: "1",
    seq: pad3(index),
    seed: realSeed || "52000101",
    date: `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`,
    time: `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`,
    prompt: "a_realistic_digital_painting_of_prehistoric_survival",
    job: "e69a2e3ac6fd",
    jobfull: "e69a2e3a-c6fd-4789-9e94-c1013ef8f92b",
  };
  const base = String(state.filenameTemplate || "{index}_{n}")
    .replace(/\{(index|n|seq|seed|date|time|prompt|jobfull|job)\}/g, (_, key) => tokens[key])
    .replace(/[\\/:*?"<>|]+/g, "_").replace(/_{2,}/g, "_").replace(/^[_\-.]+|[_\-.]+$/g, "")
    .trim().slice(0, 120).replace(/[._ ]+$/g, "") || `${tokens.index}_1`;
  const folder = (state.downloadSubfolder || "").trim();
  filenamePreviewEl.textContent = "Ví dụ: " + (folder ? folder + "/" : "") + base + ".webp";
}

function renderTiming() {
  if (!lastState) return;
  const samples = lastState.items.map(item => item.submitDurationMs).filter(Number.isFinite);
  const average = samples.length ? (samples.reduce((a, b) => a + b, 0) / samples.length / 1000).toFixed(2) : null;
  const countdown = lastState.running && lastState.nextSubmitAt ? Math.max(0, Math.ceil((lastState.nextSubmitAt - Date.now()) / 1000)) : 0;
  queueTimingEl.textContent = [countdown ? `Gửi tiếp sau ${countdown}s` : "",
    average ? `Thời gian gửi trung bình: ${average}s (${samples.length} prompt)` : ""].filter(Boolean).join(" • ");
}
setInterval(renderTiming, 1000);

// Dựng lại nội dung của đúng 1 <li> có sẵn (không tạo mới) — tách riêng khỏi
// renderQueueList để giữ nguyên phần tử <li> giữa các lần render, tránh
// replay animation "xuất hiện" (xem ghi chú tại khai báo queueItemEls).
function buildQueueItemBody(li, item, state) {
  li.innerHTML = "";

  // Số thứ tự hiển thị đúng bằng số sẽ dùng trong tên file, để đối chiếu
  // nhanh giữa hàng đợi, dòng Excel và file trong thư mục tải về.
  const order = document.createElement("span");
  order.className = "order-badge";
  order.textContent = String(item.orderIndex || 0).padStart(3, "0");
  order.title = "Số thứ tự dùng trong tên file";

  const badge = document.createElement("span");
  badge.className = `badge ${item.status}`;
  badge.textContent = STATUS_LABEL[item.status] || item.status;

  const text = document.createElement("span");
  text.className = "text";
  text.title = item.text + (item.note ? `\n\n${item.note}` : "");
  text.textContent = item.text;

  const removeBtn = document.createElement("span");
  removeBtn.className = "removeBtn";
  removeBtn.textContent = "✕";
  removeBtn.title = "Xoá khỏi hàng đợi";
  removeBtn.addEventListener("click", async () => {
    renderState(await sendMsg({ type: "REMOVE_ITEM", id: item.id }));
  });

  const details = document.createElement("div");
  details.className = "queue-item-details";
  details.appendChild(text);
  if (item.note) {
    const note = document.createElement("small");
    note.textContent = item.note;
    details.appendChild(note);
  }
  const records = Object.values(state.downloads || {}).filter(record => record.requestId === item.id);
  if (item.mediaUrls?.length) {
    const completed = new Set(records.filter(r => r.status === "complete").map(r => r.sourceUrl || r.url)).size;
    const downloading = records.filter(r => ["downloading", "starting"].includes(r.status));
    const summary = document.createElement("small");
    summary.textContent = `Đã tải: ${completed}/${item.mediaUrls.length}` + (downloading.length ? ` • Đang tải: ${downloading.length}` : "");
    details.appendChild(summary);
    const errors = [...new Set(records.filter(r => r.status === "interrupted" && r.error).map(r => r.error))];
    if (errors.length && completed < item.mediaUrls.length) {
      const error = document.createElement("small");
      error.textContent = errors.join(" • ");
      details.appendChild(error);
    }
    // Trước đây khoá nút này bất cứ khi nào có BẤT KỲ ảnh nào trong item còn
    // đang tải, dù ảnh khác đã lỗi (interrupted) có thể tải lại ngay — tính
    // đúng số ảnh còn thiếu thật (chưa xong và chưa đang tải) thay vì chỉ
    // hỏi "có ảnh nào đang tải hay không".
    if (item.mediaUrls.length - completed - downloading.length > 0) {
      const retry = document.createElement("button");
      retry.className = "ghost small";
      retry.textContent = "Tải ảnh còn thiếu";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        renderState(await sendMsg({ type: "RETRY_DOWNLOAD", id: item.id }));
      });
      details.appendChild(retry);
    }
  }
  if (item.status === "review") {
    const checked = document.createElement("button");
    checked.className = "ghost small";
    checked.textContent = "Đã kiểm tra trên Midjourney — bỏ qua";
    checked.addEventListener("click", async () => renderState(await sendMsg({ type: "CONFIRM_REVIEW", id: item.id })));
    details.appendChild(checked);
  }
  li.appendChild(order);
  li.appendChild(badge);
  li.appendChild(details);
  li.appendChild(removeBtn);
}

// Đối chiếu theo item.id: chỉ tạo <li> mới cho item thật sự mới, cập nhật nội
// dung tại chỗ cho item đã có (không đụng tới phần tử DOM của nó), chỉ xoá
// <li> của item đã rời hàng đợi, và chỉ di chuyển <li> nào thực sự sai vị trí.
function renderQueueList(state) {
  const seen = new Set();
  let prevSibling = null;
  for (const item of state.items) {
    seen.add(item.id);
    let li = queueItemEls.get(item.id);
    if (!li) {
      li = document.createElement("li");
      queueItemEls.set(item.id, li);
    }
    buildQueueItemBody(li, item, state);
    const expectedNext = prevSibling ? prevSibling.nextSibling : queueListEl.firstChild;
    if (expectedNext !== li) queueListEl.insertBefore(li, expectedNext);
    prevSibling = li;
  }
  for (const [id, li] of queueItemEls) {
    if (!seen.has(id)) {
      li.remove();
      queueItemEls.delete(id);
    }
  }
}

function renderState(state) {
  if (!state) return;
  lastState = state;
  inputModeEl.value = state.inputMode || "debugger";
  inputModeEl.disabled = !!state.running;
  const debugLabels = { off: "chưa kết nối", connecting: "đang kết nối", attached: "đã kết nối", error: "lỗi kết nối" };
  debugStatusEl.textContent = state.inputMode === "dom" ? "Điều khiển: DOM" : `Điều khiển: Debug / CDP — ${debugLabels[state.debuggerStatus] || "chưa kết nối"}`;
  renderTiming();

  delayMinEl.value = state.delayMinSeconds;
  delayMaxEl.value = state.delayMaxSeconds;
  autoDownloadEl.checked = !!state.autoDownload;
  downloadSubfolderEl.value = state.downloadSubfolder || "";
  continuousModeEl.checked = !!state.continuousMode;
  maxInFlightEl.value = state.maxInFlight || 1;
  const active = state.items.filter(item => ["running", "generating"].includes(item.status)).length;
  const done = state.items.filter(item => item.status === "done").length;
  const failed = state.items.filter(item => ["error", "review"].includes(item.status)).length;
  queueProgressEl.textContent = state.items.length
    ? `Đã tạo ${done}/${state.items.length} • Đang gửi/tạo ${active}/${state.maxInFlight || 1}` + (failed ? ` • Cần xử lý ${failed}` : "")
    : "";
  progressFillEl.style.width = state.items.length ? Math.round((done / state.items.length) * 100) + "%" : "0%";
  retryFailedBtn.disabled = failed === 0;
  clearCompletedBtn.disabled = done === 0;
  retryAllDownloadsBtn.disabled = !state.items.some(item => item.mediaUrls?.length);
  queuePauseReasonEl.textContent = state.pauseReason || "";

  filenameTemplateEl.value = state.filenameTemplate || "{index}_{n}";
  startIndexEl.value = state.startIndex || 1;
  renderFilenamePreview(state);

  const mismatch = state.lastFilenameMismatch;
  filenameAlertEl.classList.toggle("hidden", !mismatch);
  if (mismatch) {
    filenameAlertDetailEl.textContent = `Yêu cầu "${mismatch.wanted}" nhưng lưu thành "${mismatch.actual}".`;
  }
  delayMinEl.disabled = !!state.continuousMode;
  delayMaxEl.disabled = !!state.continuousMode;
  if (continuousHintEl) {
    continuousHintEl.style.display = state.continuousMode ? "block" : "none";
  }

  const cfg = state.defaultSettings || {};
  cfgAspectRatioEl.value = cfg.aspectRatio || "";
  cfgModelVersionEl.value = cfg.modelVersion || "";
  cfgModelRawEl.value = cfg.modelRaw || "";
  cfgStylizationEl.value = cfg.stylization ?? "";
  cfgWeirdnessEl.value = cfg.weirdness ?? "";
  cfgVarietyEl.value = cfg.variety ?? "";
  cfgSpeedEl.value = cfg.speed || "";
  cfgStealthEl.value = cfg.stealth || "";
  cfgVideoResolutionEl.value = cfg.videoResolution || "";
  cfgVideoBatchSizeEl.value = cfg.videoBatchSize ? String(cfg.videoBatchSize) : "";

  attachedInfo.textContent = state.tabId
    ? `Đã gắn tab ID: ${state.tabId}`
    : "Chưa gắn tab đích — mở tab đích rồi bấm 'Gắn tab đang mở'.";

  if (state.tabId) {
    tabStatusBar.className = "tab-status attached";
    tabStatusIcon.textContent = "✓";
    tabStatusText.textContent = `Đã gắn tab (ID: ${state.tabId})`;
    attachTabQuickBtn.textContent = "Đổi tab";
    runWarningEl.classList.add("hidden");
  } else {
    tabStatusBar.className = "tab-status missing";
    tabStatusIcon.textContent = "⚠";
    tabStatusText.textContent = "Chưa gắn tab Midjourney";
    attachTabQuickBtn.textContent = "Gắn tab đang mở";
  }

  queueCountEl.textContent = state.items.length;
  emptyHintEl.classList.toggle("hidden", state.items.length > 0);
  const queueRenderKey = JSON.stringify([state.items, state.downloads]);
  if (queueRenderKey !== lastQueueRenderKey) {
    lastQueueRenderKey = queueRenderKey;
    renderQueueList(state);
  }

  startBtn.disabled = state.running;
  stopBtn.disabled = !state.running;
  startBtn.textContent = state.running ? "⏳ Đang chạy…" : "▶ Chạy";

  const logs = state.logs || [];
  emptyLogHintEl.classList.toggle("hidden", logs.length > 0);
  const logsRenderKey = JSON.stringify(logs);
  if (logsRenderKey === lastLogsRenderKey) return;
  lastLogsRenderKey = logsRenderKey;
  logListEl.innerHTML = "";
  for (const entry of logs) {
    const row = document.createElement("div");
    row.className = `log-entry ${entry.level}`;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date(entry.ts).toLocaleTimeString("vi-VN", { hour12: false });

    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = entry.message;

    row.appendChild(time);
    row.appendChild(msg);
    logListEl.appendChild(row);
  }
  logListEl.scrollTop = logListEl.scrollHeight;
}

async function refresh() {
  renderState(await sendMsg({ type: "GET_STATE" }));
}

function clampDelay(el, fallback) {
  const val = Math.max(1, Math.min(600, Number(el.value) || fallback));
  el.value = val;
  return val;
}

async function pushDelayRange() {
  const min = clampDelay(delayMinEl, 5);
  const max = clampDelay(delayMaxEl, 15);
  renderState(await sendMsg({ type: "SET_DELAY_RANGE", delayMinSeconds: min, delayMaxSeconds: max }));
}

delayMinEl.addEventListener("change", pushDelayRange);
delayMaxEl.addEventListener("change", pushDelayRange);

autoDownloadEl.addEventListener("change", async () => {
  renderState(await sendMsg({ type: "SET_AUTO_DOWNLOAD", autoDownload: autoDownloadEl.checked }));
});

continuousModeEl.addEventListener("change", async () => {
  renderState(await sendMsg({ type: "SET_CONTINUOUS_MODE", continuousMode: continuousModeEl.checked }));
});
maxInFlightEl.addEventListener("change", async () => {
  renderState(await sendMsg({ type: "SET_MAX_IN_FLIGHT", maxInFlight: Number(maxInFlightEl.value) }));
});
inputModeEl.addEventListener("change", async () => {
  renderState(await sendMsg({ type: "SET_INPUT_MODE", inputMode: inputModeEl.value }));
});
retryAllDownloadsBtn.addEventListener("click", async () => {
  retryAllDownloadsBtn.disabled = true;
  try { renderState(await sendMsg({ type: "RETRY_ALL_DOWNLOADS" })); }
  finally { retryAllDownloadsBtn.disabled = false; }
});
retryFailedBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "RETRY_FAILED" }));
});
clearCompletedBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "CLEAR_COMPLETED" }));
});
dismissFilenameAlertBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "DISMISS_FILENAME_MISMATCH" }));
});
filenameTemplateEl.addEventListener("change", async () => {
  renderState(await sendMsg({ type: "SET_FILENAME_TEMPLATE", template: filenameTemplateEl.value }));
});
filenameTemplateEl.addEventListener("input", () => {
  if (lastState) renderFilenamePreview({ ...lastState, filenameTemplate: filenameTemplateEl.value });
});
startIndexEl.addEventListener("change", async () => {
  renderState(await sendMsg({ type: "SET_START_INDEX", startIndex: startIndexEl.value }));
});
exportReportBtn.addEventListener("click", () => {
  if (!lastState) return;
  const report = { version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(),
    inputMode: lastState.inputMode, maxInFlight: lastState.maxInFlight,
    pauseReason: lastState.pauseReason, items: lastState.items, downloads: lastState.downloads, logs: lastState.logs };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `midjourney-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

function setDefaultSetting(field, value) {
  return sendMsg({ type: "SET_DEFAULT_SETTINGS", patch: { [field]: value } });
}

cfgAspectRatioEl.addEventListener("change", async () => {
  renderState(await setDefaultSetting("aspectRatio", cfgAspectRatioEl.value || null));
});
cfgModelVersionEl.addEventListener("change", async () => {
  renderState(await setDefaultSetting("modelVersion", cfgModelVersionEl.value || null));
});
cfgModelRawEl.addEventListener("change", async () => {
  renderState(await setDefaultSetting("modelRaw", cfgModelRawEl.value || null));
});
cfgStylizationEl.addEventListener("change", async () => {
  const v = cfgStylizationEl.value === "" ? null : Math.max(0, Math.min(1000, Number(cfgStylizationEl.value)));
  renderState(await setDefaultSetting("stylization", v));
});
cfgWeirdnessEl.addEventListener("change", async () => {
  const v = cfgWeirdnessEl.value === "" ? null : Math.max(0, Math.min(3000, Number(cfgWeirdnessEl.value)));
  renderState(await setDefaultSetting("weirdness", v));
});
cfgVarietyEl.addEventListener("change", async () => {
  const v = cfgVarietyEl.value === "" ? null : Math.max(0, Math.min(100, Number(cfgVarietyEl.value)));
  renderState(await setDefaultSetting("variety", v));
});
cfgSpeedEl.addEventListener("change", async () => {
  renderState(await setDefaultSetting("speed", cfgSpeedEl.value || null));
});
cfgStealthEl.addEventListener("change", async () => {
  renderState(await setDefaultSetting("stealth", cfgStealthEl.value || null));
});
cfgVideoResolutionEl.addEventListener("change", async () => {
  renderState(await setDefaultSetting("videoResolution", cfgVideoResolutionEl.value || null));
});
cfgVideoBatchSizeEl.addEventListener("change", async () => {
  const v = cfgVideoBatchSizeEl.value === "" ? null : Number(cfgVideoBatchSizeEl.value);
  renderState(await setDefaultSetting("videoBatchSize", v));
});

downloadSubfolderEl.addEventListener("change", async () => {
  renderState(await sendMsg({ type: "SET_SUBFOLDER", subfolder: downloadSubfolderEl.value }));
});

clearLogsBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "CLEAR_LOGS" }));
});

const diagTestDownloadBtn = document.getElementById("diagTestDownload");
diagTestDownloadBtn.addEventListener("click", async () => {
  diagTestDownloadBtn.disabled = true;
  try { renderState(await sendMsg({ type: "DIAG_TEST_DOWNLOAD" })); }
  finally { diagTestDownloadBtn.disabled = false; }
});

attachTabBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "ATTACH_ACTIVE_TAB" }));
});

attachTabQuickBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "ATTACH_ACTIVE_TAB" }));
});

async function appendPrompts(lines) {
  const cleaned = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (cleaned.length === 0) return;
  const newItems = cleaned.map((text) => ({ id: uid(), text, status: "pending", note: "" }));
  renderState(await sendMsg({ type: "APPEND_ITEMS", items: newItems }));
}

function autosizePasteArea() {
  pasteArea.style.height = "auto";
  const max = parseInt(getComputedStyle(pasteArea).maxHeight, 10) || 420;
  pasteArea.style.height = Math.min(pasteArea.scrollHeight, max) + "px";
}
pasteArea.addEventListener("input", autosizePasteArea);
autosizePasteArea();

addFromPasteBtn.addEventListener("click", async () => {
  await appendPrompts(pasteArea.value.split("\n"));
  pasteArea.value = "";
  autosizePasteArea();
});

importTextFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await appendPrompts((await file.text()).split("\n"));
  importTextFile.value = "";
});

// ===== Modal xem trước & chọn cột khi nhập file Excel =====
let xlsxWorkbook = null;
let xlsxRows = []; // mảng 2 chiều của sheet đang chọn, hàng 0 = header

function colLetter(index) {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function columnValues(colIndex) {
  // Bỏ hàng đầu (coi là header), lấy giá trị cột đã chọn ở các hàng còn lại.
  return xlsxRows
    .slice(1)
    .map((row) => (row && row[colIndex] != null ? String(row[colIndex]).trim() : ""))
    .filter((v) => v.length > 0);
}

function guessBestColumn(colCount) {
  // Đoán cột nhiều khả năng chứa prompt nhất: cột có độ dài trung bình lớn nhất
  // trong các ô dữ liệu (prompt thường là câu dài, khác cột số thứ tự/nhãn ngắn).
  let bestIdx = 0;
  let bestAvgLen = -1;
  for (let c = 0; c < colCount; c++) {
    const values = columnValues(c);
    if (values.length === 0) continue;
    const avgLen = values.reduce((sum, v) => sum + v.length, 0) / values.length;
    if (avgLen > bestAvgLen) {
      bestAvgLen = avgLen;
      bestIdx = c;
    }
  }
  return bestIdx;
}

function renderXlsxPreview() {
  const colIndex = Number(xlsxColumnSelect.value || 0);
  const values = columnValues(colIndex);

  xlsxPreviewList.innerHTML = "";
  if (values.length === 0) {
    const empty = document.createElement("div");
    empty.className = "modal-preview-empty";
    empty.textContent = "Cột này không có dữ liệu.";
    xlsxPreviewList.appendChild(empty);
  } else {
    values.slice(0, 8).forEach((val, i) => {
      const row = document.createElement("div");
      row.className = "modal-preview-row";
      const num = document.createElement("span");
      num.className = "row-num";
      num.textContent = `${i + 2}.`; // số dòng thật trong bảng tính (hàng 1 là header)
      const text = document.createElement("span");
      text.className = "row-text";
      text.textContent = val;
      row.appendChild(num);
      row.appendChild(text);
      xlsxPreviewList.appendChild(row);
    });
  }

  xlsxPreviewHint.textContent =
    values.length > 8 ? `Xem trước 8/${values.length} dòng.` : `${values.length} dòng có dữ liệu.`;
  xlsxImportCountEl.textContent = values.length;
  xlsxImportBtn.disabled = values.length === 0;
}

function populateColumnSelect() {
  const header = xlsxRows[0] || [];
  const colCount = xlsxRows.reduce((max, row) => Math.max(max, row ? row.length : 0), header.length);
  const bestIdx = guessBestColumn(colCount);

  xlsxColumnSelect.innerHTML = "";
  for (let c = 0; c < colCount; c++) {
    const label = header[c] != null && String(header[c]).trim() !== "" ? String(header[c]).trim() : `Cột ${colLetter(c)}`;
    const opt = document.createElement("option");
    opt.value = String(c);
    opt.textContent = c === bestIdx ? `${label} (gợi ý)` : label;
    xlsxColumnSelect.appendChild(opt);
  }
  xlsxColumnSelect.value = String(bestIdx);
  renderXlsxPreview();
}

function onSheetChange() {
  const sheetName = xlsxSheetSelect.value;
  const sheet = xlsxWorkbook.Sheets[sheetName];
  xlsxRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  populateColumnSelect();
}

function openXlsxModal(file, workbook) {
  xlsxWorkbook = workbook;
  xlsxFileNameEl.textContent = file.name;

  xlsxSheetSelect.innerHTML = "";
  workbook.SheetNames.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    xlsxSheetSelect.appendChild(opt);
  });

  onSheetChange();
  xlsxModalOverlay.classList.remove("hidden");
}

function closeXlsxModal() {
  xlsxModalOverlay.classList.add("hidden");
  xlsxWorkbook = null;
  xlsxRows = [];
  importXlsxFile.value = "";
}

xlsxSheetSelect.addEventListener("change", onSheetChange);
xlsxColumnSelect.addEventListener("change", renderXlsxPreview);
xlsxCancelBtn.addEventListener("click", closeXlsxModal);
xlsxModalClose.addEventListener("click", closeXlsxModal);
xlsxModalOverlay.addEventListener("click", (e) => {
  if (e.target === xlsxModalOverlay) closeXlsxModal();
});

xlsxImportBtn.addEventListener("click", async () => {
  const colIndex = Number(xlsxColumnSelect.value || 0);
  const values = columnValues(colIndex);
  await appendPrompts(values);
  closeXlsxModal();
});

importXlsxFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const workbook = XLSX.read(buf, { type: "array" });
  openXlsxModal(file, workbook);
});

clearQueueBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "CLEAR" }));
});

startBtn.addEventListener("click", async () => {
  if (!lastState || !lastState.tabId) {
    runWarningEl.textContent = "⚠ Chưa gắn tab Midjourney — bấm nút phía trên trước khi chạy.";
    runWarningEl.classList.remove("hidden");
    return;
  }
  if (!lastState.items || lastState.items.length === 0) {
    runWarningEl.textContent = "⚠ Hàng đợi đang trống — thêm ít nhất 1 prompt trước khi chạy.";
    runWarningEl.classList.remove("hidden");
    return;
  }
  if (!lastState.items.some((it) => it.status === "pending")) {
    runWarningEl.textContent = "⚠ Không còn prompt nào ở trạng thái Chờ (tất cả đã Xong/Lỗi) — xoá hết hoặc thêm prompt mới.";
    runWarningEl.classList.remove("hidden");
    return;
  }
  runWarningEl.classList.add("hidden");
  renderState(await sendMsg({ type: "START" }));
});

stopBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "STOP" }));
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE_UPDATE") renderState(msg.state);
});

refresh();
