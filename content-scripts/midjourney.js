// Content script cho Midjourney web app (midjourney.com/imagine).
// Debug/CDP performs trusted input; DOM mode retains the native value setter.

const SUBMIT_CLEAR_TIMEOUT_MS = 5000;
const SUBMIT_CLEAR_POLL_MS = 120;
const WATCHER_INTERVAL_MS = 4000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
// Midjourney không thể tạo xong ảnh trong vài giây — một job "xong" gần như
// ngay sau khi gửi gần chắc chắn là khớp nhầm (vd. lưới cũ, ảnh placeholder
// mờ trước khi ảnh thật load xong). Chặn dưới này để hàng đợi không tưởng
// job đã xong quá sớm rồi gửi dồn dập, vượt hạn mức job đồng thời thật của
// tài khoản dù "Prompt đồng thời" đã đặt thấp.
const MIN_JOB_DURATION_MS = 8000;
// Yêu cầu cùng 1 lưới khớp ổn định qua ít nhất 2 lần kiểm tra cách nhau
// khoảng này, phòng trường hợp DOM đổi ảnh xem trước ngay sau khi khớp lần
// đầu (vd. ảnh mờ tạm thời được thay bằng ảnh thật, đổi luôn key của lưới).
const CONFIRM_STABLE_MS = 1500;
// Nếu sau ngần này vẫn chưa khớp được lưới nào cho job, báo 1 lần lên Nhật ký
// kèm lý do cụ thể — thay vì im lặng tới hết JOB_TIMEOUT_MS (30 phút) mới báo
// "Cần kiểm tra" chung chung. Đủ dài để không báo nhầm lúc Midjourney còn
// đang vẽ ảnh thật (bình thường vẫn lâu hơn 8s của MIN_JOB_DURATION_MS).
const NO_MATCH_WARN_MS = 90 * 1000;
const MJ_CDN_PREFIX = "https://cdn.midjourney.com/";
const SEND_ICON_PATH_PREFIX = "M3.82715 4.39551";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return true;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return false;
}

let submissionContext = null;
let targetSequence = 0;
async function debugAction(action, element, ratio) {
  const request = submissionContext;
  if (!request) throw new Error("Không có prompt đang điều khiển.");
  const marker = request.requestId + ":" + (++targetSequence);
  const attr = action === "insertText" ? "data-mj-input-target" : "data-mj-click-target";
  if (element) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    element.setAttribute(attr, marker);
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "MJ_DEBUG_INPUT", action,
      requestId: request.requestId, marker, ratio });
    if (!response?.ok) throw new Error(response?.error || "Không nhận được xác nhận debug.");
  } finally {
    if (element?.getAttribute(attr) === marker) element.removeAttribute(attr);
  }
}

async function clickElement(element, ratio, action = "click") {
  if (submissionContext?.inputMode === "debugger") await debugAction(action, element, ratio);
  else element.click();
}

