// Seltigo eklentisi - arka plan (Manifest V3 service worker)
// Şimdilik yalnız kurulumda karşılama; ürün okuma ve ekleme açılır pencerede (popup.js) yapılır.
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.storage.local.set({ installedAt: Date.now() });
});
