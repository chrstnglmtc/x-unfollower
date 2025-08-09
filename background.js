chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SHOW_DONE") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Unfollow Complete",
      message: `Unfollowed ${msg.count} account(s).`,
      priority: 2
    });
  }
});
