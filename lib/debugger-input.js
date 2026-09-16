// Scoped CDP input transport. No arbitrary protocol commands come from messages.
class MidjourneyDebuggerInput {
  constructor(api, { onStatus = async () => {}, onDetach = () => {} } = {}) {
    this.api = api;
    this.onStatus = onStatus;
    this.onDetach = onDetach;
    this.tabId = null;
    this.pendingTabId = null;
    this.generation = 0;
    api.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== this.tabId && source.tabId !== this.pendingTabId) return;
      this.generation++;
      this.tabId = null;
      this.pendingTabId = null;
      this.onDetach(reason, source.tabId);
    });
  }

  async checkTab(tabId) {
    const tab = await this.api.tabs.get(tabId);
    if (!/^https:\/\/(www\.)?midjourney\.com\//i.test(tab.url || "")) {
      throw new Error("Tab đã rời Midjourney; dừng điều khiển debug.");
    }
  }

  async attach(tabId) {
    await this.checkTab(tabId);
    if (this.tabId === tabId) return;
    const generation = ++this.generation;
    this.pendingTabId = tabId;
    await this.onStatus("connecting", tabId);
    try {
      await this.api.debugger.attach({ tabId }, "1.3");
      if (generation !== this.generation) {
        await this.api.debugger.detach({ tabId }).catch(() => {});
        throw new Error("Phiên debug đã bị dừng trong lúc kết nối.");
      }
      this.tabId = tabId;
      this.pendingTabId = null;
      await this.onStatus("attached", tabId);
    } catch (error) {
      this.pendingTabId = null;
      await this.onStatus("error", null);
      throw error;
    }
  }

  async detach() {
    this.generation++;
    const tabId = this.tabId;
    this.tabId = null;
    this.pendingTabId = null;
    if (tabId != null) await this.api.debugger.detach({ tabId }).catch(() => {});
    await this.onStatus("off", null);
  }

  async command(method, params, guard, generation) {
    const tabId = this.tabId;
    if (tabId == null || generation !== this.generation) throw new Error("Phiên debug không còn hoạt động.");
    await guard();
    await this.checkTab(tabId);
    if (generation !== this.generation || this.tabId !== tabId) throw new Error("Phiên debug đã bị ngắt.");
    return this.api.debugger.sendCommand({ tabId }, method, params);
  }

  async evaluate(expression, guard, generation) {
    const response = await this.command("Runtime.evaluate", { expression, returnByValue: true }, guard, generation);
    if (response?.exceptionDetails) throw new Error("Không xác minh được phần tử trên trang.");
    return response?.result?.value;
  }

  async insertText(marker, text, guard) {
    const generation = this.generation;
    const ready = await this.evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'TEXTAREA' || el.disabled || el.readOnly ||
          el.getAttribute('data-mj-input-target') !== ${JSON.stringify(marker)}) return false;
      el.select();
      return el.selectionStart === 0 && el.selectionEnd === el.value.length;
    })()`, guard, generation);
    if (!ready) throw new Error("Ô prompt không còn được chọn. Tool chưa gửi prompt.");
    await this.command("Input.insertText", { text }, guard, generation);
  }

  async click(marker, ratio, guard) {
    const generation = this.generation;
    const xRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0.5;
    const position = await this.evaluate(`(() => {
      const el = Array.from(document.querySelectorAll('[data-mj-click-target]'))
        .find(node => node.getAttribute('data-mj-click-target') === ${JSON.stringify(marker)});
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      const x = r.left + Math.max(1, Math.min(r.width - 1, r.width * ${xRatio}));
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) return null;
      return { x, y };
    })()`, guard, generation);
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new Error("Nút bị che hoặc đã đổi vị trí. Chưa click.");
    }
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.command("Input.dispatchMouseEvent", {
        type, ...position, button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
      }, guard, generation);
    }
  }

  async escape(guard) {
    const generation = this.generation;
    for (const type of ["keyDown", "keyUp"]) {
      await this.command("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, guard, generation);
    }
  }

  // Midjourney's settings panel does not react to Escape (verified live on
  // the production page — a genuine CDP-trusted Escape leaves it open). It
  // does close on a real click outside its content. The dismiss layer is a
  // separate sibling element (not an ancestor of the panel's own content
  // boxes) — a fixed, near-full-viewport div with no text of its own — so
  // find it by that signature and scan a grid of points (not just the 4
  // corners, which can be covered by loaded image content) for one that
  // actually resolves to it via elementFromPoint.
  async clickOutside(guard) {
    const generation = this.generation;
    const position = await this.evaluate(`(() => {
      function isBackdrop(el) {
        if (!el) return false;
        if (getComputedStyle(el).position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9;
      }
      const w = window.innerWidth, h = window.innerHeight;
      const xs = [4, Math.floor(w * 0.15), Math.floor(w * 0.5), Math.floor(w * 0.85), w - 4];
      const ys = [4, Math.floor(h * 0.3), Math.floor(h * 0.5), Math.floor(h * 0.7), h - 4];
      for (const y of ys) {
        for (const x of xs) {
          if (isBackdrop(document.elementFromPoint(x, y))) return { x, y };
        }
      }
      return null;
    })()`, guard, generation);
    if (!position) throw new Error("Không xác định được điểm bấm ra ngoài bảng cài đặt.");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.command("Input.dispatchMouseEvent", {
        type, ...position, button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
      }, guard, generation);
    }
  }
}

globalThis.MidjourneyDebuggerInput = MidjourneyDebuggerInput;