async function fillAndSubmit(text, requestId, settingsConfig, inputMode = "dom") {
  if (submissionContext) return { ok: false, notSubmitted: true, note: "Đang xử lý prompt khác." };
  submissionContext = { requestId, inputMode, submitAttempted: false };
  try {
    return await performFillAndSubmit(text, requestId, settingsConfig);
  } catch (error) {
    return { ok: false, notSubmitted: !submissionContext.submitAttempted, note: String(error.message || error) };
  } finally {
    submissionContext = null;
  }
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
      || text.includes("queue full")
      || text.includes("too many")
      || text.includes("maximum number")
      || text.includes("reached your limit")
      || text.includes("try again later")
      || text.includes("job limit")
      || text.includes("prompt limit")
      || text.includes("out of hours")
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

const claimedGridKeys = new Set();
function gridKey(grid) {
  const href = grid.parentElement?.querySelector('a[href*="/jobs/"]')?.getAttribute("href");
  return href || getGridImageUrls(grid).slice().sort().join("|");
}

function findGridForText(text, job = {}, snapshots) {
  const target = normalizePromptText(text);
  if (!target) return null;
  const grids = snapshots || getAllMediaGrids().map(grid => ({ grid, key: gridKey(grid), text: getPromptTextForGrid(grid) }));
  if (grids.length === 0) return null;

  const ranked = [];
  for (const { grid: g, key, text: candidate } of grids) {
    if (!key || claimedGridKeys.has(key) || job.excludedKeys?.includes(key)) continue;
    // Similar prefixes are not enough evidence to download this job's images.
    const score = candidate === target ? 1000 : 0;
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
let watcherObserver = null;
let watcherDebounce = null;

function stopWatcherIfIdle() {
  if (pendingJobs.size === 0 && watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
    watcherObserver?.disconnect();
    watcherObserver = null;
    clearTimeout(watcherDebounce);
    watcherDebounce = null;
  }
}

// Keep tracking until the worker acknowledges the result.
async function reportJobDone(requestId, grid) {
  const rawUrls = getGridImageUrls(grid);
  const mediaUrls = rawUrls;
  const response = await chrome.runtime.sendMessage({
    type: "MJ_JOB_RESULT",
    requestId,
    ok: true,
    note: mediaUrls.length > 0 ? "Đã tạo xong ảnh; có link nguồn để tải." : "Đã tạo xong ảnh nhưng chưa tìm thấy link tải.",
    mediaUrls,
    gridKey: gridKey(grid),
  });
  if (!response?.ok) throw new Error(response?.error || "Worker chưa xác nhận kết quả.");
}

// Phân biệt cụ thể lý do chưa khớp được lưới nào cho job, để log lên side
// panel chỉ đúng điểm nghi vấn thay vì chỉ nói chung chung "chưa xong" — nhất
// là khi Midjourney đổi cấu trúc DOM/class name khiến các hàm getAllMediaGrids/
// getPromptTextForGrid/gridIsFullyLoaded không còn khớp trang thật nữa.
function diagnoseNoMatch(text, snapshots) {
  if (snapshots.length === 0) {
    return "Không tìm thấy lưới ảnh kết quả nào trên trang — selector mediaGrid có thể đã đổi so với giao diện Midjourney hiện tại.";
  }
  const withText = snapshots.filter((s) => s.text).length;
  if (withText === 0) {
    return `Tìm thấy ${snapshots.length} lưới kết quả nhưng không đọc được nội dung prompt của lưới nào — selector promptText có thể đã đổi.`;
  }
  const target = normalizePromptText(text);
  if (!snapshots.some((s) => s.text === target)) {
    return `Tìm thấy ${snapshots.length} lưới kết quả (đọc được prompt ở ${withText}) nhưng không cái nào khớp đúng nội dung prompt đã gửi — trang có thể hiển thị prompt khác với nội dung đã gửi.`;
  }
  return "Đã khớp đúng lưới kết quả nhưng ảnh bên trong chưa được tool coi là tải xong hết (thiếu src CDN Midjourney, hoặc naturalWidth = 0) — có thể do mạng chậm hoặc Midjourney đổi cách hiển thị ảnh trong lưới.";
}

function checkPendingJobs() {
  const errNow = findErrorBanner();
  const now = Date.now();
  const snapshots = getAllMediaGrids().map(grid => ({ grid, key: gridKey(grid), text: getPromptTextForGrid(grid) }));

  if (errNow) chrome.runtime.sendMessage({ type: "MJ_PAGE_BLOCKED", note: errNow }).catch(() => {});

  for (const [requestId, job] of Array.from(pendingJobs.entries())) {
    if (job.reporting) continue;
    // Không chấp nhận "xong" quá sớm — thời gian tạo ảnh thật của Midjourney
    // luôn ít nhất vài giây; xác nhận sớm hơn gần chắc là khớp nhầm.
    if (now - job.startedAt >= MIN_JOB_DURATION_MS) {
      const grid = findGridForText(job.text, job, snapshots);
      if (grid && gridIsFullyLoaded(grid)) {
        const key = gridKey(grid);
        if (job.confirmingKey !== key) {
          // Lưới khớp lần đầu (hoặc đổi so với lần trước) — chỉ bắt đầu đếm
          // thời gian ổn định, chưa claim/báo xong ngay.
          job.confirmingKey = key;
          job.confirmingSince = now;
        } else if (now - job.confirmingSince >= CONFIRM_STABLE_MS) {
          claimedGridKeys.add(key);
          job.reporting = true;
          reportJobDone(requestId, grid).then(() => pendingJobs.delete(requestId)).catch(() => {
            job.reporting = false;
            claimedGridKeys.delete(key);
          });
        }
        continue;
      }
      job.confirmingKey = null;
    }

    if (!job.warnedNoMatch && now - job.startedAt >= NO_MATCH_WARN_MS) {
      job.warnedNoMatch = true;
      chrome.runtime.sendMessage({ type: "MJ_JOB_STALL_WARNING", requestId, note: diagnoseNoMatch(job.text, snapshots) }).catch(() => {});
    }

    if (now - job.startedAt > JOB_TIMEOUT_MS) {
      job.reporting = true;
      chrome.runtime.sendMessage({
        type: "MJ_JOB_RESULT",
        requestId,
        ok: false,
        note: "Chưa xác nhận tạo xong sau 30 phút — kiểm tra job trên Midjourney; không tự gửi lại.",
        mediaUrls: [],
      }).then(response => {
        if (!response?.ok) throw new Error("Worker chưa xác nhận hết thời gian theo dõi.");
        pendingJobs.delete(requestId);
      }).catch(() => { job.reporting = false; });
    }
  }

  stopWatcherIfIdle();
}

function ensureWatcher() {
  if (watcherTimer) return;
  watcherTimer = setInterval(checkPendingJobs, WATCHER_INTERVAL_MS);
  if (typeof MutationObserver !== "undefined" && document.body) {
    watcherObserver = new MutationObserver(() => {
      if (watcherDebounce) return;
      watcherDebounce = setTimeout(() => { watcherDebounce = null; checkPendingJobs(); }, 200);
    });
    watcherObserver.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["src", "srcset", "class", "aria-busy"] });
  }
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
        pendingJobs.set(it.requestId, { text: it.text, startedAt: it.startedAt || Date.now(), excludedKeys: it.excludedKeys || [] });
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

async function clickOptionInGroup(labelText, optionText) {
  const row = findRowFor(labelText);
  if (!row) return { ok: false, note: `Không tìm thấy nhóm "${labelText}".` };
  const btn = Array.from(row.querySelectorAll("button")).find(
    (b) => (b.innerText || "").trim().toLowerCase() === String(optionText).toLowerCase()
  );
  if (!btn) return { ok: false, note: `Không tìm thấy tuỳ chọn "${optionText}" trong "${labelText}".` };
  if (!isOptionSelected(btn)) await clickElement(btn);
  return { ok: true };
}

async function clickPresetButton(text) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.innerText || "").trim() === text);
  if (!btn) return { ok: false, note: `Không tìm thấy nút "${text}".` };
  if (!isOptionSelected(btn)) await clickElement(btn);
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

