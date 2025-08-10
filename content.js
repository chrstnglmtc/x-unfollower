const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const gqlCache = new Map();
const domSeen  = new Map();
let processedCells = new WeakSet();

window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || !d.__XFM__) return;
  if (d.type === "GQL_TEXT" && d.payload && d.payload.text) {
    try {
      const json = JSON.parse(d.payload.text);
      const instructions = json?.data?.user?.result?.timeline?.timeline?.instructions || [];
      for (const ins of instructions) {
        const entries = ins.entries || ins.addEntries?.entries || [];
        for (const entry of entries) {
          const ures = entry?.content?.itemContent?.user_results?.result;
          const legacy = ures?.legacy;
          if (!legacy?.screen_name) continue;
          const username = legacy.screen_name;
          let followedAt = null;
          const idx = entry?.sortIndex;
          if (idx && /^\d+$/.test(String(idx))) {
            const n = Number(idx);
            if (n > 1e11) {
              followedAt = new Date(n > 1e13 ? Math.floor(n / 1000) : n).toISOString();
            }
          }
          const lastTweet = legacy?.status?.created_at
            ? new Date(legacy.status.created_at).toISOString()
            : null;
          const prev = gqlCache.get(username) || {};
          gqlCache.set(username, {
            followedAt: prev.followedAt || followedAt || null,
            lastTweet: prev.lastTweet || lastTweet || null,
            followsBack: typeof prev.followsBack === "boolean" ? prev.followsBack : prev.followsBack ?? null
          });
        }
      }
    } catch {}
  }
});

function usernameFromCell(el) {
  const anchors = el.querySelectorAll('a[href^="/"]');
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    if (/^\/[A-Za-z0-9_]+$/.test(href)) return href.slice(1);
  }
  return null;
}

function harvestCell(el) {
  if (processedCells.has(el)) return;
  processedCells.add(el);
  const username = usernameFromCell(el);
  if (!username) return;
  const displayNameEl =
    el.querySelector('[data-testid="User-Name"] span') ||
    el.querySelector(`a[role="link"][href="/${username}"] span`);
  const displayName = displayNameEl ? displayNameEl.textContent.trim() : "";
  const avatar =
    el.querySelector('img[src^="https://"]')?.src ||
    el.querySelector('img')?.src ||
    "";
  const followsBackDOM = /\bFollows you\b/i.test(el.innerText);
  const existing = domSeen.get(username) || {};
  domSeen.set(username, {
    username,
    displayName: existing.displayName || displayName,
    avatar: existing.avatar || avatar,
    profileUrl: `https://x.com/${username}`,
    followsBack: existing.followsBack || followsBackDOM || false
  });
  const g = gqlCache.get(username) || {};
  if (followsBackDOM && g.followsBack !== true) {
    gqlCache.set(username, { ...g, followsBack: true });
  }
}

function harvestVisibleCells() {
  const cells = document.querySelectorAll('[data-testid="UserCell"]');
  cells.forEach(harvestCell);
}

function getFollowingContainer() {
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (primary && primary.scrollHeight > primary.clientHeight) return primary;
  const region =
    document.querySelector('[aria-label^="Timeline: Following"]') ||
    document.querySelector('[aria-label*="Following"][role="region"]');
  if (region && region.scrollHeight > region.clientHeight) return region;
  return document.scrollingElement || document.documentElement || document.body;
}

