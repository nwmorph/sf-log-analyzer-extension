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

  if (message.type === 'getApexSource') {
    getApexSource(message.orgUrl, message.className)
      .then(body => sendResponse({ ok: true, body }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'getFlowDescription') {
    getFlowDescription(message.orgUrl, message.flowLabel)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'getValidationRuleDescription') {
    getValidationRuleDescription(message.orgUrl, message.ruleName, message.objectName)
      .then(desc => sendResponse({ ok: true, description: desc }))
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

function toApiUrl(orgUrl) {
  // Convert Lightning UI URL to REST API base URL
  // e.g. https://myorg.sandbox.lightning.force.com → https://myorg.sandbox.my.salesforce.com
  // e.g. https://myorg.lightning.force.com         → https://myorg.my.salesforce.com
  try {
    const url = new URL(orgUrl);
    const host = url.hostname;
    // Lightning force.com → my.salesforce.com
    if (host.endsWith('.lightning.force.com')) {
      const sub = host.replace('.lightning.force.com', '');
      return `https://${sub}.my.salesforce.com`;
    }
    // visualforce.com → my.salesforce.com (e.g. myorg.visual.force.com)
    if (host.endsWith('.visual.force.com')) {
      const sub = host.replace('.visual.force.com', '');
      return `https://${sub}.my.salesforce.com`;
    }
    // Already a good API URL
    return orgUrl;
  } catch {
    return orgUrl;
  }
}

async function getSessionToken(orgUrl) {
  // Try the API URL domain first (sid lives on my.salesforce.com, not lightning.force.com)
  const apiUrl = toApiUrl(orgUrl);
  const candidateUrls = apiUrl !== orgUrl ? [apiUrl, orgUrl] : [orgUrl];

  for (const url of candidateUrls) {
    const cookie = await chrome.cookies.get({ url, name: 'sid' });
    if (cookie) return cookie.value;
    const fallback = await chrome.cookies.get({ url, name: 'sidCommunity' });
    if (fallback) return fallback.value;
  }
  throw new Error('Not logged in to this Salesforce org, or session has expired. Please log in and try again.');
}

async function fetchLogs(orgUrl) {
  const sid = await getSessionToken(orgUrl);
  orgUrl = toApiUrl(orgUrl);
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
  orgUrl = toApiUrl(orgUrl);
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
  orgUrl = toApiUrl(orgUrl);
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

// Cache apex source to avoid repeated API calls for same class
const apexSourceCache = {};

async function getApexSource(orgUrl, className) {
  const cacheKey = `${orgUrl}::${className}`;
  if (apexSourceCache[cacheKey] !== undefined) return apexSourceCache[cacheKey];

  const sid = await getSessionToken(orgUrl);
  const apiUrl = toApiUrl(orgUrl);
  // Try ApexClass first, then ApexTrigger
  for (const type of ['ApexClass', 'ApexTrigger']) {
    const q = encodeURIComponent(`SELECT Body FROM ${type} WHERE Name = '${className.replace(/'/g,"\\'")}' LIMIT 1`);
    const res = await fetch(`${apiUrl}/services/data/${API_VERSION}/tooling/query/?q=${q}`, {
      headers: { 'Authorization': `Bearer ${sid}` }
    });
    if (!res.ok) continue;
    const json = await res.json();
    const body = json.records?.[0]?.Body;
    if (body) {
      apexSourceCache[cacheKey] = body;
      return body;
    }
  }
  apexSourceCache[cacheKey] = null;
  return null;
}

// Cache for metadata queries
const metadataCache = {};

async function queryTooling(orgUrl, soql) {
  const sid = await getSessionToken(orgUrl);
  const apiUrl = toApiUrl(orgUrl);
  const q = encodeURIComponent(soql);
  const res = await fetch(`${apiUrl}/services/data/${API_VERSION}/tooling/query/?q=${q}`, {
    headers: { 'Authorization': `Bearer ${sid}` }
  });
  if (res.status === 403 || res.status === 401) {
    throw new Error('ACCESS_DENIED');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text.substring(0, 150)}`);
  }
  return res.json();
}

async function getFlowDescription(orgUrl, flowLabel) {
  const key = `flow::${orgUrl}::${flowLabel}`;
  if (metadataCache[key] !== undefined) return metadataCache[key];
  try {
    // Normalise label for matching — remove namespace prefix noise
    const bare = flowLabel.split(':').pop().trim();
    const json = await queryTooling(orgUrl,
      `SELECT DeveloperName, Description, ActiveVersionId FROM FlowDefinition WHERE MasterLabel LIKE '${bare.replace(/'/g, "\\'")}' LIMIT 5`);
    const record = json.records?.[0];
    const result = { description: record?.Description || null, activeVersionId: record?.ActiveVersionId || null, devName: record?.DeveloperName || null };
    metadataCache[key] = result;
    return result;
  } catch (e) {
    if (e.message === 'ACCESS_DENIED') return { description: null, accessDenied: true };
    return { description: null };
  }
}

async function getValidationRuleDescription(orgUrl, ruleName, objectName) {
  const key = `vr::${orgUrl}::${objectName}::${ruleName}`;
  if (metadataCache[key] !== undefined) return metadataCache[key];
  try {
    const json = await queryTooling(orgUrl,
      `SELECT Description FROM ValidationRule WHERE ValidationName = '${ruleName.replace(/'/g, "\\'")}' LIMIT 1`);
    const desc = json.records?.[0]?.Description || null;
    metadataCache[key] = desc;
    return desc;
  } catch (e) {
    if (e.message === 'ACCESS_DENIED') return null;
    return null;
  }
}