async function setSliderValue(labelText, targetValue, maxValue) {
  const info = findSliderInfo(labelText);
  if (!info) return { ok: false, note: `Không tìm thấy thanh trượt "${labelText}".` };

  const current = Number((info.valueDiv.innerText || "0").trim());
  if (current === targetValue) return { ok: true };

  const rect = info.track.getBoundingClientRect();
  const clamped = Math.max(0, Math.min(maxValue, targetValue));
  const ratio = maxValue > 0 ? clamped / maxValue : 0;
  if (submissionContext?.inputMode === "debugger") {
    await clickElement(info.track, ratio);
    return { ok: true };
  }
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
  // Nút vẫn còn trong DOM (kèm class đã chọn) ngay cả khi bảng cài đặt đã
  // đóng — Midjourney chỉ ẩn đi (display:none ở tổ tiên) chứ không gỡ khỏi
  // DOM. Phải lọc theo hiển thị thật thì mới biết bảng còn mở hay không.
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => labels.includes((b.innerText || "").trim()) && isOptionSelected(b) && isElementVisible(b)
  );
  return btn ? btn.innerText.trim() : null;
}

function getSliderValueNow(labelText) {
  const info = findSliderInfo(labelText);
  if (!info) return null;
  return Number((info.valueDiv.innerText || "0").trim());
}

// Read each value back; retry only settings that have not reached their target.
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
    const matches = (val) => val != null && (typeof check.expected === "number" ? Number(val) === check.expected : val === check.expected);
    let ok = matches(check.current());
    for (let attempt = 0; !ok && attempt < MAX_RETRIES; attempt++) {
      await check.retry();
      ok = await waitUntil(() => matches(check.current()), 900, 50);
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
  if (!hasAnyConfiguredSetting(config)) return { ok: true };
  const key = JSON.stringify([submissionContext?.inputMode, config]);
  if (lastAppliedSettingsKey === key) return { ok: true };
  const trigger = findSettingsTrigger();
  if (!trigger) return { ok: false, note: "Không tìm thấy nút cài đặt Midjourney." };
  await clickElement(trigger);
  await waitUntil(() => getSelectedPreset(["Portrait", "Square", "Landscape"]) != null, 1200, 50);
  const notes = [];
  await verifyAndRetrySettings(config, notes);
  if (submissionContext?.inputMode === "debugger") {
    // Escape không đóng được bảng cài đặt thật của Midjourney (đã kiểm chứng
    // trực tiếp) — chỉ bấm ra ngoài mới đóng. Thử vài lần vì panel có thể
    // chưa kịp gắn listener ngay sau lần click cuối cùng để chỉnh cài đặt.
    for (let attempt = 0; attempt < 3; attempt++) {
      await debugAction("clickOutside").catch(() => {});
      if (await waitUntil(() => getSelectedPreset(["Portrait", "Square", "Landscape"]) == null, 500, 50)) break;
    }
    if (getSelectedPreset(["Portrait", "Square", "Landscape"]) != null) {
      notes.push("Không đóng được bảng cài đặt sau khi áp dụng.");
    }
  }
  if (notes.length) return { ok: false, note: notes.join("; ") };
  lastAppliedSettingsKey = key;
  return { ok: true };
}

