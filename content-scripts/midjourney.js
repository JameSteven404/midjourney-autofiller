// Content script cho Midjourney web app (midjourney.com/imagine).
// Ô nhập là <textarea id="desktop_input_bar"> điều khiển bởi React, nên phải
// set value qua native setter rồi dispatch 'input' để React nhận thay đổi.

const SUBMIT_CLEAR_TIMEOUT_MS = 1800;
const SUBMIT_CLEAR_POLL_MS = 120;
const WATCHER_INTERVAL_MS = 4000;
const JOB_TIMEOUT_MS = 3 * 60 * 1000;
const PROMPT_MATCH_PREFIX_LEN = 48;
const MJ_CDN_PREFIX = "https://cdn.midjourney.com/";
const SEND_ICON_PATH_PREFIX = "M3.82715 4.39551";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isElementVisible(el) {
  if (!(el instanceof Element)) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function normalizePromptText(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
    .toLowerCase();
}

function findPromptTextarea() {
  return (
    document.querySelector("#desktop_input_bar") ||
    document.querySelector("textarea[placeholder*='imagine' i]") ||
    document.querySelector("textarea[placeholder*='prompt' i]")
  );
}

function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  const setter = descriptor && descriptor.set;
  if (!setter) {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function findErrorBanner() {
  const candidates = document.querySelectorAll(
    "[role='alert'], .toast, [class*='toast'], [class*='Toast'], [class*='error'], [class*='Error']"
  );
  for (const el of candidates) {
    if (!isElementVisible(el)) continue;
    const text = (el.innerText || "").toLowerCase();
    if (
      text.includes("banned") ||
      text.includes("blocked") ||
      text.includes("rate limit") ||
      text.includes("subscription") ||
      text.includes("upgrade") ||
      text.includes("failed") ||
      text.includes("error") ||
      text.includes("queue is full")
    ) {
      return (el.innerText || "").trim();
    }
  }
  return null;
}

function getAllMediaGrids() {
  return Array.from(
    document.querySelectorAll('[class~="group/mediaGrid"], [class*="mediaGrid"], [class*="media-grid"], [class*="job_grid"]')
  );
}

// Mỗi lưới kết quả nằm cạnh 1 khối hiển thị prompt gốc (cùng hàng cha) — dùng
// để đối chiếu đúng lưới với đúng prompt đã gửi, thay vì giả định "job mới
// luôn ở vị trí đầu danh sách" (sai khi có nhiều job đang chạy cùng lúc).
function getPromptTextForGrid(grid) {
  const row = grid.parentElement;
  if (!row) return "";
  const block =
    row.querySelector('[class~="group/promptText"]') ||
    row.querySelector('[class*="promptText"]') ||
    row.querySelector('[class*="promptTextContainer"]');

  if (!block) return "";
  const span = block.querySelector("span.relative");
  const rawText = span ? span.innerText : block.innerText || "";
  return normalizePromptText(rawText);
}

function scoreMatch(candidateText, targetText) {
  if (!candidateText || !targetText) return 0;
  if (candidateText === targetText) return 1000;
  if (candidateText.startsWith(targetText)) return 500;
  if (targetText.startsWith(candidateText)) return 400;
  if (candidateText.includes(targetText)) return 300;
  if (targetText.includes(candidateText)) return 250;
  const prefix = targetText.slice(0, PROMPT_MATCH_PREFIX_LEN);
  const suffix = targetText.slice(-PROMPT_MATCH_PREFIX_LEN);
  if (candidateText.startsWith(prefix) || candidateText.includes(prefix) || candidateText.includes(suffix)) return 200;
  return 0;
}

function findGridForText(text) {
  const target = normalizePromptText(text);
  if (!target) return null;
  const grids = getAllMediaGrids();
  if (grids.length === 0) return null;

  const ranked = [];
  for (const g of grids) {
    const candidate = getPromptTextForGrid(g);
    const score = scoreMatch(candidate, target);
    if (score > 0) ranked.push({ grid: g, score });
  }

  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].grid;
}

function gridIsFullyLoaded(grid) {
  if (!grid) return false;
  const imgs = grid.querySelectorAll("img");
  if (imgs.length === 0) return false;

  return Array.from(imgs).every((img) => {
    const src = img.src || "";
    return src.startsWith(MJ_CDN_PREFIX) && img.complete && img.naturalWidth > 0;
  });
}

function getGridImageUrls(grid) {
  if (!grid) return [];
  // Lưu ý: đây là URL ảnh xem trước trong lưới kết quả (vd. "..._640_N.webp"),
  // không phải bản gốc full-resolution. Midjourney không lộ link ảnh gốc trực
  // tiếp trong DOM lưới kết quả — muốn tải bản gốc cần vào trang chi tiết
  // (/jobs/<id>) và bấm nút Download thủ công, hoặc mở rộng thêm content script
  // để tự mở từng job page và bấm nút download ở đó.
  const urls = new Set();
  for (const img of Array.from(grid.querySelectorAll("img"))) {
    const src = img.src;
    if (src && src.startsWith(MJ_CDN_PREFIX)) {
      urls.add(src);
    }
  }
  return Array.from(urls);
}

// Chuyển ảnh xem trước .webp sang blob PNG, tạo blob: URL NGAY TRONG TRANG
// (không phải service worker của background.js). Lý do: chrome.downloads.download()
// với URL kiểu "data:" bị Chrome Safe Browsing/download-protection coi là "chưa xác
// minh nguồn gốc" (không có origin trang web thật để đối chiếu) nên tải bị treo vĩnh
// viễn ở dạng file .tmp tên GUID ngẫu nhiên, không bao giờ hoàn tất. blob: URL được
// tạo trong context của trang midjourney.com thật (có origin đáng tin) không gặp vấn
// đề này, và tồn tại được miễn là tab còn mở (đủ thời gian cho download hoàn tất).
async function convertUrlToPngBlobUrl(sourceUrl) {
  const res = await fetch(sourceUrl);
  const srcBlob = await res.blob();
  const bitmap = await createImageBitmap(srcBlob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob trả về null"))), "image/png");
  });
  return URL.createObjectURL(pngBlob);
}

