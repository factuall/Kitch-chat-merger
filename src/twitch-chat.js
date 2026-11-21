// Read-only anonymous Twitch chat client (IRC over WebSocket).
globalThis.MCM = globalThis.MCM || {};

(() => {
  const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
  const EMOTE_URL = (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`;

  function unescapeTag(v) {
    return v.replace(/\\(.)/g, (_, c) =>
      ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' }[c] ?? c)
    );
  }

  function parseIrc(line) {
    const msg = { tags: {}, prefix: null, command: null, params: [] };
    let rest = line;
    if (rest[0] === '@') {
      const sp = rest.indexOf(' ');
      for (const kv of rest.slice(1, sp).split(';')) {
        const eq = kv.indexOf('=');
        if (eq < 0) msg.tags[kv] = '';
        else msg.tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
      }
      rest = rest.slice(sp + 1);
    }
    if (rest[0] === ':') {
      const sp = rest.indexOf(' ');
      msg.prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }
    let trailing = null;
    const ti = rest.indexOf(' :');
    if (ti >= 0) {
      trailing = rest.slice(ti + 2);
      rest = rest.slice(0, ti);
    }
    const parts = rest.split(' ').filter(Boolean);
    msg.command = parts.shift() || null;
    msg.params = parts;
    if (trailing !== null) msg.params.push(trailing);
    return msg;
  }

  // Twitch emote ranges are in Unicode code points.
  function buildFragments(text, emotesTag) {
    const chars = Array.from(text);
    const ranges = [];
    if (emotesTag) {
      for (const group of emotesTag.split('/')) {
        const [id, positions] = group.split(':');
        if (!id || !positions) continue;
        for (const pos of positions.split(',')) {
          const [start, end] = pos.split('-').map(Number);
          if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ id, start, end });
        }
      }
    }
    ranges.sort((a, b) => a.start - b.start);

    const fragments = [];
    let cursor = 0;
    for (const r of ranges) {
      if (r.start < cursor) continue;
      if (r.start > cursor) fragments.push({ type: 'text', text: chars.slice(cursor, r.start).join('') });
      fragments.push({ type: 'emote', url: EMOTE_URL(r.id), name: chars.slice(r.start, r.end + 1).join('') });
      cursor = r.end + 1;
    }
    if (cursor < chars.length) fragments.push({ type: 'text', text: chars.slice(cursor).join('') });
    return fragments;
  }

  class TwitchChat {
    constructor(channel, { onMessage, onStatus }) {
      this.channel = MCM.normalizeName(channel);
      this.onMessage = onMessage;
      this.onStatus = onStatus;
      this.ws = null;
      this.stopped = true;
      this.attempts = 0;
      this.joined = false;
      this.reconnectTimer = null;
    }

    start() {
      this.stopped = false;
      this.connect();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.reconnectTimer);
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
    }

    connect() {
      if (this.stopped) return;
      const ws = new WebSocket(IRC_URL);
      this.ws = ws;
      const nick = 'justinfan' + Math.floor(10000 + Math.random() * 80000);

      ws.onopen = () => {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('PASS SCHMOOPIIE');
        ws.send('NICK ' + nick);
        ws.send('JOIN #' + this.channel);
      };
      ws.onmessage = (e) => {
        for (const line of String(e.data).split('\r\n')) {
          if (line) this.handleLine(line);
        }
      };
      ws.onclose = () => this.scheduleReconnect();
      ws.onerror = () => {}; // onclose follows
    }

    scheduleReconnect() {
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * 2 ** this.attempts++);
      this.onStatus(`Disconnected from Twitch chat, reconnecting in ${Math.round(delay / 1000)}s...`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    handleLine(line) {
      if (line.startsWith('PING')) {
        this.ws.send('PONG' + line.slice(4));
        return;
      }
      const msg = parseIrc(line);
      switch (msg.command) {
        case 'ROOMSTATE':
          if (this.attempts !== 0 || !this.joined) {
            this.onStatus(`Connected to Twitch chat: ${this.channel}`);
          }
          this.joined = true;
          this.attempts = 0;
          break;
        case 'PRIVMSG':
          this.handlePrivmsg(msg);
          break;
        case 'RECONNECT':
          this.ws.close();
          break;
        case 'NOTICE':
          if (msg.params[1]) this.onStatus(msg.params[1]);
          break;
      }
    }

    handlePrivmsg(msg) {
      let text = msg.params[1] || '';
      let action = false;
      const m = /^\u0001ACTION (.*)\u0001$/.exec(text);
      if (m) {
        text = m[1];
        action = true;
      }
      const login = msg.prefix ? msg.prefix.split('!')[0] : 'unknown';
      this.onMessage({
        platform: 'twitch',
        user: msg.tags['display-name'] || login,
        color: msg.tags.color || null,
        action,
        fragments: buildFragments(text, msg.tags.emotes)
      });
    }
  }

  MCM.TwitchChat = TwitchChat;
})();