async function performFillAndSubmit(text, requestId, settingsConfig) {
  const beforeError = findErrorBanner();
  if (beforeError) return { ok: false, rateLimited: true, notSubmitted: true, note: beforeError };
  let textarea = findPromptTextarea();
  if (!textarea) {
    return { ok: false, notSubmitted: true, note: "Không tìm thấy ô nhập prompt (#desktop_input_bar). Giao diện Midjourney có thể đã đổi." };
  }

  const settingsResult = await ensureDefaultSettings(settingsConfig);
  if (!settingsResult.ok) return { ok: false, notSubmitted: true, note: settingsResult.note };
  textarea = findPromptTextarea();
  if (!textarea) return { ok: false, notSubmitted: true, note: "Ô nhập đã thay đổi sau khi áp cài đặt. Chưa gửi prompt." };

  textarea.focus();
  if (submissionContext.inputMode === "debugger") {
    await debugAction("insertText", textarea);
    // HTML textareas normalize Windows CRLF to LF; preserve every other character.
    if (!await waitUntil(() => textarea.value === text.replace(/\r\n?/g, "\n"), 1200)) {
      return { ok: false, notSubmitted: true, note: "Nội dung ô nhập chưa khớp prompt. Chưa gửi." };
    }
  } else {
    setNativeValue(textarea, text);
    await sleep(200);
  }

  let submitBtn = findSubmitButton(textarea);
  if (!submitBtn && submissionContext.inputMode === "debugger") {
    await waitUntil(() => { submitBtn = findSubmitButton(textarea); return !!submitBtn; }, 1500);
  }
  const excludedKeys = getAllMediaGrids().map(gridKey).filter(Boolean);
  const startedAt = Date.now();
  if (submitBtn) {
    if (submitBtn.disabled) {
      return {
        ok: false,
        note: "Nút gửi đang bị vô hiệu hoá (prompt có thể rỗng hoặc đang chờ job trước).",
      };
    }
    submissionContext.submitAttempted = true;
    await clickElement(submitBtn, undefined, "submit");
  } else {
    if (submissionContext.inputMode === "debugger") return { ok: false, notSubmitted: true, note: "Chưa tìm thấy nút gửi sẵn sàng; đã giữ prompt trong ô nhập." };
    // Dự phòng nếu Midjourney đổi UI và icon gửi không còn khớp — thử Enter,
    // nhưng đã biết cách này không đáng tin cậy bằng click trực tiếp.
    submissionContext.submitAttempted = true;
    await submitViaEnter(textarea);
  }

  const sent = await waitForPromptToClear(textarea);
  const err = findErrorBanner();
  if (err) return { ok: false, rateLimited: true, note: err };
  if (!sent) {
    return {
      ok: false,
      note: submitBtn
        ? "Đã điền prompt nhưng giao diện chưa phản hồi xóa ô nhập sau khi nhấn gửi."
        : "Không tìm thấy nút gửi và thử bằng Enter cũng không thành công — giao diện Midjourney có thể đã đổi.",
    };
  }

  pendingJobs.set(requestId, { text: normalizePromptText(text), startedAt, excludedKeys });
  ensureWatcher();

  return { ok: true, submitted: true, excludedKeys, startedAt, note: "Đã gửi, đang chờ Midjourney tạo ảnh..." };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FILL_AND_SUBMIT_MJ") {
    fillAndSubmit(msg.text, msg.requestId, msg.settingsConfig, msg.inputMode).then(sendResponse)
      .catch(err => sendResponse({ ok: false, note: String(err.message || err) }));
    return true;
  }
  return false;
});