async function convertUrlsToPngBlobUrls(urls) {
  const results = await Promise.all(
    urls.map((u) =>
      convertUrlToPngBlobUrl(u).catch((err) => {
        console.warn("[MJ Auto-Filler] Lỗi chuyển đổi PNG cho", u, err);
        return null;
      })
    )
  );
  return results.filter(Boolean);
}

function hasSendButtonHint(btn) {
  const label = (btn.getAttribute("aria-label") || btn.title || btn.textContent || "").toLowerCase();
  if (label.includes("send") || label.includes("imagine") || label.includes("generate") || label.includes("submit")) {
    return true;
  }
  if ((btn.getAttribute("type") || "").toLowerCase() === "submit") return true;
  const path = btn.querySelector("path");
  if (path && (path.getAttribute("d") || "").startsWith(SEND_ICON_PATH_PREFIX)) return true;
  return false;
}

function findSubmitButton(contextRoot) {
  const scopes = [];
  if (contextRoot instanceof HTMLElement) {
    const form = contextRoot.closest("form");
    if (form) scopes.push(form);
    const parent = contextRoot.closest("div");
    if (parent) scopes.push(parent);
  }
  scopes.push(document);

  for (const scope of scopes) {
    const buttons = Array.from(scope.querySelectorAll("button"));
    for (const btn of buttons) {
      if (btn.disabled || !isElementVisible(btn)) continue;
      if (hasSendButtonHint(btn)) return btn;
    }
  }

  // Fallback cuối theo đúng chữ ký path SVG đã biết.
  const svgs = Array.from(document.querySelectorAll("svg"));
  for (const svg of svgs) {
    const path = svg.querySelector("path");
    if (path && (path.getAttribute("d") || "").startsWith(SEND_ICON_PATH_PREFIX)) {
      const btn = svg.closest("button");
      if (btn && isElementVisible(btn) && !btn.disabled) return btn;
    }
  }
  return null;
}

async function submitViaEnter(textarea) {
  const opts = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    shiftKey: false,
  };
  textarea.dispatchEvent(new KeyboardEvent("keydown", opts));
  textarea.dispatchEvent(new KeyboardEvent("keypress", opts));
  textarea.dispatchEvent(new KeyboardEvent("keyup", opts));
}

