// app.js — Chrome extension glue: org detection, log list, log loading
// Runs after main.js (which provides renderLogSummary, parseLog, etc.)

let appOrgUrl = null;
let viewedLogIds = new Set(); // Track which logs have been viewed

// ── Startup ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load viewed log IDs from storage
  const stored = await chrome.storage.local.get('viewedLogIds');
  if (stored.viewedLogIds) {
    viewedLogIds = new Set(stored.viewedLogIds);
  }

  // Always try to load logs on open — no need to press Refresh manually
  await populateOrgSwitcher();
  loadLogList();

  document.getElementById('btn-refresh').addEventListener('click', () => {
    loadLogList();
  });

  document.getElementById('chk-unread-only').addEventListener('change', () => {
    renderLogTable(lastLogs);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'orgDetected' && message.orgUrl) {
    appOrgUrl = message.orgUrl;
    updateOrgDisplay(message.orgUrl);
  }
});

// ── Org display ───────────────────────────────────────────────────────────
function updateOrgDisplay(orgUrl) {
  const el = document.getElementById('sidebar-org');
  if (!el) return;
  try {
    el.textContent = new URL(orgUrl).hostname;
    el.title = orgUrl;
  } catch {
    el.textContent = orgUrl;
  }
}

// ── Org switcher ───────────────────────────────────────────────────────────
async function populateOrgSwitcher() {
  const SF_PATTERN = /^https:\/\/[^/]+\.(salesforce\.com|force\.com|lightning\.force\.com|my\.salesforce\.com)/;
  const tabs = await chrome.tabs.query({});
  const sfTabs = tabs.filter(t => t.url && SF_PATTERN.test(t.url));

  // Deduplicate by origin
  const seen = new Set();
  const orgs = [];
  sfTabs.forEach(t => {
    try {
      const origin = new URL(t.url).origin;
      if (!seen.has(origin)) { seen.add(origin); orgs.push(origin); }
    } catch { /* skip */ }
  });

  const select = document.getElementById('org-switcher');
  if (!select) return;

  if (orgs.length < 2) {
    select.style.display = 'none';
    return;
  }

  select.textContent = '';
  orgs.forEach(origin => {
    const opt = document.createElement('option');
    opt.value = origin;
    opt.textContent = origin.replace('https://', '').split('.')[0];
    if (origin === appOrgUrl) opt.selected = true;
    select.appendChild(opt);
  });
  select.style.display = '';

  select.addEventListener('change', async () => {
    appOrgUrl = select.value;
    await chrome.storage.session.set({ orgUrl: appOrgUrl });
    // Reset state for the new org
    lastLogs = [];
    updateOrgDisplay(appOrgUrl);
    // Clear currently displayed log
    const summarySection = document.getElementById('summary');
    if (summarySection) {
      summarySection.classList.add('empty');
      summarySection.innerHTML = `
        <div class="placeholder">
          <h2>No log selected</h2>
          <p>Select a log from the list on the left to analyse it.</p>
        </div>
      `;
    }
    // Reload logs for the new org
    loadLogList();
  });
}

// ── Log list ──────────────────────────────────────────────────────────────
let lastLogs = [];

async function loadLogList() {
  const stateEl = document.getElementById('log-list-state');
  const tableEl = document.getElementById('log-table');

  // Only auto-detect org if we don't already have one
  if (!appOrgUrl) {
    // First try: query open tabs directly — more reliable than waiting for content script
    const sfOrgPattern = /https:\/\/[^/]+(\.salesforce\.com|\.force\.com|\.lightning\.force\.com|\.my\.salesforce\.com)(\/|$)/;
    const allTabs = await chrome.tabs.query({});
    const sfTab = allTabs.find(t => t.url && sfOrgPattern.test(t.url));
    if (sfTab) {
      try {
        const origin = new URL(sfTab.url).origin;
        appOrgUrl = origin;
        await chrome.storage.session.set({ orgUrl: origin });
        updateOrgDisplay(origin);
      } catch {}
    }

    // Second try: fall back to session storage
    if (!appOrgUrl) {
      const stored = await chrome.storage.session.get('orgUrl');
      if (stored.orgUrl) {
        appOrgUrl = stored.orgUrl;
        updateOrgDisplay(stored.orgUrl);
      }
    }
  }

  if (!appOrgUrl) {
    setStateMessage(stateEl, '🔗', 'Navigate to a Salesforce org in another tab first, then click Refresh.');
    tableEl.style.display = 'none';
    return;
  }

  setStateMessage(stateEl, '⏳', 'Loading logs…');
  tableEl.style.display = 'none';

  const resp = await chrome.runtime.sendMessage({ type: 'fetchLogs', orgUrl: appOrgUrl });
  if (!resp.ok) {
    setStateMessage(stateEl, '⚠', 'Could not load logs: ' + resp.error);
    return;
  }

  lastLogs = resp.data.records || [];
  if (lastLogs.length === 0) {
    setStateMessage(stateEl, '📭', 'No debug logs found. Generate some Apex activity first.');
    return;
  }

  stateEl.style.display = 'none';
  tableEl.style.display = '';
  renderLogTable(lastLogs);
}

