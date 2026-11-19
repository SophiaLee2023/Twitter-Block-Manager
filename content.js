// Runs on x.com. Counts the logged-in account's blocked and muted accounts by
// paging through the same internal API the site itself uses, with the
// session the browser already has. Nothing leaves the browser.

(() => {
  // Public bearer token of the X web client (identical for every user).
  const BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const AUTO_SYNC_MS = 6 * 60 * 60 * 1000;
  const LOCK_STALE_MS = 2 * 60 * 1000;
  const MAX_HISTORY = 500;

  const KINDS = {
    blocked: { rest: '/i/api/1.1/blocks/ids.json', op: 'BlockedAccountsAll' },
    muted: { rest: '/i/api/1.1/mutes/users/ids.json', op: 'MutedAccounts' },
  };

  const learnedFeatures = {};
  let running = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cookie(name) {
    return document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))?.[1];
  }

  // Returns the logged-in user's id, or null when logged out.
  function currentUid() {
    const twid = cookie('twid');
    if (twid) return decodeURIComponent(twid).replace(/^"?u=/, '').replace(/"$/, '');
    return null;
  }

  function setStatus(state, message = '') {
    return chrome.storage.local.set({ status: { state, message, at: Date.now() } });
  }

  const heartbeat = () => chrome.storage.local.set({ syncLock: Date.now() });

  async function api(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          authorization: 'Bearer ' + BEARER,
          'x-csrf-token': cookie('ct0') || '',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
        },
      });
      if (res.status !== 429 || attempt >= 3) return res;

      // Rate limited: wait for the window to reset, keeping the lock alive.
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      const until = reset > Date.now() ? reset + 2000 : Date.now() + 60000;
      const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await setStatus('syncing', `Rate limited by X, resuming at ${at} (keep this tab open)`);
      while (Date.now() < until) {
        await heartbeat();
        await sleep(Math.min(30000, until - Date.now()));
      }
    }
  }

  async function countViaRest(kind, onProgress) {
    let total = 0;
    let cursor = '-1';
    while (cursor !== '0') {
      const res = await api(`${KINDS[kind].rest}?stringify_ids=true&count=5000&cursor=${cursor}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.ids)) throw new Error('unexpected response');
      total += json.ids.length;
      cursor = json.next_cursor_str ?? '0';
      await onProgress(total);
    }
    return total;
  }

  // Query ids change whenever X ships a new build. Look at requests the page
  // already made first, then fall back to scanning its script bundles.
  async function getQueryId(op, refresh = false) {
    const { queryIds = {} } = await chrome.storage.local.get('queryIds');
    if (!refresh && queryIds[op]) return queryIds[op];

    let id;
    for (const entry of performance.getEntriesByType('resource')) {
      const m = entry.name.match(/\/i\/api\/graphql\/([^/]+)\/([^/?]+)/);
      if (m && m[2] === op) id = m[1];
    }
    if (!id) {
      const urls = [...document.querySelectorAll('script[src]')]
        .map((s) => s.src)
        .filter((src) => src.startsWith('https://abs.twimg.com/'))
        .sort((a, b) => /\/main\./.test(b) - /\/main\./.test(a));
      const found = await chrome.runtime.sendMessage({ type: 'findQueryIds', urls, ops: [op] });
      id = found?.[op];
    }
    if (!id) {
      throw new Error('could not find the API id — open Settings → Blocked/Muted accounts on X once, then refresh');
    }
    await chrome.storage.local.set({ queryIds: { ...queryIds, [op]: id } });
    return id;
  }

  function collectEntries(node, out) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.entryId === 'string') out.push(node);
    for (const value of Object.values(node)) collectEntries(value, out);
  }

  async function countViaGraphql(kind, onProgress) {
    const { op } = KINDS[kind];
    let queryId = await getQueryId(op);
    let retriedId = false;
    const seen = new Set();
    let cursor;

    for (;;) {
      const variables = { count: 100, includePromotedContent: false, withSafetyModeUserFields: false };
      if (cursor) variables.cursor = cursor;
      const features = learnedFeatures[op] || {};
      const res = await api(
        `/i/api/graphql/${queryId}/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}` +
          `&features=${encodeURIComponent(JSON.stringify(features))}`
      );

      if (res.status === 404 && !retriedId) {
        retriedId = true;
        queryId = await getQueryId(op, true);
        continue;
      }
      const json = await res.json().catch(() => null);

      // X rejects requests that omit feature flags it expects, and names them.
      const missing = json?.errors?.[0]?.message?.match(/features cannot be null: (.+)$/);
      if (missing) {
        const names = missing[1].split(',').map((s) => s.trim()).filter((n) => !(n in features));
        if (!names.length) throw new Error(json.errors[0].message);
        learnedFeatures[op] = { ...features, ...Object.fromEntries(names.map((n) => [n, false])) };
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!json?.data) throw new Error(json?.errors?.[0]?.message || 'unexpected response');

      const entries = [];
      collectEntries(json.data, entries);
      const before = seen.size;
      let next;
      for (const entry of entries) {
        if (entry.entryId.startsWith('user-')) seen.add(entry.entryId);
        else if (entry.entryId.startsWith('cursor-bottom')) next = entry.content?.value ?? entry.value;
      }
      await onProgress(seen.size);
      if (seen.size === before || !next || next === cursor) return seen.size;
      cursor = next;
    }
  }

  async function count(kind) {
    const onProgress = async (n) => {
      await heartbeat();
      await setStatus('syncing', `Counting ${kind} accounts… ${n.toLocaleString()}`);
    };
    try {
      return await countViaRest(kind, onProgress);
    } catch (restError) {
      try {
        return await countViaGraphql(kind, onProgress);
      } catch (gqlError) {
        throw new Error(`${kind}: ${gqlError.message} (REST: ${restError.message})`);
      }
    }
  }

  async function sync(force) {
    const uid = currentUid();
    if (!uid) {
      if (force) await setStatus('error', 'Not logged in to X in this tab.');
      return;
    }
    if (running) return;

    const stored = await chrome.storage.local.get(['accounts', 'syncLock']);
    const account = stored.accounts?.[uid];
    if (Date.now() - (stored.syncLock || 0) < LOCK_STALE_MS) return; // another tab is syncing
    if (!force && account && Date.now() - account.syncedAt < AUTO_SYNC_MS) {
      await chrome.storage.local.set({ activeUid: uid });
      return;
    }

    running = true;
    await chrome.storage.local.set({ activeUid: uid, syncLock: Date.now() });
    const errors = [];
    const result = {};
    try {
      for (const kind of Object.keys(KINDS)) {
        try {
          result[kind] = await count(kind);
        } catch (e) {
          errors.push(e.message);
        }
      }

      // Re-read so we don't clobber anything written while we were counting.
      const { accounts = {} } = await chrome.storage.local.get('accounts');
      const prev = accounts[uid] || { history: [] };
      const next = { ...prev, ...result, history: prev.history || [] };
      if (Object.keys(result).length) {
        next.syncedAt = Date.now();
        const last = next.history[next.history.length - 1];
        if (!last || last.blocked !== next.blocked || last.muted !== next.muted) {
          next.history = [...next.history, { t: next.syncedAt, blocked: next.blocked, muted: next.muted }].slice(
            -MAX_HISTORY
          );
        }
      }
      await chrome.storage.local.set({ accounts: { ...accounts, [uid]: next } });
      await setStatus(errors.length ? 'error' : 'idle', errors.join(' · '));
    } finally {
      running = false;
      await chrome.storage.local.set({ syncLock: 0 });
    }
  }

  const safeSync = (force) =>
    sync(force).catch((e) => setStatus('error', e.message).catch(() => {}));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'sync') return;
    safeSync(true);
    sendResponse({ ok: true, loggedIn: !!currentUid() });
  });

  safeSync(false);
  // X is a single-page app, so tabs live for a long time; re-check hourly.
  setInterval(() => safeSync(false), 60 * 60 * 1000);
})();
