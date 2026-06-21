// Detect the Salesforce org URL and store it for the extension new tab
(function () {
  const origin = window.location.origin;
  // Only report if this looks like a real Salesforce org page, not a CDN
  if (!origin || origin === 'null') return;

  chrome.storage.session.set({ orgUrl: origin }, () => {
    // Also notify the background in case a new tab is already open
    chrome.runtime.sendMessage({ type: 'orgDetected', orgUrl: origin }).catch(() => {});
  });
})();