async function waitForPromptToClear(textarea) {
  const started = Date.now();
  while (Date.now() - started < SUBMIT_CLEAR_TIMEOUT_MS) {
    if (!((textarea.value || "").trim())) {
      return true;
    }
    await sleep(SUBMIT_CLEAR_POLL_MS);
  }
  return false;
}

// ===== Theo dõi hoàn tất bất đồng bộ =====
// Gửi xong 1 prompt KHÔNG chờ ảnh render xong mới trả kết quả — chỉ xác nhận
// đã gửi thành công rồi trả về ngay, để hàng đợi bên background.js tiếp tục
// gửi prompt kế tiếp theo đúng khoảng chờ ngẫu nhiên đã đặt (giống cách Flow
// xử lý). Việc chờ ảnh xong (để báo trạng thái "Xong" chính xác + tải file)
// chạy song song, độc lập, và báo kết quả về qua 1 message riêng
// (MJ_JOB_RESULT) khớp theo requestId thay vì chặn message ban đầu.
const pendingJobs = new Map(); // requestId -> { text, startedAt }
let watcherTimer = null;

function stopWatcherIfIdle() {
  if (pendingJobs.size === 0 && watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}

// checkPendingJobs() chạy đồng bộ trong setInterval, nhưng việc chuyển ảnh sang
// PNG (fetch + canvas) là bất đồng bộ — nên tách phần báo kết quả "đã xong" ra
// hàm riêng, gọi kiểu fire-and-forget (không await trong tick của interval).
async function reportJobDone(requestId, grid) {
  const rawUrls = getGridImageUrls(grid);
  const mediaUrls = await convertUrlsToPngBlobUrls(rawUrls);
  chrome.runtime.sendMessage({
    type: "MJ_JOB_RESULT",
    requestId,
    ok: true,
    note: mediaUrls.length > 0 ? "Đã tạo xong ảnh." : "Đã tạo xong ảnh nhưng không chuyển được sang PNG để tải.",
    mediaUrls,
  });
}

function checkPendingJobs() {
  const errNow = findErrorBanner();
  const now = Date.now();

  for (const [requestId, job] of Array.from(pendingJobs.entries())) {
    if (errNow) {
      pendingJobs.delete(requestId);
      chrome.runtime.sendMessage({ type: "MJ_JOB_RESULT", requestId, ok: false, rateLimited: true, note: errNow });
      continue;
    }

    const grid = findGridForText(job.text);
    if (grid && gridIsFullyLoaded(grid)) {
      pendingJobs.delete(requestId);
      reportJobDone(requestId, grid);
      continue;
    }

    if (now - job.startedAt > JOB_TIMEOUT_MS) {
      pendingJobs.delete(requestId);
      chrome.runtime.sendMessage({
        type: "MJ_JOB_RESULT",
        requestId,
        ok: true,
        note: "Không xác nhận được thời điểm tạo xong trong 3 phút — kiểm tra thủ công trên Midjourney.",
        mediaUrls: [],
      });
    }
  }

  stopWatcherIfIdle();
}

function ensureWatcher() {
  if (watcherTimer) return;
  watcherTimer = setInterval(checkPendingJobs, WATCHER_INTERVAL_MS);
}

// Nếu extension bị reload (chrome://extensions) trong lúc 1 job đang ở trạng
// thái "generating", content script cũ (đang giữ pendingJobs trong bộ nhớ)
// bị huỷ hoàn toàn — job đó sẽ kẹt mãi ở "Đang tạo" vì không còn ai theo dõi
// và message MJ_JOB_RESULT không bao giờ được gửi. Mỗi khi content script
// này được tiêm (lại), tự hỏi background xem có job nào đang "generating" mà
// chưa được theo dõi trong phiên này, rồi tiếp tục canh từ đầu.
function reconcilePendingJobs() {
  chrome.runtime.sendMessage({ type: "MJ_GET_GENERATING" }, (items) => {
    if (chrome.runtime.lastError || !Array.isArray(items) || items.length === 0) return;
    for (const it of items) {
      if (!pendingJobs.has(it.requestId)) {
        pendingJobs.set(it.requestId, { text: it.text, startedAt: Date.now() });
      }
    }
    if (pendingJobs.size > 0) ensureWatcher();
  });
}
reconcilePendingJobs();

// ===== Cấu hình mặc định (Aspect Ratio, Model, Aesthetics, More Options) =====
// Khám phá trực tiếp qua kiểm tra DOM thật trên midjourney.com (không dùng
// code của bên thứ ba nào). Ghi chú các điểm quan trọng:
// - Các nút chọn (Portrait/Square/Landscape, Standard/HD, Relax/Fast...) không
//   có aria-pressed/aria-checked — nút đang chọn nhận biết qua class chứa
//   "bg-splash/" (màu nhấn theme), KHÔNG dùng chỉ "splash" vì mọi nút đều có
//   sẵn "ring-splash" tĩnh không liên quan tới trạng thái chọn.
// - Stylization/Weirdness/Variety là thanh trượt tự dựng (không phải
//   <input type=range>), track có cursor:pointer — set giá trị bằng cách
//   dispatch pointerdown/mousedown/pointerup/mouseup/click tại toạ độ tương
//   ứng với tỷ lệ % trên track. Thang giá trị: Stylization 0-1000,
//   Weirdness 0-3000, Variety 0-100 (đã kiểm chứng trực tiếp).
// - Nút mở bảng cài đặt (icon sliders cạnh ô nhập) không có id/aria-label ổn
//   định — nhận diện qua chữ ký path SVG bên trong, giống cách làm với nút gửi.
const SETTINGS_ICON_PATH_PREFIX = "M8.6543 15.3408";

function findSettingsTrigger() {
  const svgs = Array.from(document.querySelectorAll("svg"));
  for (const svg of svgs) {
    const path = svg.querySelector("path");
    if (path && (path.getAttribute("d") || "").startsWith(SETTINGS_ICON_PATH_PREFIX)) {
      const btn = svg.closest("button");
      if (btn) return btn;
    }
  }
  return null;
}

function isOptionSelected(btn) {
  return /bg-splash\//.test(btn.className);
}

function hasDirectText(el, text) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === text) return true;
  }
  return false;
}

