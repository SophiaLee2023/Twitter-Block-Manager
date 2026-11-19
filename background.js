// Service worker: keeps the toolbar badge in sync and looks up GraphQL query
// ids in X's script bundles (done here because content scripts are bound by
// the page's CORS rules and the bundles live on abs.twimg.com).

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
}

async function updateBadge() {
  const { accounts = {}, activeUid } = await chrome.storage.local.get(['accounts', 'activeUid']);
  const blocked = accounts[activeUid]?.blocked;
  await chrome.action.setBadgeBackgroundColor({ color: '#536471' });
  await chrome.action.setBadgeText({ text: typeof blocked === 'number' ? compact(blocked) : '' });
}

async function findQueryIds(urls, ops) {
  const found = {};
  for (const url of urls) {
    if (ops.every((op) => found[op])) break;
    if (!url.startsWith('https://abs.twimg.com/')) continue;
    let text;
    try {
      text = await (await fetch(url)).text();
    } catch {
      continue;
    }
    for (const op of ops) {
      if (found[op]) continue;
      const m = text.match(new RegExp(`queryId:"([^"]+)",operationName:"${op}"`));
      if (m) found[op] = m[1];
    }
  }
  return found;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'findQueryIds') return;
  findQueryIds(msg.urls, msg.ops).then(sendResponse, () => sendResponse({}));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.accounts || changes.activeUid)) updateBadge();
});
chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
