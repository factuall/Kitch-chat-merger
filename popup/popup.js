const pairsEl = document.getElementById('pairs');
const enabledEl = document.getElementById('enabled');
const autoPairEl = document.getElementById('autoPair');
const modeEl = document.getElementById('displayMode');
const statusEl = document.getElementById('status');

let saveTimer = null;
let lastSavedPairs = null; // JSON of pairs we wrote, to ignore our own storage events

// position: 'top' (new entries) or 'bottom' (initial render, keeps stored order)
function addRow(pair = { twitch: '', kick: '' }, position = 'bottom') {
  const tr = document.createElement('tr');

  const makeInput = (platform, value) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.platform = platform;
    input.placeholder = platform === 'twitch' ? 'twitch nick' : 'kick nick';
    input.value = value || '';
    input.addEventListener('input', scheduleSave);
    input.addEventListener('blur', () => {
      input.value = MCM.normalizeName(input.value);
      scheduleSave();
    });
    const td = document.createElement('td');
    td.append(input);
    return td;
  };

  const removeTd = document.createElement('td');
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    tr.remove();
    if (!pairsEl.children.length) addRow();
    scheduleSave();
  });
  removeTd.append(removeBtn);

  tr.append(makeInput('twitch', pair.twitch), makeInput('kick', pair.kick), removeTd);
  if (position === 'top') pairsEl.prepend(tr);
  else pairsEl.append(tr);
  return tr;
}

function renderPairs(pairs) {
  pairsEl.replaceChildren();
  for (const pair of pairs) addRow(pair);
  if (!pairs.length) addRow();
}

function collectPairs() {
  const pairs = [];
  for (const tr of pairsEl.querySelectorAll('tr')) {
    const twitch = MCM.normalizeName(tr.querySelector('[data-platform="twitch"]').value);
    const kick = MCM.normalizeName(tr.querySelector('[data-platform="kick"]').value);
    if (twitch || kick) pairs.push({ twitch, kick });
  }
  return pairs;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  statusEl.textContent = 'Saving...';
  saveTimer = setTimeout(save, 300);
}

async function save() {
  saveTimer = null;
  const pairs = collectPairs();
  lastSavedPairs = JSON.stringify(pairs);
  await chrome.storage.sync.set({
    enabled: enabledEl.checked,
    autoPair: autoPairEl.checked,
    displayMode: modeEl.value,
    pairs
  });
  statusEl.textContent = 'Saved. Incomplete pairs (missing one nick) are ignored.';
}

async function init() {
  const settings = await MCM.getSettings();
  enabledEl.checked = settings.enabled;
  autoPairEl.checked = settings.autoPair;
  modeEl.value = settings.displayMode;
  renderPairs(settings.pairs);

  enabledEl.addEventListener('change', scheduleSave);
  autoPairEl.addEventListener('change', scheduleSave);
  modeEl.addEventListener('change', scheduleSave);
  document.getElementById('add').addEventListener('click', () => {
    addRow(undefined, 'top').querySelector('input').focus();
  });

  // Pairs added automatically while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.pairs) return;
    const incoming = changes.pairs.newValue || [];
    if (JSON.stringify(incoming) === lastSavedPairs || saveTimer) return;
    renderPairs(incoming);
  });
}

init();