function findLabelEl(labelText) {
  const all = Array.from(document.querySelectorAll("*"));
  return all.find((el) => el.tagName !== "BUTTON" && hasDirectText(el, labelText));
}

function findRowFor(labelText) {
  const labelEl = findLabelEl(labelText);
  if (!labelEl) return null;
  let row = labelEl.parentElement;
  for (let i = 0; i < 5 && row; i++) {
    if (row.querySelectorAll("button").length > 0) return row;
    row = row.parentElement;
  }
  return null;
}

function clickOptionInGroup(labelText, optionText) {
  const row = findRowFor(labelText);
  if (!row) return { ok: false, note: `Không tìm thấy nhóm "${labelText}".` };
  const btn = Array.from(row.querySelectorAll("button")).find(
    (b) => (b.innerText || "").trim().toLowerCase() === String(optionText).toLowerCase()
  );
  if (!btn) return { ok: false, note: `Không tìm thấy tuỳ chọn "${optionText}" trong "${labelText}".` };
  if (!isOptionSelected(btn)) btn.click();
  return { ok: true };
}

function clickPresetButton(text) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.innerText || "").trim() === text);
  if (!btn) return { ok: false, note: `Không tìm thấy nút "${text}".` };
  if (!isOptionSelected(btn)) btn.click();
  return { ok: true };
}

function findSliderInfo(labelText) {
  const labelEl = findLabelEl(labelText);
  if (!labelEl) return null;
  let gridParent = labelEl;
  for (let i = 0; i < 6 && gridParent; i++) {
    if (gridParent.className && gridParent.className.includes && gridParent.className.includes("grid-cols-[auto_1fr]")) {
      break;
    }
    gridParent = gridParent.parentElement;
  }
  if (!gridParent) return null;
  const children = Array.from(gridParent.children);
  let labelDiv = labelEl;
  while (labelDiv.parentElement !== gridParent) labelDiv = labelDiv.parentElement;
  const li = children.indexOf(labelDiv);
  const valueDiv = children[li + 1];
  if (!valueDiv) return null;
  const track = valueDiv.querySelector(".group\\/bar");
  if (!track) return null;
  return { valueDiv, track };
}

