// Entry point: detects the current channel, finds its pair and connects to the other platform's chat.
(() => {
  const PLATFORM = /(^|\.)twitch\.tv$/.test(location.hostname) ? 'twitch' : 'kick';
  const OTHER = PLATFORM === 'twitch' ? 'kick' : 'twitch';

  const RESERVED = {
    twitch: new Set([
      'directory', 'settings', 'videos', 'p', 'downloads', 'jobs', 'turbo', 'subscriptions',
      'inventory', 'wallet', 'drops', 'friends', 'messages', 'search', 'prime', 'store',
      'login', 'signup', 'following', 'u', 'team', 'collections', 'payments', 'broadcast'
    ]),
    kick: new Set([
      'categories', 'category', 'browse', 'following', 'search', 'dashboard', 'settings',
      'subscriptions', 'video', 'videos', 'clips', 'auth', 'messages', 'notifications',
      'wallet', 'terms-of-service', 'privacy-policy', 'community-guidelines', 'dmca-policy'
    ])
  };
  // Paths like /popout/<channel>/chat where the channel is the second segment.
  const PREFIXED = {
    twitch: new Set(['popout', 'embed', 'moderator']),
    kick: new Set(['popout'])
  };

  let settings = null;
  let sessionKey = null;
  let session = null;
  let intervalId = null;
  const cachedKickSlugs = new Set();
  const autoPairRequested = new Set();

  function getCurrentChannel() {
    const seg = location.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
    if (!seg.length) return null;
    if (PREFIXED[PLATFORM].has(seg[0])) return seg[1] || null;
    if (RESERVED[PLATFORM].has(seg[0])) return null;
    return seg[0];
  }

  function findPair(channel) {
    const same = PLATFORM === 'twitch' ? MCM.sameTwitchName : MCM.sameKickName;
    return (settings.pairs || []).find((p) => p && p[PLATFORM] && p[OTHER] && same(p[PLATFORM], channel)) || null;
  }

  function stopSession() {
    if (!session) return;
    session.connector.stop();
    session.display.destroy();
    session = null;
  }

  function startSession(target) {
    const display = new MCM.ChatDisplay({
      hostPlatform: PLATFORM,
      sourcePlatform: OTHER,
      sourceChannel: target,
      mode: settings.displayMode
    });
    const Connector = OTHER === 'twitch' ? MCM.TwitchChat : MCM.KickChat;
    const connector = new Connector(target, {
      onMessage: (m) => display.addMessage(m),
      onStatus: (t) => display.addSystem(t)
    });
    session = { display, connector };
    connector.start();
  }

  // When on a Kick channel that is part of a pair, cache its channel/chatroom IDs (same-origin request)
  // so the Twitch side doesn't depend on the background fetch getting through Cloudflare.
  async function cacheKickChatroom(slug) {
    if (cachedKickSlugs.has(slug)) return;
    cachedKickSlugs.add(slug);
    try {
      const res = await fetch(`/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.id && data.chatroom && data.chatroom.id) {
        await MCM.cacheKickChannel(slug, { channelId: data.id, chatroomId: data.chatroom.id });
      }
    } catch {
      // ignore, the background lookup is the fallback
    }
  }

  function evaluate() {
    if (!chrome.runtime || !chrome.runtime.id) {
      // Extension was reloaded/removed; this content script is orphaned.
      clearInterval(intervalId);
      stopSession();
      return;
    }
    if (!settings) return;

    const channel = settings.enabled ? getCurrentChannel() : null;
    const pair = channel ? findPair(channel) : null;
    const target = pair ? MCM.normalizeName(pair[OTHER]) : null;

    if (PLATFORM === 'kick' && pair) cacheKickChatroom(channel);

    // No pair yet: ask the background to look for a verified same-name account on the other
    // platform. If it adds one, storage.onChanged re-runs evaluate() and the session starts.
    if (channel && !pair && settings.autoPair && !autoPairRequested.has(channel)) {
      autoPairRequested.add(channel);
      chrome.runtime.sendMessage({ type: 'mcm:autoPair', platform: PLATFORM, channel }).catch(() => {});
    }

    const key = target ? `${OTHER}:${target}:${settings.displayMode}` : null;
    if (key === sessionKey) return;
    stopSession();
    sessionKey = key;
    if (target) startSession(target);
  }

  async function refreshSettings() {
    settings = await MCM.getSettings();
  }

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') refreshSettings().then(evaluate);
  });

  refreshSettings().then(() => {
    evaluate();
    // Both sites are SPAs; poll for URL changes.
    intervalId = setInterval(evaluate, 1000);
  });
})();
