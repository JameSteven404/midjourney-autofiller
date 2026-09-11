// Content script cho Midjourney web app (midjourney.com/imagine).
// Ô nhập là <textarea id="desktop_input_bar"> điều khiển bởi React, nên phải
// set value qua native setter rồi dispatch 'input' để React nhận thay đổi.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findPromptTextarea() {
  return document.querySelector("#desktop_input_bar") || document.querySelector("textarea[placeholder*='imagine']");
}

function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function findErrorBanner() {
  const candidates = document.querySelectorAll(
    "[role='alert'], .toast, [class*='toast'], [class*='Toast'], [class*='error'], [class*='Error']"
  );
  for (const el of candidates) {
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
      return el.innerText.trim();
    }
  }
  return null;
}

function getAllMediaGrids() {
  return Array.from(document.querySelectorAll('[class~="group/mediaGrid"]'));
}

// Mỗi lưới kết quả nằm cạnh 1 khối hiển thị prompt gốc (cùng hàng cha) — dùng
// để đối chiếu đúng lưới với đúng prompt đã gửi, thay vì giả định "job mới
// luôn ở vị trí đầu danh sách" (sai khi có nhiều job đang chạy cùng lúc).
function getPromptTextForGrid(grid) {
  const row = grid.parentElement;
  if (!row) return "";
  const block = row.querySelector('[class~="group/promptText"]');
  if (!block) return "";
  const span = block.querySelector("span.relative");
  return (span ? span.innerText : block.innerText || "").trim();
}

function findGridForText(text) {
  const target = (text || "").trim();
  if (!target) return null;
  const grids = getAllMediaGrids();
  for (const g of grids) {
    if (getPromptTextForGrid(g) === target) return g;
  }
  // Dự phòng nếu Midjourney hiển thị prompt có sai khác nhỏ (vd. rút gọn) —
  // so khớp theo đoạn đầu.
  const prefix = target.slice(0, 50);
  if (prefix) {
    for (const g of grids) {
      const t = getPromptTextForGrid(g);
      if (t && t.startsWith(prefix)) return g;
    }
  }
  return null;
}

function gridIsFullyLoaded(grid) {
  if (!grid) return false;
  const imgs = grid.querySelectorAll("img");
  if (imgs.length === 0) return false;
  return Array.from(imgs).every((img) => (img.src || "").startsWith("https://cdn.midjourney.com/"));
}

function getGridImageUrls(grid) {
  if (!grid) return [];
  // Lưu ý: đây là URL ảnh xem trước trong lưới kết quả (vd. "..._640_N.webp"),
  // không phải bản gốc full-resolution. Midjourney không lộ link ảnh gốc trực
  // tiếp trong DOM lưới kết quả — muốn tải bản gốc cần vào trang chi tiết
  // (/jobs/<id>) và bấm nút Download thủ công, hoặc mở rộng thêm content script
  // để tự mở từng job page và bấm nút download ở đó.
  return Array.from(grid.querySelectorAll("img"))
    .map((img) => img.src)
    .filter((src) => src && src.startsWith("https://cdn.midjourney.com/"));
}

// Đã kiểm chứng trực tiếp trên midjourney.com: giả lập phím Enter KHÔNG kích
// hoạt được submit thật (điền được nhưng không gửi). Nút gửi thật là icon
// mũi tên giấy cạnh ô nhập — không có id/aria-label cố định nên nhận diện
// qua chữ ký "d" của path SVG bên trong nó (ổn định hơn class Tailwind dài
// và có thể đổi liên tục).
const SEND_ICON_PATH_PREFIX = "M3.82715 4.39551";

function findSubmitButton() {
  const svgs = Array.from(document.querySelectorAll("svg"));
  for (const svg of svgs) {
    const path = svg.querySelector("path");
    if (path && (path.getAttribute("d") || "").startsWith(SEND_ICON_PATH_PREFIX)) {
      const btn = svg.closest("button");
      if (btn) return btn;
    }
  }
  return null;
}

async function submitViaEnter(textarea) {
  const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, shiftKey: false };
  textarea.dispatchEvent(new KeyboardEvent("keydown", opts));
  textarea.dispatchEvent(new KeyboardEvent("keypress", opts));
  textarea.dispatchEvent(new KeyboardEvent("keyup", opts));
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
const JOB_TIMEOUT_MS = 3 * 60 * 1000;

function stopWatcherIfIdle() {
  if (pendingJobs.size === 0 && watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
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
      chrome.runtime.sendMessage({
        type: "MJ_JOB_RESULT",
        requestId,
        ok: true,
        note: "Đã tạo xong ảnh.",
        mediaUrls: getGridImageUrls(grid),
      });
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
  watcherTimer = setInterval(checkPendingJobs, 4000);
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

async function fillAndSubmit(text, requestId) {
  const textarea = findPromptTextarea();
  if (!textarea) {
    return { ok: false, note: "Không tìm thấy ô nhập prompt (#desktop_input_bar). Giao diện Midjourney có thể đã đổi." };
  }

  textarea.focus();
  setNativeValue(textarea, text);
  await sleep(200);

  const submitBtn = findSubmitButton();
  if (submitBtn) {
    if (submitBtn.disabled) {
      return { ok: false, note: "Nút gửi đang bị vô hiệu hoá (prompt có thể rỗng hoặc đang chờ job trước)." };
    }
    submitBtn.click();
  } else {
    // Dự phòng nếu Midjourney đổi UI và icon gửi không còn khớp — thử Enter,
    // nhưng đã biết cách này không đáng tin cậy bằng click trực tiếp.
    await submitViaEnter(textarea);
  }
  await sleep(1000);

  // Nếu textarea không tự xoá sau khi gửi, coi như submit chưa thành công.
  if ((textarea.value || "").trim().length > 0) {
    return {
      ok: false,
      note: submitBtn
        ? "Đã điền prompt nhưng có vẻ chưa gửi được sau khi bấm nút gửi — kiểm tra lại giao diện Midjourney (có thể đổi cách submit)."
        : "Không tìm thấy nút gửi và thử bằng Enter cũng không thành công — giao diện Midjourney có thể đã đổi.",
    };
  }

  const err = findErrorBanner();
  if (err) {
    return { ok: false, rateLimited: true, note: err };
  }

  pendingJobs.set(requestId, { text, startedAt: Date.now() });
  ensureWatcher();

  return { ok: true, submitted: true, note: "Đã gửi, đang chờ Midjourney tạo ảnh..." };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FILL_AND_SUBMIT_MJ") {
    fillAndSubmit(msg.text, msg.requestId).then(sendResponse);
    return true;
  }
  return false;
});