function setSliderValue(labelText, targetValue, maxValue) {
  const info = findSliderInfo(labelText);
  if (!info) return { ok: false, note: `Không tìm thấy thanh trượt "${labelText}".` };

  const current = Number((info.valueDiv.innerText || "0").trim());
  if (current === targetValue) return { ok: true };

  const rect = info.track.getBoundingClientRect();
  const clamped = Math.max(0, Math.min(maxValue, targetValue));
  const ratio = maxValue > 0 ? clamped / maxValue : 0;
  const x = rect.x + Math.max(2, Math.min(rect.width - 2, ratio * rect.width));
  const y = rect.y + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true };
  info.track.dispatchEvent(new PointerEvent("pointerdown", opts));
  info.track.dispatchEvent(new MouseEvent("mousedown", opts));
  info.track.dispatchEvent(new PointerEvent("pointerup", opts));
  info.track.dispatchEvent(new MouseEvent("mouseup", opts));
  info.track.dispatchEvent(new MouseEvent("click", opts));
  return { ok: true };
}

function getSelectedOptionInGroup(labelText) {
  const row = findRowFor(labelText);
  if (!row) return null;
  const btn = Array.from(row.querySelectorAll("button")).find(isOptionSelected);
  return btn ? btn.innerText.trim() : null;
}

function getSelectedPreset(labels) {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => labels.includes((b.innerText || "").trim()) && isOptionSelected(b)
  );
  return btn ? btn.innerText.trim() : null;
}

function getSliderValueNow(labelText) {
  const info = findSliderInfo(labelText);
  if (!info) return null;
  return Number((info.valueDiv.innerText || "0").trim());
}

// Đọc lại toàn bộ giá trị SAU KHI đã set hết — bấm liên tiếp quá nhanh đôi
// khi âm thầm không có tác dụng do layout dịch chuyển đúng lúc dispatch sự
// kiện (đã kiểm chứng thực tế). Thử lại 1 lần cho mục nào chưa đúng, lúc này
// layout đã ổn định nên lần thử lại đáng tin cậy hơn nhiều.
async function verifyAndRetrySettings(config, notes) {
  const ASPECT_LABELS = { portrait: "Portrait", square: "Square", landscape: "Landscape" };
  const checks = [];

  if (config.aspectRatio && ASPECT_LABELS[config.aspectRatio]) {
    const expected = ASPECT_LABELS[config.aspectRatio];
    checks.push({
      name: "Tỷ lệ khung hình",
      expected,
      current: () => getSelectedPreset(Object.values(ASPECT_LABELS)),
      retry: () => clickPresetButton(expected),
    });
  }
  if (config.modelVersion) {
    const expected = config.modelVersion === "hd" ? "HD" : "Standard";
    checks.push({ name: "Model Version", expected, current: () => getSelectedOptionInGroup("Version"), retry: () => clickOptionInGroup("Version", expected) });
  }
  if (config.modelRaw) {
    const expected = config.modelRaw === "raw" ? "Raw" : "Standard";
    checks.push({ name: "Raw Mode", expected, current: () => getSelectedOptionInGroup("Raw"), retry: () => clickOptionInGroup("Raw", expected) });
  }
  if (config.speed) {
    const expected = config.speed === "fast" ? "Fast" : "Relax";
    checks.push({ name: "Speed", expected, current: () => getSelectedOptionInGroup("Speed"), retry: () => clickOptionInGroup("Speed", expected) });
  }
  if (config.stealth) {
    const expected = config.stealth === "on" ? "On" : "Off";
    checks.push({ name: "Stealth", expected, current: () => getSelectedOptionInGroup("Stealth"), retry: () => clickOptionInGroup("Stealth", expected) });
  }
  if (config.videoResolution) {
    const expected = config.videoResolution === "hd" ? "HD" : "SD";
    checks.push({ name: "Video Resolution", expected, current: () => getSelectedOptionInGroup("Video Resolution"), retry: () => clickOptionInGroup("Video Resolution", expected) });
  }
  if (config.videoBatchSize) {
    const expected = String(config.videoBatchSize);
    checks.push({ name: "Video Batch Size", expected, current: () => getSelectedOptionInGroup("Video Batch Size"), retry: () => clickOptionInGroup("Video Batch Size", expected) });
  }
  if (config.stylization != null) {
    checks.push({ name: "Stylization", expected: config.stylization, current: () => getSliderValueNow("Stylization"), retry: () => setSliderValue("Stylization", config.stylization, 1000) });
  }
  if (config.weirdness != null) {
    checks.push({ name: "Weirdness", expected: config.weirdness, current: () => getSliderValueNow("Weirdness"), retry: () => setSliderValue("Weirdness", config.weirdness, 3000) });
  }
  if (config.variety != null) {
    checks.push({ name: "Variety", expected: config.variety, current: () => getSliderValueNow("Variety"), retry: () => setSliderValue("Variety", config.variety, 100) });
  }

  const MAX_RETRIES = 3;
  for (const check of checks) {
    const matches = (val) => (typeof check.expected === "number" ? Number(val) === check.expected : val === check.expected);
    let ok = matches(check.current());
    for (let attempt = 0; !ok && attempt < MAX_RETRIES; attempt++) {
      check.retry();
      await sleep(350);
      ok = matches(check.current());
    }
    if (!ok) {
      notes.push(`"${check.name}" chưa đúng sau ${MAX_RETRIES} lần thử lại (mong muốn ${check.expected}, hiện tại ${check.current()}).`);
    }
  }
}

