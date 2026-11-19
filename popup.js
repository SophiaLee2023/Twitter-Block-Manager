const $ = (id) => document.getElementById(id);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '–');

let localMessage = '';

function ago(t) {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(t).toLocaleDateString();
}

function renderDelta(el, now, before) {
  el.className = 'delta';
  if (typeof now !== 'number' || typeof before !== 'number' || now === before) {
    el.textContent = '';
    return;
  }
  const diff = now - before;
  el.textContent = `${diff > 0 ? '+' : '−'}${Math.abs(diff).toLocaleString()} since last change`;
  el.classList.add(diff > 0 ? 'up' : 'down');
}

async function render() {
  const { accounts = {}, activeUid, status } = await chrome.storage.local.get(['accounts', 'activeUid', 'status']);
  const account = accounts[activeUid];
  const history = account?.history || [];
  const previous = history[history.length - 2];

  $('blocked').textContent = fmt(account?.blocked);
  $('muted').textContent = fmt(account?.muted);
  renderDelta($('blocked-delta'), account?.blocked, previous?.blocked);
  renderDelta($('muted-delta'), account?.muted, previous?.muted);

  const statusEl = $('status');
  const syncing = status?.state === 'syncing' && Date.now() - status.at < 20 * 60 * 1000;
  statusEl.className = '';
  if (localMessage) {
    statusEl.textContent = localMessage;
    statusEl.className = 'error';
  } else if (syncing) {
    statusEl.textContent = status.message || 'Syncing…';
  } else if (status?.state === 'error') {
    statusEl.textContent = status.message;
    statusEl.className = 'error';
  } else if (account?.syncedAt) {
    statusEl.textContent = `Updated ${ago(account.syncedAt)}`;
  } else {
    statusEl.textContent = 'Open x.com while logged in to start tracking.';
  }
  $('refresh').disabled = syncing;

  $('history-wrap').hidden = history.length < 2;
  const rows = history.slice(-10).reverse();
  $('history').replaceChildren(
    ...rows.map((entry) => {
      const tr = document.createElement('tr');
      const date = new Date(entry.t).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
      for (const text of [date, fmt(entry.blocked), fmt(entry.muted)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    })
  );
}

$('refresh').addEventListener('click', async () => {
  localMessage = '';
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (!tabs.length) {
    localMessage = 'Open x.com in a tab first, then press Refresh.';
    return render();
  }
  let reached = false;
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'sync' });
      reached = true;
      break;
    } catch {
      // Tab was open before the extension loaded; try the next one.
    }
  }
  if (!reached) localMessage = 'Reload your x.com tab, then press Refresh.';
  render();
});

chrome.storage.onChanged.addListener(render);
render();