function setStateMessage(stateEl, icon, text) {
  stateEl.style.display = '';
  stateEl.textContent = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'log-list-placeholder';
  const iconEl = document.createElement('div');
  iconEl.className = 'placeholder-icon';
  iconEl.textContent = icon;
  const textEl = document.createElement('p');
  textEl.textContent = text;
  wrapper.appendChild(iconEl);
  wrapper.appendChild(textEl);
  stateEl.appendChild(wrapper);
}

function renderLogTable(logs) {
  const tbody = document.getElementById('log-table-body');
  tbody.textContent = '';

  // Filter by unread status if checkbox is checked
  const unreadOnly = document.getElementById('chk-unread-only').checked;
  const filteredLogs = unreadOnly ? logs.filter(log => !viewedLogIds.has(log.Id)) : logs;

  filteredLogs.forEach(log => {
    const time = log.StartTime ? new Date(log.StartTime).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : '—';
    const size = log.LogLength ? formatBytes(log.LogLength) : '—';
    const user = log.LogUser?.Name || '—';
    const op = shortenOperation(log.Operation || log.Request || '—');
    const label = op + ' — ' + time;

    const tr = document.createElement('tr');
    tr.className = 'log-row';
    tr.dataset.id = log.Id;
    tr.dataset.label = label;
    tr.title = log.Operation || '';

    // Add unread indicator
    const isUnread = !viewedLogIds.has(log.Id);
    if (isUnread) {
      tr.classList.add('log-row-unread');
    }

    const cells = [user, op, time, size];
    const cellClasses = ['log-cell-user', 'log-cell-op', 'log-cell-time', 'log-cell-size'];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.className = cellClasses[i];
      td.textContent = text;
      tr.appendChild(td);
    });

    // Delete button cell
    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'log-delete-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete log';
    delBtn.dataset.id = log.Id;
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      delBtn.textContent = '…';
      delBtn.disabled = true;
      const resp = await chrome.runtime.sendMessage({ type: 'deleteLog', orgUrl: appOrgUrl, logId: log.Id });
      if (resp.ok) {
        lastLogs = lastLogs.filter(l => l.Id !== log.Id);
        renderLogTable(lastLogs);
      } else {
        delBtn.textContent = '✕';
        delBtn.disabled = false;
      }
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);

    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('log-delete-btn')) return;
      tbody.querySelectorAll('.log-row').forEach(r => r.classList.remove('log-row-active'));
      tr.classList.add('log-row-active');
      loadLog(log.Id, label);
    });

    tbody.appendChild(tr);
  });
}

async function loadLog(logId, label) {
  const summary = document.getElementById('summary');
  summary.textContent = '';
  summary.classList.add('empty');
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  const spinner = document.createElement('div');
  spinner.className = 'loading-spinner';
  const msg = document.createElement('p');
  msg.textContent = 'Loading log…';
  ph.appendChild(spinner);
  ph.appendChild(msg);
  summary.appendChild(ph);

  const resp = await chrome.runtime.sendMessage({ type: 'fetchLogBody', orgUrl: appOrgUrl, logId });
  if (!resp.ok) {
    summary.textContent = '';
    const errPh = document.createElement('div');
    errPh.className = 'placeholder';
    const errMsg = document.createElement('p');
    errMsg.className = 'error';
    errMsg.textContent = 'Failed to load log: ' + resp.error;
    errPh.appendChild(errMsg);
    summary.appendChild(errPh);
    return;
  }

  // Mark log as viewed
  viewedLogIds.add(logId);
  chrome.storage.local.set({ viewedLogIds: Array.from(viewedLogIds) });

  renderLogSummary(resp.text, label, appOrgUrl, null);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function shortenOperation(op) {
  return op.replace(/^\/services\/data\/v[\d.]+\//, '').substring(0, 40);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