// Nhớ lại cấu hình đã áp dụng để không phải mở/đóng bảng cài đặt cho mỗi
// prompt — chỉ mở lại khi người dùng đổi cấu hình mặc định.
let lastAppliedSettingsKey = null;

function hasAnyConfiguredSetting(config) {
  if (!config) return false;
  return Object.values(config).some((v) => v != null && v !== "");
}

async function ensureDefaultSettings(config) {
  // Không có mục nào được cấu hình ("Không đổi" hết) — không cần mở bảng cài
  // đặt Midjourney làm gì cả. Trước đây thiếu điều kiện này khiến bảng bị mở
  // ra vô ích ở MỌI lần chạy dù người dùng chưa chỉnh gì, gây khó chịu vì nó
  // không tự đóng lại được (xem ghi chú bên dưới).
  if (!hasAnyConfiguredSetting(config)) return { ok: true };

  const key = JSON.stringify(config);
  if (lastAppliedSettingsKey === key) return { ok: true };

  const trigger = findSettingsTrigger();
  if (!trigger) return { ok: false, note: "Không tìm thấy nút mở bảng cài đặt Midjourney." };
  trigger.click();
  await sleep(400);

  const notes = [];
  const ASPECT_LABELS = { portrait: "Portrait", square: "Square", landscape: "Landscape" };

  // Quan trọng: chờ đủ lâu SAU MỖI thao tác trước khi làm bước kế tiếp. Đã
  // kiểm chứng thực tế: bấm liên tiếp quá nhanh (đặc biệt sau khi đổi Aspect
  // Ratio, làm đổi kích thước khung xem trước phía trên) khiến layout của
  // các control bên dưới (vd. thanh trượt Aesthetics) dịch chuyển NGAY GIỮA
  // lúc lấy toạ độ và lúc dispatch sự kiện, dẫn đến set sai giá trị hoặc set
  // nhầm control khác — không phải lỗi logic mà là race condition với
  // animation/re-render của React.
  const STEP_DELAY_MS = 350;

  if (config.aspectRatio && ASPECT_LABELS[config.aspectRatio]) {
    const r = clickPresetButton(ASPECT_LABELS[config.aspectRatio]);
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.modelVersion) {
    const r = clickOptionInGroup("Version", config.modelVersion === "hd" ? "HD" : "Standard");
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.modelRaw) {
    const r = clickOptionInGroup("Raw", config.modelRaw === "raw" ? "Raw" : "Standard");
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.stylization != null) {
    const r = setSliderValue("Stylization", config.stylization, 1000);
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.weirdness != null) {
    const r = setSliderValue("Weirdness", config.weirdness, 3000);
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.variety != null) {
    const r = setSliderValue("Variety", config.variety, 100);
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.speed) {
    const r = clickOptionInGroup("Speed", config.speed === "fast" ? "Fast" : "Relax");
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.stealth) {
    const r = clickOptionInGroup("Stealth", config.stealth === "on" ? "On" : "Off");
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.videoResolution) {
    const r = clickOptionInGroup("Video Resolution", config.videoResolution === "hd" ? "HD" : "SD");
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }
  if (config.videoBatchSize) {
    const r = clickOptionInGroup("Video Batch Size", String(config.videoBatchSize));
    if (!r.ok) notes.push(r.note);
    await sleep(STEP_DELAY_MS);
  }

  // Xác minh lại toàn bộ giá trị sau khi áp — vì thao tác click nhanh có thể
  // âm thầm không có tác dụng (không báo lỗi) nếu layout dịch chuyển đúng
  // lúc đó; kiểm tra lại 1 lần và thử lại tối đa 1 lần cho các mục sai khác.
  await verifyAndRetrySettings(config, notes);

  // Không tự đóng lại bảng cài đặt bằng JS được: đã kiểm chứng thực tế rằng
  // bấm lại nút trigger, phím Escape, và "click ra ngoài" mô phỏng bằng
  // dispatchEvent đều KHÔNG đóng được — bảng này chỉ phản hồi thao tác chuột/
  // phím thật của người dùng (sự kiện do content script tạo ra luôn có
  // isTrusted=false, bị component lọc bỏ). Đây là giới hạn của trình duyệt,
  // không có cách khắc phục an toàn từ content script thông thường. Bù lại,
  // bảng chỉ mở đúng 1 lần cho cả batch khi có cấu hình mặc định thực sự
  // được set (xem hasAnyConfiguredSetting ở trên và cache lastAppliedSettingsKey
  // bên dưới) — không mở lại cho mỗi prompt, và hoàn toàn không mở nếu không
  // cấu hình gì cả.
  lastAppliedSettingsKey = key;
  return notes.length > 0 ? { ok: false, note: notes.join("; ") } : { ok: true };
}

