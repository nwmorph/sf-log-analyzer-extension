const NEWTAB_URL = chrome.runtime.getURL('newtab/index.html');
const API_VERSION = 'v65.0';

// Open the analyzer tab when the toolbar icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  // Check if the analyzer tab is already open
  const existing = await chrome.tabs.query({ url: NEWTAB_URL });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: NEWTAB_URL });
  }
});

// Store org URL from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'orgDetected' && message.orgUrl) {
    chrome.storage.session.set({ orgUrl: message.orgUrl });
  }
});

// Handle API requests from the new tab (needs to run in background to carry cookies)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'fetchLogs') {
    fetchLogs(message.orgUrl)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.type === 'fetchLogBody') {
    fetchLogBody(message.orgUrl, message.logId)
      .then(text => sendResponse({ ok: true, text }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'deleteLog') {
    deleteLog(message.orgUrl, message.logId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function getSessionToken(orgUrl) {
  // Salesforce stores the session in the 'sid' cookie
  const cookie = await chrome.cookies.get({ url: orgUrl, name: 'sid' });
  if (cookie) return cookie.value;
  // Fallback: try 'sidCommunity' for Experience Cloud
  const fallback = await chrome.cookies.get({ url: orgUrl, name: 'sidCommunity' });
  if (fallback) return fallback.value;
  throw new Error('Not logged in to this Salesforce org. Please log in and try again.');
}

async function fetchLogs(orgUrl) {
  const sid = await getSessionToken(orgUrl);
  const query = encodeURIComponent(
    `SELECT Id, LogUser.Name, Application, Operation, Request, StartTime, Status, LogLength, DurationMilliseconds
     FROM ApexLog
     ORDER BY StartTime DESC
     LIMIT 200`
  );
  const url = `${orgUrl}/services/data/${API_VERSION}/tooling/query/?q=${query}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${sid}`,
      'Content-Type': 'application/json',
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function fetchLogBody(orgUrl, logId) {
  const sid = await getSessionToken(orgUrl);
  const url = `${orgUrl}/services/data/${API_VERSION}/tooling/sobjects/ApexLog/${logId}/Body`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${sid}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.text();
}

async function deleteLog(orgUrl, logId) {
  const sid = await getSessionToken(orgUrl);
  const url = `${orgUrl}/services/data/${API_VERSION}/tooling/sobjects/ApexLog/${logId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${sid}` }
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Delete failed ${res.status}: ${text.substring(0, 200)}`);
  }
}
