// Renders messages from the other platform into the page (native chat list or floating panel).
globalThis.MCM = globalThis.MCM || {};

(() => {
  // Candidate selectors for the native chat message list, per host platform.
  // These depend on Twitch/Kick markup and may need updating when the sites change.
  const CONTAINER_SELECTORS = {
    twitch: [
      '[data-test-selector="chat-scrollable-area__message-container"]',
      '.chat-scrollable-area__message-container'
    ],
    kick: ['#chatroom-messages > div:first-child', '#chatroom-messages']
  };

  const MAX_NODES = 150;
  const MAX_PENDING = 50;
  // Kick (Auto mode): how long to wait for native injection before falling back to the panel.
  const NATIVE_WAIT_MS = 10000;
  const LABELS = { twitch: 'Twitch', kick: 'Kick' };
  const FALLBACK_COLORS = ['#FF4500', '#1E90FF', '#2E8B57', '#DAA520', '#9ACD32', '#FF69B4', '#8A2BE2', '#00CED1', '#D2691E', '#5F9EA0'];

  function colorFor(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }

  function findScrollParent(el) {
    let node = el;
    while (node && node !== document.body) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Virtualized lists with absolutely positioned rows can't take extra children.
  function canInline(container) {
    let child = container.lastElementChild;
    while (child && child.classList.contains('mcm-msg')) child = child.previousElementSibling;
    if (!child) return true;
    return getComputedStyle(child).position !== 'absolute';
  }

  // ---- Floating panel dragging (position is remembered per site) ----
  const PANEL_POS_KEY = 'panelPos:' + location.hostname.replace(/^www\./, '');

  function clampToViewport(root) {
    if (!root.style.left) return; // still at its default bottom-right corner
    const rect = root.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    root.style.left = Math.min(Math.max(0, rect.left), maxLeft) + 'px';
    root.style.top = Math.min(Math.max(0, rect.top), maxTop) + 'px';
  }

  function placeAt(root, left, top) {
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    clampToViewport(root);
  }

  function makeDraggable(root, handle) {
    try {
      chrome.storage.local.get(PANEL_POS_KEY).then((r) => {
        const pos = r[PANEL_POS_KEY];
        if (pos && root.isConnected) placeAt(root, pos.left, pos.top);
      }, () => {});
    } catch {
      // extension context gone; keep the default position
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      root.classList.add('mcm-panel-dragging');

      const onMove = (ev) => placeAt(root, ev.clientX - offsetX, ev.clientY - offsetY);
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        root.classList.remove('mcm-panel-dragging');
        const r = root.getBoundingClientRect();
        try {
          chrome.storage.local.set({ [PANEL_POS_KEY]: { left: Math.round(r.left), top: Math.round(r.top) } });
        } catch {
          // ignore
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    window.addEventListener('resize', () => root.isConnected && clampToViewport(root));
  }

  class ChatDisplay {
    constructor({ hostPlatform, sourcePlatform, sourceChannel, mode }) {
      this.hostPlatform = hostPlatform;
      this.sourcePlatform = sourcePlatform;
      this.sourceChannel = sourceChannel;
      this.mode = mode;
      this.label = LABELS[sourcePlatform];
      this.nodes = [];
      this.pending = [];
      this.container = null;
      this.panel = null;
      this.startedAt = Date.now();
      this.flushTimer = setInterval(() => this.flush(), 1000);
      this.unsubNative =
        this.canUseNative() && MCM.KickNative.onChange((ready) => ready && this.onNativeReady());
      if (mode === 'panel') this.ensurePanel();
    }

    // Kick's chat is virtualized; messages are handed to Kick's own renderer (see kick-page-hook.js).
    canUseNative() {
      return this.hostPlatform === 'kick' && this.mode !== 'panel' && !!MCM.KickNative;
    }

    useNative() {
      return this.canUseNative() && MCM.KickNative.isReady();
    }

    sendNative(item) {
      if (item.msg) MCM.KickNative.injectMessage(item.msg);
      else MCM.KickNative.injectSystem(this.label, item.system);
    }

    onNativeReady() {
      this.flush();
      // Auto mode may have fallen back to the panel while waiting; native chat takes over now.
      if (this.panel) {
        this.panel.root.remove();
        this.panel = null;
      }
    }

    destroy() {
      clearInterval(this.flushTimer);
      if (this.unsubNative) this.unsubNative();
      for (const n of this.nodes) n.remove();
      this.nodes = [];
      this.pending = [];
      if (this.panel) this.panel.root.remove();
      this.panel = null;
    }

    addMessage(msg) {
      this.place({ msg });
    }

    addSystem(text) {
      this.place({ system: text });
    }

    toElement(item) {
      if (item.msg) return this.render(item.msg);
      const el = document.createElement('div');
      el.className = 'mcm-msg mcm-system';
      el.dataset.mcmPlatform = this.sourcePlatform;
      el.textContent = `[${this.label}] ${item.system}`;
      return el;
    }

    render(msg) {
      const el = document.createElement('div');
      el.className = 'mcm-msg';
      el.dataset.mcmPlatform = msg.platform;

      const tag = document.createElement('span');
      tag.className = 'mcm-tag';
      tag.textContent = `[${LABELS[msg.platform]}]`;

      const user = document.createElement('span');
      user.className = 'mcm-user';
      user.textContent = msg.user;
      const color = msg.color || colorFor(msg.user);
      user.style.color = color;

      const body = document.createElement('span');
      body.className = 'mcm-body';
      if (msg.action) {
        body.style.color = color;
        body.style.fontStyle = 'italic';
      }
      for (const f of msg.fragments) {
        if (f.type === 'emote') {
          const img = document.createElement('img');
          img.className = 'mcm-emote';
          img.src = f.url;
          img.alt = f.name;
          img.title = f.name;
          body.append(img);
        } else {
          body.append(document.createTextNode(f.text));
        }
      }

      el.append(tag, ' ', user, msg.action ? ' ' : ': ', body);
      return el;
    }

    place(item) {
      if (this.useNative()) {
        this.sendNative(item);
        return;
      }
      const target = this.getTarget();
      if (!target) {
        this.pending.push(item);
        if (this.pending.length > MAX_PENDING) this.pending.shift();
        return;
      }
      this.insert(target, [this.toElement(item)]);
    }

    flush() {
      if (!this.pending.length) return;
      if (this.useNative()) {
        const batch = this.pending;
        this.pending = [];
        for (const item of batch) this.sendNative(item);
        return;
      }
      const target = this.getTarget();
      if (!target) return;
      const batch = this.pending;
      this.pending = [];
      this.insert(target, batch.map((item) => this.toElement(item)));
    }

    getTarget() {
      if (this.mode === 'panel') return this.ensurePanel().list;
      if (this.canUseNative()) {
        // Native injection not ready yet (needs one real Kick message to learn the format).
        if (this.mode === 'inline' || Date.now() - this.startedAt < NATIVE_WAIT_MS) return null;
        return this.ensurePanel().list;
      }
      const container = this.findContainer();
      if (!container) return null;
      if (this.mode === 'inline' || canInline(container)) return container;
      return this.ensurePanel().list;
    }

    findContainer() {
      if (this.container && this.container.isConnected) return this.container;
      this.container = null;
      for (const sel of CONTAINER_SELECTORS[this.hostPlatform] || []) {
        const el = document.querySelector(sel);
        if (el) {
          this.container = el;
          break;
        }
      }
      return this.container;
    }

    insert(target, elements) {
      const scroller = findScrollParent(target) || target;
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;

      for (const el of elements) {
        target.append(el);
        this.nodes.push(el);
      }
      this.nodes = this.nodes.filter((n) => n.isConnected);
      while (this.nodes.length > MAX_NODES) this.nodes.shift().remove();

      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    }

    ensurePanel() {
      if (this.panel && this.panel.root.isConnected) return this.panel;

      const root = document.createElement('div');
      root.className = 'mcm-panel';

      const header = document.createElement('div');
      header.className = 'mcm-panel-header';
      const title = document.createElement('span');
      title.textContent = `${this.label} chat: ${this.sourceChannel}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = 'Hide';
      title.className = 'mcm-panel-title';
      header.append(title, toggle);

      const list = document.createElement('div');
      list.className = 'mcm-panel-list';

      toggle.addEventListener('click', () => {
        const hidden = list.style.display === 'none';
        list.style.display = hidden ? '' : 'none';
        root.classList.toggle('mcm-panel-collapsed', !hidden);
        toggle.textContent = hidden ? 'Hide' : 'Show';
        clampToViewport(root);
      });

      root.append(header, list);
      document.body.append(root);
      makeDraggable(root, header);
      this.panel = { root, list };
      return this.panel;
    }
  }

  MCM.ChatDisplay = ChatDisplay;
})();
