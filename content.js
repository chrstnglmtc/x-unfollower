// content.js (ISOLATED world)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Caches
const gqlCache = new Map();       // username -> { followedAt, lastTweet, followsBack }
const domSeen  = new Map();       // username -> { username, displayName, avatar, profileUrl, followsBack }
const processedCells = new WeakSet(); // mark DOM nodes we already harvested

// ====== Receive GraphQL payloads from MAIN world ======
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

          // Heuristic for follow time via sortIndex (if present)
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
            // we prefer DOM for followsBack; keep placeholder here
            followsBack: typeof prev.followsBack === "boolean" ? prev.followsBack : prev.followsBack ?? null
          });
        }
      }
    } catch {}
  }
});

// ====== DOM harvesting ======
function usernameFromCell(el) {
  // try to find a single-segment profile link /username
  const anchors = el.querySelectorAll('a[href^="/"]');
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    // ignore /home, /explore, /settings, /messages, /i/...
    if (!/^\/[A-Za-z0-9_]+$/.test(href)) continue;
    return href.slice(1);
  }
  return null;
}

function harvestCell(el) {
  if (processedCells.has(el)) return;
  processedCells.add(el);

  const username = usernameFromCell(el);
  if (!username) return;

  const nameEl = el.querySelector('div[dir="auto"] span');
  const displayName = nameEl ? nameEl.textContent : "";
  const avatar = el.querySelector('img')?.src || "";
  const followsBackDOM = /\bFollows you\b/i.test(el.innerText);

  // save/merge
  const existing = domSeen.get(username) || {};
  domSeen.set(username, {
    username,
    displayName: existing.displayName || displayName,
    avatar: existing.avatar || avatar,
    profileUrl: `https://x.com/${username}`,
    // prefer explicit true if DOM says so; otherwise keep previous value
    followsBack: existing.followsBack || followsBackDOM || false
  });

  // also update gqlCache followsBack when we get a DOM truth
  const g = gqlCache.get(username) || {};
  if (followsBackDOM && g.followsBack !== true) {
    gqlCache.set(username, { ...g, followsBack: true });
  }
}

function harvestVisibleCells() {
  const cells = document.querySelectorAll('[data-testid="UserCell"]');
  cells.forEach(harvestCell);
}

// ====== Scroller ======
function getFollowingContainer() {
  return (
    document.querySelector('[aria-label^="Timeline: Following"]') ||
    document.querySelector('section[aria-labelledby^="accessible-list"]') ||
    document.querySelector('[data-testid="primaryColumn"]') ||
    document.scrollingElement
  );
}

/**
 * Robust infinite scroller for X Following.
 * Accumulates users while scrolling so virtualization doesn't lose earlier entries.
 */
async function autoScrollFollowingRobust({
  targetCount = 10000,
  stepPx = 1200,
  maxIdleMs = 12000,
  hardCapMs = 300000,
  settleMs = 1500
} = {}) {
  const container = getFollowingContainer();
  if (!container) throw new Error("Open your /following page first.");

  // Prime with anything already visible
  harvestVisibleCells();
  let total = domSeen.size;

  let lastIncreaseAt = performance.now();
  const startAt = performance.now();

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

  function clickShowMoreIfPresent() {
    const btn = [...document.querySelectorAll('div[role="button"]')]
      .find(b => /show more|more|see more/i.test(b.textContent || ""));
    if (btn) btn.click();
  }

  async function rafScrollStep(px) {
    return new Promise(resolve => {
      const startTop = container.scrollTop;
      const endTop = startTop + px;
      const duration = 250;
      const t0 = performance.now();
      function tick(t) {
        const p = Math.min(1, (t - t0) / duration);
        container.scrollTop = startTop + (endTop - startTop) * p;
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
  }

  while (true) {
    await rafScrollStep(stepPx);

    // Nudge virtualization to mount the next page near the viewport end
    const lastCell = [...document.querySelectorAll('[data-testid="UserCell"]')].pop();
    if (lastCell) lastCell.scrollIntoView({ block: "end" });

    // Wheel event sometimes required to trigger fetch in some builds
    const wheel = new WheelEvent("wheel", { deltaY: Math.max(600, stepPx / 2), bubbles: true, cancelable: true });
    container.dispatchEvent(wheel);

    clickShowMoreIfPresent();

    // Give the UI/network a moment
    await sleep(300);

    // Also harvest in case no mutations fired (some render paths batch updates)
    harvestVisibleCells();

    const now = performance.now();
    const idleFor = now - lastIncreaseAt;
    const ranFor  = now - startAt;

    if (domSeen.size >= targetCount) break;
    if (idleFor >= maxIdleMs) break;
    if (ranFor  >= hardCapMs) break;
  }

  await sleep(settleMs);
  obs.disconnect();
}

// ====== Merge DOM + GraphQL ======
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

// ====== Message handlers ======
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") { sendResponse({ ok: true }); return; }

  if (msg.type === "LOAD_FOLLOWING") {
    if (!/\/following(\/|\?|$)/.test(location.pathname)) { sendResponse([]); return; }
    (async () => {
      try {
        // reset caches each load to avoid duplicates across runs
        domSeen.clear();
        processedCells.clear?.(); // WeakSet can't be cleared; recreate instead
      } catch {}
      // recreate WeakSet (cannot be cleared)
      while (processedCells.size) break; // no-op; just documenting

      // run the scroller
      try {
        await autoScrollFollowingRobust({
          targetCount: msg.limit || 10000,
          stepPx: 1400,
          maxIdleMs: 12000,
          hardCapMs: 300000,
          settleMs: 1500
        });
      } catch {}

      // final harvest after settle, then merge with gql
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