async function autoScrollFollowingRobust({
  targetCount = 10000,
  stepPx = 1400,
  maxIdleMs = 15000,
  hardCapMs = 360000,
  settleMs = 1500
} = {}) {
  const container = getFollowingContainer();
  if (!container) throw new Error("Open your /following page first.");

  harvestVisibleCells();
  let total = domSeen.size;
  let lastIncreaseAt = performance.now();
  const startAt = performance.now();

  const getScrollTop = () =>
    container === document.scrollingElement ? window.scrollY : container.scrollTop;
  const getScrollHeight = () =>
    container === document.scrollingElement
      ? document.documentElement.scrollHeight
      : container.scrollHeight;
  const setScrollTop = (top) => {
    if (container === document.scrollingElement) window.scrollTo({ top, behavior: "instant" });
    else container.scrollTop = top;
  };

  let lastScrollTop = getScrollTop();
  let lastScrollHeight = getScrollHeight();

  const observeTarget = container === document.scrollingElement ? document.body : container;
  const obs = new MutationObserver(() => {
    harvestVisibleCells();
    const n = domSeen.size;
    if (n > total) {
      total = n;
      lastIncreaseAt = performance.now();
    }
  });
  obs.observe(observeTarget, { childList: true, subtree: true });

  const clickShowMoreIfPresent = () => {
    const btn = [...document.querySelectorAll('div[role="button"]')]
      .find(b => /show more|more|see more/i.test((b.textContent || "").trim()));
    if (btn) btn.click();
  };
  const keyNudge = () => {
    const ev = new KeyboardEvent("keydown", { key: "PageDown", code: "PageDown", bubbles: true });
    (container === document.scrollingElement ? window : container).dispatchEvent(ev);
  };
  const wheelNudge = () => {
    const ev = new WheelEvent("wheel", { deltaY: Math.max(600, stepPx / 2), bubbles: true, cancelable: true });
    (container === document.scrollingElement ? window : container).dispatchEvent(ev);
  };
  const rafScrollStep = (px) =>
    new Promise(resolve => {
      const startTop = getScrollTop();
      const endTop = startTop + px;
      const t0 = performance.now();
      const dur = 240;
      function tick(t) {
        const p = Math.min(1, (t - t0) / dur);
        setScrollTop(startTop + (endTop - startTop) * p);
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
  const scrollLastCellIntoView = () => {
    const lastCell = [...document.querySelectorAll('[data-testid="UserCell"]')].pop();
    if (lastCell) lastCell.scrollIntoView({ block: "end" });
  };

  while (true) {
    const beforeCount = domSeen.size;
    const beforeTop = getScrollTop();
    const beforeHeight = getScrollHeight();

    await rafScrollStep(stepPx);
    scrollLastCellIntoView();
    wheelNudge();
    keyNudge();
    clickShowMoreIfPresent();

    await sleep(350);
    harvestVisibleCells();

    const afterCount = domSeen.size;
    if (afterCount > total) {
      total = afterCount;
      lastIncreaseAt = performance.now();
    }

    const nowTop = getScrollTop();
    const nowHeight = getScrollHeight();

    if (nowTop === beforeTop && nowHeight === beforeHeight) {
      await rafScrollStep(Math.floor(stepPx / 2));
      wheelNudge();
      await sleep(250);
      harvestVisibleCells();
      if (domSeen.size > total) {
        total = domSeen.size;
        lastIncreaseAt = performance.now();
      }
    }

    const now = performance.now();
    const idleFor = now - lastIncreaseAt;
    const ranFor = now - startAt;

    if (domSeen.size >= targetCount) break;
    if (idleFor >= maxIdleMs) break;
    if (ranFor >= hardCapMs) break;

    lastScrollTop = nowTop;
    lastScrollHeight = nowHeight;
  }

  await sleep(settleMs);
  obs.disconnect();
}

function mergeUsersFromCaches() {
  const out = [];
  for (const [username, dom] of domSeen) {
    const extra = gqlCache.get(username) || {};
    out.push({
      username,
      displayName: dom.displayName,
      avatar: dom.avatar,
      profileUrl: dom.profileUrl,
      followsBack: typeof extra.followsBack === "boolean" ? extra.followsBack : dom.followsBack,
      followedAt: extra.followedAt || null,
      lastTweet: extra.lastTweet || null
    });
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") { sendResponse({ ok: true }); return; }
  if (msg.type === "LOAD_FOLLOWING") {
    if (!/\/following(\/|\?|$)/.test(location.pathname)) { sendResponse([]); return; }
    (async () => {
      domSeen.clear();
      gqlCache.clear();
      processedCells = new WeakSet();
      try {
        await autoScrollFollowingRobust({
          targetCount: msg.limit || 10000,
          stepPx: 1400,
          maxIdleMs: 15000,
          hardCapMs: 360000,
          settleMs: 1500
        });
      } catch {}
      harvestVisibleCells();
      const merged = mergeUsersFromCaches();
      sendResponse(merged);
    })();
    return true;
  }
  if (msg.type === "UNFOLLOW_USERS") {
    (async () => {
      let done = 0;
      for (const username of msg.usernames || []) {
        const cell = [...document.querySelectorAll('[data-testid="UserCell"]')]
          .find(el => el.querySelector(`a[href="/${username}"]`));
        if (!cell) continue;
        const btn = cell.querySelector('[data-testid$="-unfollow"]') ||
                    cell.querySelector('div[role="button"][data-testid*="-unfollow"]');
        if (!btn) continue;
        btn.click();
        await sleep(350);
        const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]') ||
                        [...document.querySelectorAll('div[role="button"]')].find(b => /Unfollow/i.test(b.textContent||""));
        if (confirm) confirm.click();
        done++;
        await sleep(900 + Math.random() * 600);
      }
      chrome.runtime.sendMessage({ type: "SHOW_DONE", count: done });
      sendResponse({ success: true, count: done });
    })();
    return true;
  }
});
