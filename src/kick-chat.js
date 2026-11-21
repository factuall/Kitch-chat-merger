// Read-only Kick chat client.
// Kick hands out realtime connection info dynamically (Pusher or Centrifugo);
// both deliver the same { event, data } payloads on channel `chatrooms.<id>.v2`.
globalThis.MCM = globalThis.MCM || {};

(() => {
  const PUSHER_URL = (appKey, cluster) =>
    `wss://ws-${cluster}.pusher.com/app/${appKey}?protocol=7&client=js&version=8.4.0&flash=false`;
  const EMOTE_URL = (id) => `https://files.kick.com/emotes/${id}/fullsize`;
  const EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;
  const CACHE_PREFIX = 'kickChannel:';
  const CHAT_EVENT = 'App\\Events\\ChatMessageEvent';
  const DEBUG = false; // set to true to log every realtime frame to the console

  function buildFragments(content) {
    const fragments = [];
    let last = 0;
    for (const m of content.matchAll(EMOTE_RE)) {
      if (m.index > last) fragments.push({ type: 'text', text: content.slice(last, m.index) });
      fragments.push({ type: 'emote', url: EMOTE_URL(m[1]), name: m[2] });
      last = m.index + m[0].length;
    }
    if (last < content.length) fragments.push({ type: 'text', text: content.slice(last) });
    return fragments;
  }

  function parseMaybeJson(v) {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  function slugCandidates(name) {
    const n = MCM.normalizeName(name);
    return [...new Set([n, n.replace(/_/g, '-')])];
  }

  // info: { channelId, chatroomId }
  MCM.cacheKickChannel = function (slug, info) {
    return chrome.storage.local.set({ [CACHE_PREFIX + MCM.normalizeName(slug)]: info });
  };

  async function resolveChannel(name) {
    const candidates = slugCandidates(name);
    const keys = candidates.map((c) => CACHE_PREFIX + c);
    const cached = await chrome.storage.local.get(keys);
    for (const k of keys) {
      const v = cached[k];
      if (v && v.channelId && v.chatroomId) return v;
    }

    let lastError = 'unknown error';
    for (const slug of candidates) {
      const res = await chrome.runtime.sendMessage({ type: 'mcm:resolveKickChannel', slug });
      if (res && res.channelId && res.chatroomId) {
        const info = { channelId: res.channelId, chatroomId: res.chatroomId };
        await MCM.cacheKickChannel(slug, info);
        return info;
      }
      lastError = (res && res.error) || lastError;
    }
    throw new Error(lastError);
  }

  async function bg(message) {
    try {
      return (await chrome.runtime.sendMessage(message)) || { error: 'no response' };
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  }

  // ---- Transports. Each opens one WebSocket and reports through hooks. ----

  function openPusher(conn, channelName, hooks) {
    const ws = new WebSocket(PUSHER_URL(conn.appKey, conn.cluster));
    const send = (event, data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ event, data }));
    const pingTimer = setInterval(() => send('pusher:ping', {}), 60000);

    ws.onmessage = (e) => {
      if (DEBUG) console.debug('[MCM] pusher <', e.data);
      const frame = parseMaybeJson(e.data);
      if (!frame || typeof frame !== 'object') return;
      switch (frame.event) {
        case 'pusher:connection_established':
          send('pusher:subscribe', { auth: '', channel: channelName });
          break;
        case 'pusher_internal:subscription_succeeded':
          hooks.onSubscribed();
          break;
        case 'pusher:ping':
          send('pusher:pong', {});
          break;
        case 'pusher:error':
          ws.close();
          break;
        default:
          if (frame.channel === channelName) hooks.onEvent(frame.event, parseMaybeJson(frame.data));
      }
    };
    ws.onclose = (e) => {
      clearInterval(pingTimer);
      hooks.onClose(e.reason ? `${e.code} ${e.reason}` : String(e.code));
    };
    ws.onerror = () => {};
    return () => {
      clearInterval(pingTimer);
      ws.onclose = null;
      ws.close();
    };
  }

  // Minimal Centrifugo client (JSON protocol).
  function openCentrifugo(conn, channelName, token, hooks) {
    const ws = new WebSocket(conn.url.replace(/^http/i, 'ws'));
    let nextId = 1;
    let connectId = 0;
    let subscribeId = 0;
    const send = (cmd) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(cmd));

    ws.onopen = () => {
      connectId = nextId++;
      const connect = { name: 'js' };
      if (token) connect.token = token;
      send({ id: connectId, connect });
    };
    ws.onmessage = (e) => {
      if (DEBUG) console.debug('[MCM] centrifugo <', e.data);
      // A frame may contain several newline-separated JSON replies.
      for (const line of String(e.data).split('\n')) {
        if (!line.trim()) continue;
        const reply = parseMaybeJson(line);
        if (!reply || typeof reply !== 'object') continue;

        if (Object.keys(reply).length === 0) {
          send({}); // server ping -> pong
          continue;
        }
        if (reply.error) {
          hooks.onError(`Kick (centrifugo) error ${reply.error.code}: ${reply.error.message}`);
          ws.close();
          continue;
        }
        if (reply.id === connectId && reply.connect) {
          subscribeId = nextId++;
          send({ id: subscribeId, subscribe: { channel: channelName } });
          continue;
        }
        if (reply.id === subscribeId && reply.subscribe) {
          hooks.onSubscribed();
          continue;
        }
        const push = reply.push;
        if (push && push.channel === channelName && push.pub) {
          const envelope = parseMaybeJson(push.pub.data);
          if (envelope && envelope.event) hooks.onEvent(envelope.event, parseMaybeJson(envelope.data));
        }
      }
    };
    ws.onclose = (e) => hooks.onClose(e.reason ? `${e.code} ${e.reason}` : String(e.code));
    ws.onerror = () => {};
    return () => {
      ws.onclose = null;
      ws.close();
    };
  }

  class KickChat {
    constructor(channel, { onMessage, onStatus }) {
      this.channel = MCM.normalizeName(channel);
      this.onMessage = onMessage;
      this.onStatus = onStatus;
      this.stopped = true;
      this.attempts = 0;
      this.clientId = crypto.randomUUID();
      this.channelInfo = null;
      this.connections = null; // realtime options from Kick, in server preference order
      this.connIndex = 0;
      this.closeSocket = null;
      this.subscribed = false;
      this.reconnectTimer = null;
    }

    async start() {
      this.stopped = false;
      try {
        this.channelInfo = await resolveChannel(this.channel);
      } catch (e) {
        if (!this.stopped) {
          this.onStatus(
            `Could not find Kick channel "${this.channel}" (${e.message}). ` +
              'Try opening the channel on kick.com once so its IDs can be cached.'
          );
        }
        return;
      }
      this.connect();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.reconnectTimer);
      if (this.closeSocket) this.closeSocket();
      this.closeSocket = null;
    }

    async connect() {
      if (this.stopped) return;
      this.subscribed = false;

      if (!this.connections) {
        const res = await bg({
          type: 'mcm:getKickRealtime',
          channelId: this.channelInfo.channelId,
          clientId: this.clientId
        });
        if (this.stopped) return;
        if (!res.connections) {
          this.onStatus(`Could not get Kick chat connection info (${res.error}).`);
          this.scheduleReconnect();
          return;
        }
        this.connections = res.connections;
        this.connIndex = 0;
        this.onStatus(
          'Kick offered: ' +
            res.connections
              .map((c) => (c.provider === 'pusher' ? `pusher(${c.appKey}, ${c.cluster})` : `centrifugo(${c.url})`))
              .join(', ')
        );
      }

      const conn = this.connections[this.connIndex];
      const channelName = `chatrooms.${this.channelInfo.chatroomId}.v2`;
      const hooks = {
        onSubscribed: () => {
          this.subscribed = true;
          this.attempts = 0;
          this.onStatus(`Connected to Kick chat: ${this.channel} (${conn.provider})`);
        },
        onEvent: (event, data) => {
          if (event === CHAT_EVENT) this.handleChatMessage(data);
        },
        onError: (text) => this.onStatus(text),
        onClose: (reason) => {
          this.closeSocket = null;
          if (!this.subscribed) {
            // This option didn't work: try the next one; refetch the list after the last.
            this.connIndex++;
            if (this.connIndex >= this.connections.length) this.connections = null;
          }
          this.scheduleReconnect(`${conn.provider}, ${reason}`);
        }
      };

      if (conn.provider === 'pusher') {
        this.closeSocket = openPusher(conn, channelName, hooks);
      } else {
        const tokenRes = await bg({ type: 'mcm:getKickCentrifugoToken', clientId: this.clientId });
        if (tokenRes.error) this.onStatus(`Kick (centrifugo) token request failed: ${tokenRes.error}`);
        const prep = await bg({ type: 'mcm:prepareKickSocket', url: conn.url });
        if (prep.error) this.onStatus(`Kick (centrifugo) origin rewrite failed: ${prep.error}`);
        if (this.stopped) return;
        // Try without a token if the auth endpoint fails; the server will reject if it's required.
        this.closeSocket = openCentrifugo(conn, channelName, tokenRes.token || '', hooks);
      }
    }

    scheduleReconnect(reason) {
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * 2 ** this.attempts++);
      const why = reason ? ` (${reason})` : '';
      this.onStatus(`Disconnected from Kick chat${why}, reconnecting in ${Math.round(delay / 1000)}s...`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    handleChatMessage(data) {
      if (!data || typeof data.content !== 'string') return;
      const sender = data.sender || {};
      this.onMessage({
        platform: 'kick',
        user: sender.username || 'unknown',
        color: (sender.identity && sender.identity.color) || null,
        action: false,
        fragments: buildFragments(data.content)
      });
    }
  }

  MCM.KickChat = KickChat;
})();
