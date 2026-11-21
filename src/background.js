// Service worker. Talks to Kick/Twitch HTTP APIs on behalf of content scripts
// (host permissions let us bypass CORS when the request originates from the other site).
importScripts('shared.js');

const DEBUG = false; // set to true to log API responses and auto-pair results
const debugLog = (...args) => DEBUG && console.log('[MCM]', ...args);

const KICK_WEB_API = 'https://web.kick.com/api';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    'mcm:resolveKickChannel': () => resolveKickChannel(msg.slug),
    'mcm:getKickRealtime': () => getKickRealtime(msg.channelId, msg.clientId),
    'mcm:getKickCentrifugoToken': () => getKickCentrifugoToken(msg.clientId),
    'mcm:prepareKickSocket': () => prepareKickSocket(msg.url),
    'mcm:autoPair': () => autoPair(msg.platform, msg.channel)
  };
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler().then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
  return true; // async response
});

// Fetches Kick channel JSON. Returns { data } or { notFound: true } or { error }.
async function fetchKickChannel(slug) {
  const s = encodeURIComponent(slug);
  const urls = [`https://kick.com/api/v2/channels/${s}`, `https://kick.com/api/v1/channels/${s}`];
  let lastError = 'unknown error';
  let notFound = false;
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (res.status === 404) {
        notFound = true;
        continue;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      if (data && data.id) return { data };
      lastError = 'no channel in response';
    } catch (e) {
      lastError = (e && e.message) || String(e);
    }
  }
  return notFound ? { notFound: true } : { error: lastError };
}

// slug -> { channelId, chatroomId }
async function resolveKickChannel(slug) {
  const res = await fetchKickChannel(slug);
  if (!res.data) return { error: res.notFound ? 'channel not found' : res.error };
  const channelId = res.data.id;
  const chatroomId = res.data.chatroom && res.data.chatroom.id;
  if (!chatroomId) return { error: 'no chatroom id in response' };
  return { channelId, chatroomId };
}

async function postKickWeb(path, body) {
  const res = await fetch(KICK_WEB_API + path, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-app-platform': 'web'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    if (DEBUG) debugLog(path, 'HTTP', res.status, await res.text().catch(() => ''));
    throw new Error(`${path} HTTP ${res.status}`);
  }
  return res.json();
}

// Asks Kick which realtime providers to use for a channel's chat (same request the
// kick.com frontend makes). Returns { connections: [...] } in the server's preference order:
//   { provider: 'pusher', appKey, cluster } | { provider: 'centrifugo', url }
async function getKickRealtime(channelId, clientId) {
  const json = await postKickWeb(`/v1/realtime/channels/${encodeURIComponent(channelId)}/chat/connection`, {
    client: { id: clientId, type: 'web' },
    capabilities: { accepted_providers: [{ provider: 'pusher' }, { provider: 'centrifugo' }] }
  });
  const config = json && (json.data || json);
  debugLog('Kick realtime config', config);

  const connections = [];
  for (const c of (config && config.connections) || []) {
    const cred = (c && c.credentials) || {};
    if (c.provider === 'pusher' && cred.app_key && cred.cluster) {
      connections.push({ provider: 'pusher', appKey: cred.app_key, cluster: cred.cluster });
    } else if (c.provider === 'centrifugo' && cred.url) {
      connections.push({ provider: 'centrifugo', url: cred.url });
    }
  }
  if (!connections.length) {
    return { error: 'no supported connection offered: ' + JSON.stringify(config).slice(0, 300) };
  }
  return { connections };
}

async function getKickCentrifugoToken(clientId) {
  const json = await postKickWeb('/v1/realtime/auth/connection', { client_id: clientId });
  const token = json && json.data && json.data.token;
  if (!token) return { error: 'no token in response' };
  return { token };
}

