// Isolated-world bridge to src/kick-page-hook.js (kick.com only).
// Lets the display hand messages to Kick's own chat renderer.
globalThis.MCM = globalThis.MCM || {};

(() => {
  if (!/(^|\.)kick\.com$/.test(location.hostname)) return;

  let ready = false;
  const listeners = new Set();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__mcm !== 'to-ext') return;
    if (e.data.type === 'status' && e.data.ready !== ready) {
      ready = e.data.ready;
      for (const fn of listeners) fn(ready);
    }
  });
  window.postMessage({ __mcm: 'to-page', type: 'status?' }, location.origin);

  function toText(fragments) {
    return fragments.map((f) => (f.type === 'emote' ? f.name : f.text)).join('');
  }

  MCM.KickNative = {
    isReady: () => ready,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // msg: normalized message from a chat client
    injectMessage(msg) {
      const label = msg.platform === 'twitch' ? 'Twitch' : 'Kick';
      let content = toText(msg.fragments);
      if (msg.action) content = `* ${content}`;
      window.postMessage(
        {
          __mcm: 'to-page',
          type: 'inject',
          payload: { user: `[${label}] ${msg.user}`, slug: msg.user, color: msg.color, content }
        },
        location.origin
      );
    },
    injectSystem(label, text) {
      window.postMessage(
        { __mcm: 'to-page', type: 'inject', payload: { user: `[${label}]`, color: null, content: text } },
        location.origin
      );
    }
  };
})();
