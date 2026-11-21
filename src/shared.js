// Shared helpers used by the popup and the content scripts.
globalThis.MCM = globalThis.MCM || {};

MCM.DEFAULT_SETTINGS = {
  enabled: true,
  // 'auto'   - inject into native chat when possible, otherwise use a floating panel
  // 'inline' - always inject into native chat
  // 'panel'  - always use a floating panel
  displayMode: 'auto',
  // Automatically add a pair when a verified streamer has a verified account
  // with the same name on the other platform.
  autoPair: true,
  // [{ twitch: 'name', kick: 'name' }]
  pairs: []
};

MCM.getSettings = async function () {
  return chrome.storage.sync.get(MCM.DEFAULT_SETTINGS);
};

// Accepts a plain nick, "@nick" or a full channel URL and returns a lowercase channel name.
MCM.normalizeName = function (input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.)/i, '');
  s = s.replace(/^(twitch\.tv|kick\.com)\//i, '');
  s = s.replace(/^popout\//i, '');
  s = s.split(/[/?#\s]/)[0];
  s = s.replace(/^@/, '');
  return s.toLowerCase();
};

// Kick slugs use "-" where usernames may contain "_".
MCM.sameKickName = function (a, b) {
  const norm = (x) => MCM.normalizeName(x).replace(/_/g, '-');
  return norm(a) !== '' && norm(a) === norm(b);
};

MCM.sameTwitchName = function (a, b) {
  const na = MCM.normalizeName(a);
  return na !== '' && na === MCM.normalizeName(b);
};
