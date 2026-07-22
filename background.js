// dryRead background service worker
// 点击工具栏图标时直接打开侧栏
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[dryRead] setPanelBehavior failed:', err));