// Kick's Centrifugo server likely only accepts WebSocket handshakes with a kick.com Origin.
// Our socket is opened from twitch.tv, so rewrite the Origin header for that host.
const ORIGIN_RULE_ID = 1;
async function prepareKickSocket(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { error: 'bad url' };
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ORIGIN_RULE_ID],
    addRules: [
      {
        id: ORIGIN_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://kick.com' }]
        },
        condition: { requestDomains: [host], resourceTypes: ['websocket'] }
      }
    ]
  });
  debugLog('Origin rewrite active for', host);
  return { ok: true };
}


// ---- Auto-pairing of verified streamers ----
//
// When the user opens a channel that has no pair yet: if it's verified on the current platform
// and an account with the same name is verified on the other platform, add the pair.

// Public Client-ID used by the twitch.tv website itself for anonymous GraphQL requests.
const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const AUTO_PAIR_PREFIX = 'autoPair:';
const AUTO_PAIR_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// Returns { exists, verified, name } (verified = Twitch Partner checkmark).
async function checkTwitch(login) {
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return { exists: false, verified: false };
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Client-Id': TWITCH_GQL_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($login: String!) { user(login: $login) { login roles { isPartner } } }',
      variables: { login }
    })
  });
  if (!res.ok) throw new Error(`Twitch GQL HTTP ${res.status}`);
  const json = await res.json();
  const user = json && json.data && json.data.user;
  if (!user) return { exists: false, verified: false };
  return { exists: true, verified: !!(user.roles && user.roles.isPartner), name: user.login };
}

// Returns { exists, verified, name }.
async function checkKick(slug) {
  const res = await fetchKickChannel(slug);
  if (res.notFound) return { exists: false, verified: false };
  if (!res.data) throw new Error(`Kick ${res.error}`);
  // `verified` is a boolean in v2 and an object (or null) in v1.
  return { exists: true, verified: !!res.data.verified, name: res.data.slug || slug };
}

async function checkFirst(check, candidates) {
  for (const c of candidates) {
    const r = await check(c);
    if (r.exists) return r;
  }
  return { exists: false, verified: false };
}

async function addPairIfMissing(twitch, kick) {
  const settings = await MCM.getSettings();
  const pairs = settings.pairs || [];
  const taken = pairs.some(
    (p) => p && (MCM.sameTwitchName(p.twitch, twitch) || MCM.sameKickName(p.kick, kick))
  );
  if (taken) return false;
  // New entries go to the top of the list.
  await chrome.storage.sync.set({ pairs: [{ twitch, kick }, ...pairs] });
  return true;
}

async function autoPair(platform, channel) {
  const name = MCM.normalizeName(channel);
  if (!name || (platform !== 'twitch' && platform !== 'kick')) return { error: 'bad request' };

  const settings = await MCM.getSettings();
  if (!settings.autoPair) return { skipped: 'disabled' };

  const cacheKey = `${AUTO_PAIR_PREFIX}${platform}:${name}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  // An added pair is never re-added (the user may have removed it on purpose).
  if (cached && (cached.result === 'added' || Date.now() - cached.at < AUTO_PAIR_RECHECK_MS)) {
    return { skipped: 'cached', result: cached.result };
  }

  let result = 'no-match';
  let pair = null;
  try {
    if (platform === 'twitch') {
      const here = await checkTwitch(name);
      if (here.verified) {
        const other = await checkFirst(checkKick, [...new Set([name, name.replace(/_/g, '-')])]);
        if (other.verified) pair = { twitch: here.name, kick: other.name };
      }
    } else {
      const here = await checkKick(name);
      if (here.verified) {
        const other = await checkFirst(checkTwitch, [...new Set([name, name.replace(/-/g, '_')])]);
        if (other.verified) pair = { twitch: other.name, kick: here.name };
      }
    }
  } catch (e) {
    // Network/API errors are not cached, so we retry on the next visit.
    debugLog('auto-pair check failed', platform, name, e);
    return { error: String((e && e.message) || e) };
  }

  if (pair) {
    const added = await addPairIfMissing(MCM.normalizeName(pair.twitch), MCM.normalizeName(pair.kick));
    result = added ? 'added' : 'exists';
    debugLog('auto-pair', result, pair);
  }
  await chrome.storage.local.set({ [cacheKey]: { result, at: Date.now() } });
  return { result, pair };
}