async function fillAndSubmit(text, requestId, settingsConfig) {
  const textarea = findPromptTextarea();
  if (!textarea) {
    return { ok: false, note: "Không tìm thấy ô nhập prompt (#desktop_input_bar). Giao diện Midjourney có thể đã đổi." };
  }

  // Không chặn việc gửi prompt nếu áp cấu hình mặc định thất bại — vẫn gửi
  // với cấu hình đang có sẵn, chỉ ghi chú lại để người dùng biết.
  const settingsResult = await ensureDefaultSettings(settingsConfig);
  const settingsNote = settingsResult.ok ? "" : ` (Lưu ý cấu hình: ${settingsResult.note})`;

  textarea.focus();
  setNativeValue(textarea, text);
  await sleep(200);

  const submitBtn = findSubmitButton(textarea);
  if (submitBtn) {
    if (submitBtn.disabled) {
      return {
        ok: false,
        note: "Nút gửi đang bị vô hiệu hoá (prompt có thể rỗng hoặc đang chờ job trước).",
      };
    }
    submitBtn.click();
  } else {
    // Dự phòng nếu Midjourney đổi UI và icon gửi không còn khớp — thử Enter,
    // nhưng đã biết cách này không đáng tin cậy bằng click trực tiếp.
    await submitViaEnter(textarea);
  }

  const sent = await waitForPromptToClear(textarea);
  if (!sent) {
    return {
      ok: false,
      note: submitBtn
        ? "Đã điền prompt nhưng giao diện chưa phản hồi xóa ô nhập sau khi nhấn gửi."
        : "Không tìm thấy nút gửi và thử bằng Enter cũng không thành công — giao diện Midjourney có thể đã đổi.",
    };
  }

  const err = findErrorBanner();
  if (err) {
    return { ok: false, rateLimited: true, note: err };
  }

  pendingJobs.set(requestId, { text: normalizePromptText(text), startedAt: Date.now() });
  ensureWatcher();

  return { ok: true, submitted: true, note: "Đã gửi, đang chờ Midjourney tạo ảnh..." + settingsNote };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FILL_AND_SUBMIT_MJ") {
    fillAndSubmit(msg.text, msg.requestId, msg.settingsConfig).then(sendResponse);
    return true;
  }
  return false;
});

