// Runs in the kick.com page's MAIN world (not the isolated extension world).
//
// Kick's chat is a virtualized list, so we can't insert DOM rows into it. Instead we watch
// Kick's own realtime WebSocket, remember the shape of a real incoming chat message frame,
// and dispatch synthetic frames of the same shape on that socket. Kick then renders our
// messages natively (same styling, ordering and auto-scroll as real ones).
//
// Talks to the isolated content script via window.postMessage ({ __mcm: 'to-page' | 'to-ext' }).
// Diagnostics: set DEBUG = true, then run __mcmDebug() in the kick.com tab console.
(() => {
  if (window.__mcmKickHook) return;
  window.__mcmKickHook = true;

  const DEBUG = false;
  const debugLog = (...args) => DEBUG && console.log('[MCM hook]', ...args);

  const CHAT_EVENT = 'App\\Events\\ChatMessageEvent';
  const TEMPLATE_TYPES = new Set(['message', 'reply']);
  const NativeWebSocket = window.WebSocket;
  const sockets = new Set();

  let template = null; // { ws, kind, frame, pubDataIsString, dataIsString, msg }
  let injecting = false;

  const stats = {
    sockets: [],
    textFrames: 0,
    binaryFrames: 0,
    chatFrames: 0,
    rejected: [],
    injected: 0,
    injectFailed: 0,
    recentFrames: [] // last frames per socket, truncated
  };

  function reject(reason, sample) {
    if (DEBUG && stats.rejected.length < 10) stats.rejected.push({ reason, sample: String(sample).slice(0, 400) });
  }

  if (DEBUG) window.__mcmDebug = () => {
    const info = {
      ...stats,
      sockets: stats.sockets.map((s) => ({ url: s.url, state: s.ws.readyState })),
      ready: isReady(),
      template: template && { kind: template.kind, frame: template.frame }
    };
    debugLog(info);
    return info;
  };

  function parseMaybe(v) {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  function post(payload) {
    window.postMessage({ __mcm: 'to-ext', ...payload }, location.origin);
  }

  function openSocketFor(t) {
    if (t.ws.readyState === NativeWebSocket.OPEN) return t.ws;
    // Kick reconnected: use the newest open socket instead.
    let latest = null;
    for (const ws of sockets) if (ws.readyState === NativeWebSocket.OPEN) latest = ws;
    return latest;
  }

  function isReady() {
    return !!template && !!openSocketFor(template);
  }

  function setTemplate(t) {
    const wasReady = isReady();
    template = t;
    if (!wasReady && isReady()) {
      debugLog('ready, learned message format from', t.kind);
      post({ type: 'status', ready: true });
    }
  }

  function capture(ws, data) {
    if (injecting) return;
    if (typeof data !== 'string') {
      stats.binaryFrames++;
      return;
    }
    stats.textFrames++;
    if (DEBUG) {
      stats.recentFrames.push({ socket: String(ws.url).split('?')[0], frame: data.slice(0, 500) });
      if (stats.recentFrames.length > 30) stats.recentFrames.shift();
    }
    for (const line of data.split('\n')) {
      if (!line.includes('ChatMessageEvent')) continue;
      stats.chatFrames++;
      const frame = parseMaybe(line);
      if (!frame || typeof frame !== 'object') {
        reject('not json', line);
        continue;
      }

      // Centrifugo: { push: { channel, pub: { data: { event, data } } } }
      const push = frame.push;
      if (push && push.pub) {
        const env = parseMaybe(push.pub.data);
        if (!env || env.event !== CHAT_EVENT) {
          reject('centrifugo: unexpected envelope', line);
          continue;
        }
        const msg = parseMaybe(env.data);
        if (!msg || !TEMPLATE_TYPES.has(msg.type) || !msg.sender) {
          reject('centrifugo: unexpected message', line);
          continue;
        }
        setTemplate({
          ws,
          kind: 'centrifugo',
          frame,
          pubDataIsString: typeof push.pub.data === 'string',
          dataIsString: typeof env.data === 'string',
          msg
        });
        continue;
      }

      // Pusher: { event, channel, data }
      if (frame.event === CHAT_EVENT) {
        const msg = parseMaybe(frame.data);
        if (!msg || !TEMPLATE_TYPES.has(msg.type) || !msg.sender) {
          reject('pusher: unexpected message', line);
          continue;
        }
        setTemplate({ ws, kind: 'pusher', frame, dataIsString: typeof frame.data === 'string', msg });
        continue;
      }

      reject('unknown frame shape', line);
    }
  }

  function buildMessage(base, { user, slug, color, content }) {
    const msg = JSON.parse(JSON.stringify(base));
    msg.id = crypto.randomUUID();
    msg.content = content;
    msg.type = 'message';
    msg.created_at = new Date().toISOString();
    if (msg.metadata && typeof msg.metadata === 'object') {
      delete msg.metadata.original_sender;
      delete msg.metadata.original_message;
    }
    const identity = { ...((base.sender && base.sender.identity) || {}), badges: [] };
    if (color) identity.color = color;
    msg.sender = {
      ...base.sender,
      id: 0,
      username: user,
      slug: String(slug || user).toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      identity
    };
    return msg;
  }

  function inject(payload) {
    if (!template) return false;
    const ws = openSocketFor(template);
    if (!ws) {
      stats.injectFailed++;
      return false;
    }

    const msg = buildMessage(template.msg, payload);
    const frame = JSON.parse(JSON.stringify(template.frame));

    if (template.kind === 'centrifugo') {
      const env = parseMaybe(frame.push.pub.data);
      env.data = template.dataIsString ? JSON.stringify(msg) : msg;
      frame.push.pub.data = template.pubDataIsString ? JSON.stringify(env) : env;
      delete frame.push.pub.offset;
    } else {
      frame.data = template.dataIsString ? JSON.stringify(msg) : msg;
    }

    injecting = true;
    try {
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
      stats.injected++;
    } finally {
      injecting = false;
    }
    return true;
  }

  class MCMWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      sockets.add(this);
      if (DEBUG) stats.sockets.push({ url: String(args[0]), ws: this });
      debugLog('WebSocket opened:', String(args[0]));
      this.addEventListener('message', (e) => capture(this, e.data));
      this.addEventListener('close', () => sockets.delete(this));
    }
  }
  window.WebSocket = MCMWebSocket;
  debugLog('installed');

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__mcm !== 'to-page') return;
    if (e.data.type === 'status?') {
      post({ type: 'status', ready: isReady() });
    } else if (e.data.type === 'inject') {
      const ok = inject(e.data.payload);
      if (!ok) post({ type: 'status', ready: false });
    }
  });
})();
