let loadedUsers = [];
let filteredUsers = [];
let selectedUsernames = new Set();

document.addEventListener("DOMContentLoaded", () => {
  const loadBtn = document.getElementById("loadBtn");
  const sortSelect = document.getElementById("sortOption");
  const limitSelect = document.getElementById("batchSize");
  const selectAllBtn = document.getElementById("selectAllBtn");
  const unselectAllBtn = document.getElementById("unselectAllBtn");
  const unfollowBtn = document.getElementById("unfollowBtn");
  const userList = document.getElementById("userList");
  const countEl = document.getElementById("count");

  sortSelect.disabled = true;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PROGRESS") {
      countEl.textContent = msg.count || 0;
    }
  });

  async function ensureConnected() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");
    const url = tab.url || "";
    if (!/^https:\/\/(x|twitter)\.com\/[^/]+\/following(\/|\?|$)/i.test(url)) {
      throw new Error("Open your Following page first.");
    }
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      if (pong?.ok) return tab;
    } catch {}
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const pong2 = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    if (!pong2?.ok) throw new Error("Could not reach page. Reload the Following tab and try again.");
    return tab;
  }

  loadBtn.addEventListener("click", async () => {
    const limit = parseInt(limitSelect.value, 10) || 1000;
    userList.innerHTML = `<i>Loading up to ${limit} accounts…</i>`;
    sortSelect.disabled = true;

    try {
      const tab = await ensureConnected();
      chrome.tabs.sendMessage(tab.id, { type: "LOAD_FOLLOWING", limit }, (data) => {
        if (chrome.runtime.lastError) {
          userList.innerHTML = `<i>${chrome.runtime.lastError.message}</i>`;
          return;
        }

        const newUsers = Array.isArray(data) ? data : [];

        // Merge new users with existing ones without duplicates
        const existingSet = new Set(loadedUsers.map(u => u.username));
        newUsers.forEach(u => {
          if (!existingSet.has(u.username)) {
            loadedUsers.push(u);
            existingSet.add(u.username);
          }
        });

        countEl.textContent = loadedUsers.length;
        applyFilter();
        sortSelect.disabled = false;
      });
    } catch (e) {
      userList.innerHTML = `<i>${e.message}</i>`;
      countEl.textContent = "0";
    }
  });

  sortSelect.addEventListener("change", applyFilter);

  selectAllBtn.addEventListener("click", () => {
    filteredUsers.forEach(u => selectedUsernames.add(u.username));
    render(filteredUsers);
  });

  unselectAllBtn.addEventListener("click", () => {
    filteredUsers.forEach(u => selectedUsernames.delete(u.username));
    render(filteredUsers);
  });

  unfollowBtn.addEventListener("click", async () => {
    if (selectedUsernames.size === 0) {
      alert("No accounts selected.");
      return;
    }
    if (!confirm(`Unfollow ${selectedUsernames.size} account(s)?`)) return;

    try {
      const tab = await ensureConnected();
      const toUnfollow = [...selectedUsernames];
      chrome.tabs.sendMessage(
        tab.id,
        { type: "UNFOLLOW_USERS", usernames: toUnfollow },
        (res) => {
          if (chrome.runtime.lastError) {
            alert(chrome.runtime.lastError.message);
            return;
          }
          if (res?.success) {
            const set = new Set(toUnfollow);
            loadedUsers = loadedUsers.filter(u => !set.has(u.username));
            filteredUsers = filteredUsers.filter(u => !set.has(u.username));
            toUnfollow.forEach(u => selectedUsernames.delete(u));
            countEl.textContent = loadedUsers.length;
            render(filteredUsers);
            alert(`Unfollowed ${res.count ?? 0} account(s).`);
          }
        }
      );
    } catch (e) {
      alert(e.message);
    }
  });

  function applyFilter() {
    const mode = sortSelect.value;
    filteredUsers = mode === "not-following-back"
      ? loadedUsers.filter(u => !u.followsBack)
      : [...loadedUsers];
    render(filteredUsers);
  }

  function render(users) {
    if (!users.length) {
      userList.innerHTML = "<i>No users found.</i>";
      return;
    }
    userList.innerHTML = users.map(u => `
      <div class="row">
        <input type="checkbox" class="pick" data-username="${u.username}" ${selectedUsernames.has(u.username) ? "checked" : ""}>
        ${u.avatar ? `<img class="avatar" src="${u.avatar}" alt="">` : `<div></div>`}
        <div class="meta">
          <div class="name">${escapeHtml(u.displayName || "")}</div>
          <div class="handle">@${u.username}</div>
        </div>
      </div>
    `).join("");

    document.querySelectorAll(".pick").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const un = e.target.dataset.username;
        if (e.target.checked) selectedUsernames.add(un);
        else selectedUsernames.delete(un);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[m]));
  }
});
