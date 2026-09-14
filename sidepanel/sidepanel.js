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
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
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
};

let lastState = null;

function renderState(state) {
  if (!state) return;
  lastState = state;

  delayMinEl.value = state.delayMinSeconds;
  delayMaxEl.value = state.delayMaxSeconds;
  autoDownloadEl.checked = !!state.autoDownload;
  downloadSubfolderEl.value = state.downloadSubfolder || "";
  continuousModeEl.checked = !!state.continuousMode;
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
  queueListEl.innerHTML = "";
  for (const item of state.items) {
    const li = document.createElement("li");

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
      const s = await sendMsg({ type: "GET_STATE" });
      const items = s.items.filter((it) => it.id !== item.id);
      renderState(await sendMsg({ type: "SET_ITEMS", items }));
    });

    li.appendChild(badge);
    li.appendChild(text);
    li.appendChild(removeBtn);
    queueListEl.appendChild(li);
  }

  startBtn.disabled = state.running;
  stopBtn.disabled = !state.running;
  startBtn.textContent = state.running ? "⏳ Đang chạy…" : "▶ Chạy";

  const logs = state.logs || [];
  emptyLogHintEl.classList.toggle("hidden", logs.length > 0);
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

attachTabBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "ATTACH_ACTIVE_TAB" }));
});

attachTabQuickBtn.addEventListener("click", async () => {
  renderState(await sendMsg({ type: "ATTACH_ACTIVE_TAB" }));
});

async function appendPrompts(lines) {
  const cleaned = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (cleaned.length === 0) return;
  const state = await sendMsg({ type: "GET_STATE" });
  const newItems = cleaned.map((text) => ({ id: uid(), text, status: "pending", note: "" }));
  renderState(await sendMsg({ type: "SET_ITEMS", items: [...state.items, ...newItems] }));
}

addFromPasteBtn.addEventListener("click", async () => {
  await appendPrompts(pasteArea.value.split("\n"));
  pasteArea.value = "";
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
