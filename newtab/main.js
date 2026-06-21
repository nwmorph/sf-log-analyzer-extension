// Chrome extension version — no vscode API
// vscode stub: all postMessage calls are no-ops or browser equivalents
const vscode = {
  postMessage(msg) {
    if (msg.type === 'openExternal' && msg.url) {
      window.open(msg.url, '_blank', 'noopener');
    }
    // openLine, openSource, getSourceSnippet, getDescription, runCodeScan
    // are not available in the browser — silently ignored
  }
};

const summarySection = document.getElementById('summary');
let currentLogLines = [];
let currentOrgUrl = '';
let currentValidationRules = [];
let currentExecutedClasses = [];
let currentScanFindings = [];
let currentStaticFindings = null;

function renderLogSummary(text, label, orgUrl, mtime) {
  // Keep only non-empty lines so indices match the lineIndex values stored in parseLog
  currentLogLines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (orgUrl) currentOrgUrl = orgUrl;
  const result = parseLog(text);
  currentValidationRules = result.validationRules;
  currentExecutedClasses = result.executedClasses || [];
  currentScanFindings = result.scanFindings || [];
  currentStaticFindings = null; // reset on new log

  summarySection.classList.remove('empty');
  summarySection.innerHTML = `
    <div class="summary-header">
      <div>
        <h2>${label ? escapeHtml(label.split(/[\\/]/).pop()) : 'Debug log loaded'}</h2>
        <div class="header-meta">
          <span>${formatBytes(text.length)}</span>
          <span>•</span>
          <span>${result.lineCount.toLocaleString()} lines</span>
          <span>•</span>
          <span>${result.duration}</span>
          ${mtime ? `<span>•</span><span title="File last modified">📅 ${new Date(mtime).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'})}</span>` : ''}
          ${result.users.length > 0 ? `<span>•</span><span>👤 ${result.users.map(u => escapeHtml(u)).join(', ')}</span>` : ''}
        </div>
        ${(() => {
          // Show per-execution user breakdown only when users differ across transactions
          const execEntries = Object.entries(result.usersPerExec || {});
          if (execEntries.length < 2) return '';
          const allSame = execEntries.every(([,users]) => users.join() === execEntries[0][1].join());
          if (allSame) return '';
          return `<div class="header-exec-users">${execEntries.map(([exec, users]) =>
            `<span class="exec-user-chip">Tx ${exec}: ${users.map(u => escapeHtml(u)).join(', ')}</span>`
          ).join('')}</div>`;
        })()}
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Total duration</span>
        <span class="stat-value">${result.totalDurationMs ? result.totalDurationMs + ' ms' : '—'}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Code units</span>
        <span class="stat-value">${result.codeUnitStarted}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Methods</span>
        <span class="stat-value">${result.methodEntry}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Errors / Exceptions</span>
        <span class="stat-value error">${result.errors}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">User debug logs</span>
        <span class="stat-value">${result.userDebug}</span>
      </div>
    </div>

    <div class="tab-bar">
      <button class="tab-btn active" data-tab="timeline">Timeline</button>
      <button class="tab-btn" data-tab="scan">Code Scan ${result.scanFindings.filter(f => f.severity === 'critical').length > 0 ? `<span class="tab-badge tab-badge-critical">${result.scanFindings.filter(f => f.severity === 'critical').length}</span>` : result.scanFindings.length > 0 ? `<span class="tab-badge">${result.scanFindings.length}</span>` : ''}</button>
      <button class="tab-btn" data-tab="report">Report</button>
    </div>

    <div class="tab-panel active" id="tab-timeline">
      ${collapsible('Execution Timeline', renderTimeline(result.events, result.flowNames), true)}
      ${collapsible('What happened', renderNarrative(result), false)}
      ${collapsible('Governor Limits', renderGovernorLimits(result.limitData), false)}
      ${collapsible('Validation Rules', renderValidationRules(result.validationRules), false)}
      <div id="categoryDetails"></div>
    </div>

    <div class="tab-panel" id="tab-scan">
      ${renderCodeScan(result)}
    </div>

    <div class="tab-panel" id="tab-report">
      ${renderReport(result)}
    </div>

    <div id="span-tooltip" class="span-tooltip" style="display:none;"></div>
  `;

  // attach interaction handlers after content is rendered
  attachInteractionHandlers();
}

function parseNanos(line) {
  // Format: "HH:MM:SS.d (123456789)|..." — parenthetical is nanoseconds since tx start
  const m = line.match(/^\d{2}:\d{2}:\d{2}\.\d+ \((\d+)\)/);
  return m ? parseInt(m[1]) : null;
}

function parseLog(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const categories = {};
  const events = [];
  const usersSet = new Set();
  const usersPerExec = {}; // execCount -> Set of emails
  const soqlObjects = new Set();
  const dmlOps = [];
  const topCodeUnits = [];
  const limitData = {};
  const limitDataPerExec = {}; // keyed by execCount at time of LIMIT_USAGE block
  const validationRules = [];
  const flowNames = {};
  // Ordered execution steps for the chronological narrative
  // Each entry: { type, name, nanos, lineIndex, extra? }
  const execSteps = [];
  // Code scan: method call stack and per-frame counters for loop detection
  const methodStack = [];          // [{sig, lineNo}]
  const soqlPerFrame = {};         // "sig:lineNo" -> [{ query, srcLine, lineIndex }]
  const dmlPerFrame  = {};         // "sig:lineNo" -> [{ op, type, lineIndex }]
  const scanFindings = [];         // runtime issues found
  const executedClasses = new Set(); // Apex class names that ran
  let pendingValidation = null;
  let pendingFormulaLines = [];
  let currentValidationObject = null;
  let inLimitBlock = false;
  let debugLevels = {};
  let execCount = 0;

  let firstTime = null;
  let lastTime = null;
  let firstTimeMs = null;
  let lastTimeMs = null;
  let requestStart = null;

  const counts = {
    lineCount: lines.length,
    userDebug: 0,
    soqlBegin: 0,
    dmlBegin: 0,
    errors: 0,
    codeUnitStarted: 0,
    methodEntry: 0
  };

  // First line may be a debug level header: "67.0 APEX_CODE,FINEST;DB,FINEST;..."
  if (lines.length > 0 && /^\d+\.\d+\s+\w+,/.test(lines[0])) {
    const levelStr = lines[0].replace(/^\d+\.\d+\s+/, '');
    levelStr.split(';').forEach(part => {
      const sepIdx = part.lastIndexOf(',');
      if (sepIdx > -1) {
        const cat = part.substring(0, sepIdx).trim();
        const lvl = part.substring(sepIdx + 1).trim();
        if (cat && lvl) debugLevels[cat] = lvl;
      }
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timeMatch = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d)/);
    const parts = line.split('|');
    const category = parts.length >= 2 ? parts[1].trim() : null;

    // Governor limit block tracking
    if (category === 'LIMIT_USAGE_FOR_NS') { inLimitBlock = true; continue; }
    if (category === 'CUMULATIVE_LIMIT_USAGE_END') { inLimitBlock = false; continue; }
    if (inLimitBlock && !timeMatch) {
      const limitMatch = line.match(/^\s+(.+?):\s*(\d+)\s+out of\s+(\d+)/);
      if (limitMatch) {
        const entry = { used: parseInt(limitMatch[2]), max: parseInt(limitMatch[3]) };
        limitData[limitMatch[1].trim()] = entry;
        if (!limitDataPerExec[execCount]) limitDataPerExec[execCount] = {};
        limitDataPerExec[execCount][limitMatch[1].trim()] = entry;
      }
      continue;
    }

    // Running user(s) — format: USER_INFO|[EXTERNAL]|userId|email|...
    if (category === 'USER_INFO' && parts.length >= 5) {
      const email = parts[4].trim();
      if (email && email.includes('@')) {
        usersSet.add(email);
        if (!usersPerExec[execCount]) usersPerExec[execCount] = new Set();
        usersPerExec[execCount].add(email);
      }
    }

    if (category === 'EXECUTION_STARTED') execCount++;
    if (category === 'EXECUTION_STARTED' && !requestStart && timeMatch) {
      requestStart = `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`;
    }

    // Flow interview name resolution
    if (category === 'FLOW_START_INTERVIEW_BEGIN' && parts.length >= 4) {
      const flowLabel = parts[3].trim();
      flowNames[parts[2].trim()] = flowLabel;
      const nanos = parseNanos(line);
      execSteps.push({ type: 'flow', name: flowLabel, nanos, lineIndex: i, exec: execCount });
    }

    // Validation rule tracking — formula may span multiple lines
    if (category === 'CODE_UNIT_STARTED') {
      const name = extractSpanName(line, 'CODE_UNIT_STARTED');
      if (name && /^Validation:/i.test(name)) currentValidationObject = name.split(':')[1] || null;
    }
    // Continuation lines for VALIDATION_FORMULA have no HH:MM:SS prefix
    if (pendingValidation && pendingValidation.collectingFormula && !timeMatch && !inLimitBlock) {
      pendingFormulaLines.push(line.trim());
      continue;
    }
    if (category === 'VALIDATION_RULE') {
      if (pendingValidation) {
        pendingValidation.formula = pendingFormulaLines.join('\n');
        validationRules.push(pendingValidation);
      }
      pendingValidation = { id: parts[2] || '', name: parts[3] || parts[2] || '?', object: currentValidationObject, formula: null, result: null, lineIndex: i, collectingFormula: false };
      pendingFormulaLines = [];
    }
    if (category === 'VALIDATION_FORMULA' && pendingValidation) {
      pendingFormulaLines = [parts.slice(2).join('|').trim()];
      pendingValidation.collectingFormula = true;
    }
    if ((category === 'VALIDATION_PASS' || category === 'VALIDATION_FAIL') && pendingValidation) {
      pendingValidation.formula = pendingFormulaLines.join('\n');
      pendingValidation.result = category === 'VALIDATION_PASS' ? 'pass' : 'fail';
      pendingValidation.collectingFormula = false;
      if (category === 'VALIDATION_FAIL') pendingValidation.errorMessage = parts.slice(2).join('|').trim();
      validationRules.push(pendingValidation);
      pendingValidation = null;
      pendingFormulaLines = [];
    }

    if (timeMatch) {
      const h = parseInt(timeMatch[1]);
      const m = parseInt(timeMatch[2]);
      const s = parseInt(timeMatch[3]);
      const ms = parseInt(timeMatch[4]) * 100;
      const totalMs = h * 3600000 + m * 60000 + s * 1000 + ms;
      const timeStr = `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`;

      if (!firstTime) { firstTime = timeStr; firstTimeMs = totalMs; }
      lastTime = timeStr;
      lastTimeMs = totalMs;

      if (category) {
        const isCodeUnit = category.includes('CODE_UNIT');
        const isMethod = category.includes('METHOD_ENTRY') || category.includes('METHOD_EXIT');
        const isUserDebug = category.includes('USER_DEBUG');
        const isError = category.includes('FATAL_ERROR') || category.includes('EXCEPTION_THROWN');
        const isSoql = category.includes('SOQL');
        const isDml = category.includes('DML');

        if (isCodeUnit || isMethod || isUserDebug || isError || isSoql || isDml) {
          const nanos = parseNanos(line);
          events.push({ time: timeStr, category, line, lineIndex: i, timeMs: totalMs, nanos });
        }

        // Narrative data
        if (category === 'CODE_UNIT_STARTED') {
          const name = extractSpanName(line, 'CODE_UNIT_STARTED');
          if (name) topCodeUnits.push(name);
          // Collect ordered steps — skip pure system wrappers
          if (name && !/^TRIGGERS$/i.test(name)) {
            const nanos = parseNanos(line);
            let stepType = 'code-unit';
            if (/before\s*(insert|update|delete)/i.test(name)) stepType = 'before-trigger';
            else if (/after\s*(insert|update|delete)/i.test(name)) stepType = 'after-trigger';
            else if (/^Validation:/i.test(name)) stepType = 'validation';
            else if (/^Flow:/i.test(name)) stepType = 'flow';
            else if (/^ApexDataSource:/i.test(name)) stepType = 'datasource';
            execSteps.push({ type: stepType, name, nanos, lineIndex: i, exec: execCount });
          }
        }
        if (category === 'SOQL_EXECUTE_BEGIN') {
          const raw = parts.slice(3).join('|');
          const fromMatch = raw.match(/FROM\s+(\w+)/i);
          if (fromMatch) soqlObjects.add(fromMatch[1]);
          // Scan: track SOQL per active frame
          const srcLine = parts[2]?.trim() || '';
          const query = raw.replace(/^[^|]*\|/, '').trim();
          const frameKey = methodStack.length > 0
            ? `${methodStack[methodStack.length - 1].sig}__${execCount}`
            : `__root__${execCount}`;
          if (!soqlPerFrame[frameKey]) soqlPerFrame[frameKey] = [];
          soqlPerFrame[frameKey].push({ query, srcLine, lineIndex: i, object: fromMatch ? fromMatch[1] : null });
        }
        if (category === 'DML_BEGIN') {
          const raw = parts.slice(3).join('|');
          const opMatch = raw.match(/Op:(\w+)/);
          const typeMatch = raw.match(/Type:(\w+)/);
          const rowsMatch = raw.match(/Rows:(\d+)/);
          if (opMatch && typeMatch) {
            dmlOps.push({ op: opMatch[1], type: typeMatch[1], rows: rowsMatch ? parseInt(rowsMatch[1]) : null });
            const nanos = parseNanos(line);
            execSteps.push({ type: 'dml', name: `${opMatch[1]} ${typeMatch[1]}`, nanos, lineIndex: i, rows: rowsMatch ? parseInt(rowsMatch[1]) : null, exec: execCount });
            // Scan: track DML per active frame
            const frameKey = methodStack.length > 0
              ? `${methodStack[methodStack.length - 1].sig}__${execCount}`
              : `__root__${execCount}`;
            if (!dmlPerFrame[frameKey]) dmlPerFrame[frameKey] = [];
            dmlPerFrame[frameKey].push({ op: opMatch[1], type: typeMatch[1], lineIndex: i });
          }
        }
        // Scan: maintain method call stack + collect executed class names
        if (category === 'METHOD_ENTRY') {
          const sig = parts[4]?.trim() || parts[3]?.trim() || '';
          const lineNo = parts[2]?.trim() || '';
          methodStack.push({ sig, lineNo });
          // Extract class name from sig e.g. "MyClass.myMethod()"
          const classMatch = sig.match(/^([A-Z]\w*)\./);
          if (classMatch && !isSystemClass(classMatch[1])) {
            executedClasses.add(classMatch[1]);
          }
        }
        if (category === 'METHOD_EXIT') {
          if (methodStack.length > 0) methodStack.pop();
        }
      }
    }

    if (category) categories[category] = (categories[category] || 0) + 1;

    if (line.includes('USER_DEBUG')) counts.userDebug += 1;
    if (line.includes('SOQL_EXECUTE_BEGIN')) counts.soqlBegin += 1;
    if (line.includes('DML_BEGIN')) counts.dmlBegin += 1;
    if (line.includes('CODE_UNIT_STARTED')) counts.codeUnitStarted += 1;
    if (line.includes('METHOD_ENTRY')) counts.methodEntry += 1;
    if (line.includes('FATAL_ERROR') || line.includes('EXCEPTION_THROWN')) counts.errors += 1;
  }

  // Flush any dangling validation rule without a PASS/FAIL
  if (pendingValidation) {
    pendingValidation.formula = pendingFormulaLines.join('\n');
    validationRules.push(pendingValidation);
  }

  const totalDurationMs = firstTimeMs && lastTimeMs ? lastTimeMs - firstTimeMs : null;

  // ── Runtime code scan analysis ─────────────────────────────────────────────
  // SOQL in loops: same frame fired SOQL 3+ times (heuristic for loop)
  for (const [frameKey, queries] of Object.entries(soqlPerFrame)) {
    if (queries.length < 3) continue;
    // Group by query signature (object + src line bracket)
    const bySignature = {};
    for (const q of queries) {
      const sig = `${q.object || '?'}|${q.srcLine}`;
      if (!bySignature[sig]) bySignature[sig] = [];
      bySignature[sig].push(q);
    }
    for (const [sig, hits] of Object.entries(bySignature)) {
      if (hits.length < 3) continue;
      const [obj, srcLine] = sig.split('|');
      const frameParts = frameKey.split('__');
      const method = frameParts[0] === '__root' ? null : frameParts[0];
      scanFindings.push({
        severity: 'critical',
        rule: 'SOQL in Loop',
        message: `SELECT from ${obj} executed ${hits.length}× from the same call frame${method ? ` (${method.split('.').pop()})` : ''} — likely inside a loop`,
        detail: `Query at line ${srcLine} ran ${hits.length} times. Move this query outside the loop and use a Map or collection to process results.`,
        lineIndex: hits[0].lineIndex,
        category: 'performance',
      });
    }
  }

  // DML in loops: same frame fired DML 3+ times
  for (const [frameKey, ops] of Object.entries(dmlPerFrame)) {
    if (ops.length < 3) continue;
    const byType = {};
    for (const op of ops) {
      const key = `${op.op} ${op.type}`;
      if (!byType[key]) byType[key] = [];
      byType[key].push(op);
    }
    for (const [key, hits] of Object.entries(byType)) {
      if (hits.length < 3) continue;
      const frameParts = frameKey.split('__');
      const method = frameParts[0] === '__root' ? null : frameParts[0];
      scanFindings.push({
        severity: 'critical',
        rule: 'DML in Loop',
        message: `${key} executed ${hits.length}× from the same call frame${method ? ` (${method.split('.').pop()})` : ''} — likely inside a loop`,
        detail: `Repeated DML hits governor limits quickly. Collect records in a List and perform a single bulkified DML statement outside the loop.`,
        lineIndex: hits[0].lineIndex,
        category: 'performance',
      });
    }
  }

  // Governor limit proximity
  const SCAN_LIMITS = [
    { key: 'Number of SOQL queries',   label: 'SOQL queries',   max: 100 },
    { key: 'Number of DML statements', label: 'DML statements', max: 150 },
    { key: 'Maximum CPU time',         label: 'CPU time',       max: 10000 },
    { key: 'Number of DML rows',       label: 'DML rows',       max: 10000 },
    { key: 'Number of callouts',       label: 'Callouts',       max: 100 },
    { key: 'Maximum heap size',        label: 'Heap size',      max: 6000000 },
    { key: 'Number of future calls',   label: 'Future calls',   max: 50 },
  ];
  for (const lk of SCAN_LIMITS) {
    const entry = limitData[lk.key];
    if (!entry) continue;
    const max = entry.max || lk.max;
    const pct = Math.round(entry.used / max * 100);
    if (pct >= 90) {
      scanFindings.push({
        severity: 'critical',
        rule: 'Governor Limit Critical',
        message: `${lk.label} at ${pct}% of limit (${entry.used.toLocaleString()} / ${max.toLocaleString()})`,
        detail: `At this rate, a slightly larger dataset or additional trigger will cause a LimitException. Immediate refactoring required.`,
        lineIndex: null,
        category: 'limits',
      });
    } else if (pct >= 70) {
      scanFindings.push({
        severity: 'warning',
        rule: 'Governor Limit Warning',
        message: `${lk.label} at ${pct}% of limit`,
        detail: `Getting close to the limit. Monitor this carefully in bulk operations with larger data volumes.`,
        lineIndex: null,
        category: 'limits',
      });
    }
  }

  // Validation failures
  for (const rule of validationRules.filter(r => r.result === 'fail')) {
    scanFindings.push({
      severity: 'critical',
      rule: 'Validation Rule Failed',
      message: `Validation rule "${rule.name || rule.id}" failed on ${rule.object || 'unknown object'}`,
      detail: rule.errorMessage || 'No error message captured.',
      lineIndex: rule.lineIndex,
      category: 'validation',
    });
  }

  // Recursive triggers — group by trigger+object ignoring event type (before/after/event)
  const triggerSeen = {};
  for (const s of execSteps) {
    if (s.type !== 'before-trigger' && s.type !== 'after-trigger') continue;
    // Normalise: extract just "TriggerName on ObjectName"
    const m = s.name.match(/^(\S+)\s+on\s+(\S+)/i);
    const key = m ? `${m[1]} on ${m[2]}` : s.name;
    if (!triggerSeen[key]) triggerSeen[key] = { count: 0, events: new Set() };
    triggerSeen[key].count++;
    // Track which events fired (BeforeUpdate, AfterInsert, etc.)
    const evMatch = s.name.match(/trigger\s+event\s+(\S+)/i);
    if (evMatch) triggerSeen[key].events.add(evMatch[1]);
  }
  for (const [key, { count, events }] of Object.entries(triggerSeen)) {
    if (count > 1) {
      const evList = [...events].join(', ');
      scanFindings.push({
        severity: 'warning',
        rule: 'Recursive Trigger',
        message: `${key} fired ${count}× (${evList}) — possible unguarded recursion`,
        detail: `Use a static Boolean flag (e.g. TriggerHandler.hasRun) to prevent a trigger from re-entering itself during DML performed within the same transaction.`,
        lineIndex: null,
        category: 'design',
      });
    }
  }

  // Errors / exceptions
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts2 = line.split('|');
    const cat2 = parts2[1]?.trim();
    if (cat2 === 'FATAL_ERROR' || cat2 === 'EXCEPTION_THROWN') {
      const msg = parts2.slice(2).join('|').trim();
      scanFindings.push({
        severity: 'critical',
        rule: cat2 === 'FATAL_ERROR' ? 'Fatal Error' : 'Exception Thrown',
        message: msg.substring(0, 200),
        detail: null,
        lineIndex: i,
        category: 'error',
      });
    }
  }

  // High SOQL count with no bulkification signal
  if (counts.soqlBegin > 50) {
    scanFindings.push({
      severity: 'warning',
      rule: 'High SOQL Count',
      message: `${counts.soqlBegin} SOQL queries executed in this transaction`,
      detail: `Consider caching query results, using aggregate queries, or consolidating queries using IN clauses with Id sets.`,
      lineIndex: null,
      category: 'performance',
    });
  }

  // Large result sets
  for (const op of dmlOps) {
    if (op.rows && op.rows > 1000) {
      scanFindings.push({
        severity: 'warning',
        rule: 'Large Result Set',
        message: `${op.op} ${op.type} affected ${op.rows.toLocaleString()} rows`,
        detail: `Processing very large record sets in Apex can exhaust heap and CPU limits. Consider chunking via batch Apex if this is a recurring pattern.`,
        lineIndex: null,
        category: 'performance',
      });
    }
  }

  // Multiple transactions in one log
  if (execCount > 2) {
    scanFindings.push({
      severity: 'info',
      rule: 'Multiple Transactions',
      message: `${execCount} separate transactions captured in this log`,
      detail: `This may indicate @future methods, queueables, or platform events firing in response to the initial save. Verify each transaction is intentional.`,
      lineIndex: null,
      category: 'design',
    });
  }

  return {
    lineCount: counts.lineCount,
    userDebug: counts.userDebug,
    soqlBegin: counts.soqlBegin,
    dmlBegin: counts.dmlBegin,
    errors: counts.errors,
    codeUnitStarted: counts.codeUnitStarted,
    methodEntry: counts.methodEntry,
    categories,
    events,
    duration: firstTime && lastTime ? `${firstTime} → ${lastTime}` : 'Duration unavailable',
    requestStart,
    totalDurationMs,
    users: [...usersSet],
    usersPerExec: Object.fromEntries(Object.entries(usersPerExec).map(([k,v]) => [k, [...v]])),
    execCount,
    soqlObjects: [...soqlObjects],
    dmlOps,
    topCodeUnits,
    limitData,
    limitDataPerExec,
    validationRules,
    debugLevels,
    flowNames,
    execSteps,
    scanFindings,
    executedClasses: [...executedClasses],
  };
}

function getCategoryDescription(category) {
  const descriptions = {
    'CODE_UNIT_STARTED':   'Code unit',
    'METHOD_ENTRY':        'Apex method',
    'SYSTEM_METHOD_ENTRY': 'System method',
    'SOQL_EXECUTE_BEGIN':  'SOQL query',
    'DML_BEGIN':           'DML operation',
    'FATAL_ERROR':         'Fatal error',
    'EXCEPTION_THROWN':    'Exception',
  };
  return descriptions[category] || category.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
}

function getTypeLabel(category) {
  const labels = {
    'CODE_UNIT_STARTED':   'Code Unit',
    'METHOD_ENTRY':        'Apex Method',
    'SYSTEM_METHOD_ENTRY': 'System Method',
    'SOQL_EXECUTE_BEGIN':  'SOQL Query',
    'DML_BEGIN':           'DML Operation',
    'FATAL_ERROR':         'Fatal Error',
    'EXCEPTION_THROWN':    'Exception',
  };
  return labels[category] || getCategoryDescription(category);
}

const COLOR_BY_CAT = {
  'CODE_UNIT_STARTED':   '#3ca0c8',
  'METHOD_ENTRY':        '#4a9eff',
  'SYSTEM_METHOD_ENTRY': '#4ecdc4',
  'SOQL_EXECUTE_BEGIN':  '#2eb87e',
  'DML_BEGIN':           '#aa96da',
  'FATAL_ERROR':         '#d94545',
  'EXCEPTION_THROWN':    '#d94545',
};

function colorFor(cat) {
  if (COLOR_BY_CAT[cat]) return COLOR_BY_CAT[cat];
  if (cat.includes('FATAL_ERROR') || cat.includes('EXCEPTION_THROWN')) return '#d94545';
  return '#ffa500';
}

// Extract a human-readable name from the detail field of a log line.
// e.g. "11:42:25.0 (1234)|CODE_UNIT_STARTED|[EXTERNAL]|MyTrigger on Account trigger event BeforeInsert"
//   => "MyTrigger on Account"
// e.g. "...|SOQL_EXECUTE_BEGIN|[23]|Aggregations:0|SELECT Id FROM Account"
//   => "SELECT Id FROM Account"
function extractSpanName(line, category) {
  const parts = line.split('|');
  // parts[0]=timestamp, parts[1]=category, parts[2]=line ref, parts[3..]=detail
  if (parts.length < 3) return null;

  if (category === 'CODE_UNIT_STARTED') {
    // Format A: |[EXTERNAL]|Name
    // Format B: |[EXTERNAL]|SfId15|Name|optionalPath  (e.g. triggers with an apex class ID)
    const p3 = parts[3] ? parts[3].trim() : '';
    const isSfId = /^[a-zA-Z0-9]{15,18}$/.test(p3);
    const name = isSfId ? (parts[4] ? parts[4].trim() : p3) : p3;
    return name || null;
  }
  if (category === 'METHOD_ENTRY' || category === 'METHOD_EXIT') {
    // Format: timestamp|METHOD_ENTRY|[lineno]|SfId15|ClassName.method()
    // Name is parts[4]; parts[3] is a 15-char Salesforce ID
    return parts.length > 4 ? parts[4].trim() : (parts.length > 3 ? parts[3].trim() : null);
  }
  if (category === 'SYSTEM_METHOD_ENTRY' || category === 'SYSTEM_METHOD_EXIT') {
    // Format: timestamp|SYSTEM_METHOD_ENTRY|[lineno]|ClassName.method()
    return parts.length > 3 ? parts[3].trim() : null;
  }
  if (category === 'SOQL_EXECUTE_BEGIN') {
    // "Aggregations:N|SELECT ..." -> grab the SELECT part
    const raw = parts.slice(3).join('|');
    const soqlMatch = raw.match(/SELECT\s.+/i);
    return soqlMatch ? soqlMatch[0] : (raw.trim() || null);
  }
  if (category === 'DML_BEGIN') {
    // "Op:Insert|Type:Account|Rows:1"
    const raw = parts.slice(3).join('|');
    const opMatch = raw.match(/Op:(\w+)/);
    const typeMatch = raw.match(/Type:(\w+)/);
    if (opMatch && typeMatch) return `${opMatch[1]} ${typeMatch[1]}`;
    return raw.trim() || null;
  }
  if (category.includes('FATAL_ERROR') || category.includes('EXCEPTION_THROWN')) {
    return parts.slice(3).join('|').trim().substring(0, 80) || null;
  }
  return null;
}

function buildTimelineSpans(events) {
  if (events.length === 0) return [];

  const firstNanos = events.find(e => e.nanos !== null)?.nanos ?? null;
  const useNanos = firstNanos !== null;
  const evTime = (ev) => useNanos && ev.nanos !== null
    ? (ev.nanos - firstNanos) / 1e6
    : ev.timeMs;

  const END_FOR = {
    'CODE_UNIT_STARTED':   'CODE_UNIT_FINISHED',
    'METHOD_ENTRY':        'METHOD_EXIT',
    'SYSTEM_METHOD_ENTRY': 'SYSTEM_METHOD_EXIT',
    'SOQL_EXECUTE_BEGIN':  'SOQL_EXECUTE_END',
    'DML_BEGIN':           'DML_END',
  };
  const START_CATS = new Set(Object.keys(END_FOR));

  const stacks = {};
  const spans = [];

  for (const ev of events) {
    const t = evTime(ev);

    if (START_CATS.has(ev.category)) {
      if (!stacks[ev.category]) stacks[ev.category] = [];
      const name = extractSpanName(ev.line, ev.category);
      // Stamp phase from original name before any later resolution
      const phase = ev.category === 'CODE_UNIT_STARTED' ? classifyCodeUnitName(name) : null;
      stacks[ev.category].push({ ev, t, name, phase });
      continue;
    }

    let matchingStartCat = null;
    for (const [startCat, endCat] of Object.entries(END_FOR)) {
      if (endCat === ev.category) { matchingStartCat = startCat; break; }
    }

    if (matchingStartCat && stacks[matchingStartCat] && stacks[matchingStartCat].length > 0) {
      const open = stacks[matchingStartCat].pop();
      // For SOQL, extract row count from the END line
      let rowCount = null;
      if (matchingStartCat === 'SOQL_EXECUTE_BEGIN') {
        const rowMatch = ev.line.match(/Rows:(\d+)/);
        if (rowMatch) rowCount = parseInt(rowMatch[1]);
      }
      spans.push({
        category: matchingStartCat,
        name: open.name,
        phase: open.phase,
        startMs: open.t,
        endMs: t,
        startLineIndex: open.ev.lineIndex,
        endLineIndex: ev.lineIndex,
        rowCount,
      });
    }
  }

  const maxT = evTime(events[events.length - 1]);
  for (const [cat, stack] of Object.entries(stacks)) {
    for (const open of stack) {
      spans.push({
        category: cat,
        name: open.name,
        phase: open.phase,
        startMs: open.t,
        endMs: maxT,
        startLineIndex: open.ev.lineIndex,
        endLineIndex: events[events.length - 1].lineIndex,
        rowCount: null,
      });
    }
  }

  return spans.sort((a, b) => a.startMs - b.startMs);
}

// Assigns spans to rows so they don't overlap visually (greedy interval packing)
function packRows(spans) {
  const rows = []; // each row: array of spans, sorted by startMs
  for (const span of spans) {
    let placed = false;
    for (const row of rows) {
      const last = row[row.length - 1];
      if (last.endMs <= span.startMs) {
        row.push(span);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([span]);
  }
  return rows;
}

function collapsible(title, content, expanded) {
  const id = 'section-' + title.toLowerCase().replace(/\s+/g, '-');
  return `
    <div class="collapsible-panel${expanded ? ' open' : ''}">
      <button class="collapsible-header" aria-expanded="${expanded}" aria-controls="${id}">
        <span class="collapsible-title">${escapeHtml(title)}</span>
        <span class="collapsible-chevron">▾</span>
      </button>
      <div class="collapsible-body" id="${id}">${content}</div>
    </div>`;
}

// Phase classification for the overview row.
// Spans have a pre-computed `phase` property set during buildTimelineSpans; use it when present.
function classifyPhase(span) {
  if (span.phase) return span.phase;
  const name = (span.name || '').toLowerCase();
  const cat = span.category;
  if (cat === 'SOQL_EXECUTE_BEGIN') return 'soql';
  if (cat === 'DML_BEGIN') return 'dml';
  if (cat === 'CODE_UNIT_STARTED') {
    if (/before\s*(insert|update|delete)/i.test(name)) return 'before-trigger';
    if (/after\s*(insert|update|delete)/i.test(name)) return 'after-trigger';
    if (/^validation:/i.test(name)) return 'validation';
    if (/^flow:|^flow$/i.test(name)) return 'flow';
    if (/trigger/i.test(name)) return 'trigger';
    if (/^apexdatasource:/i.test(name)) return 'datasource';
    if (/^workflow:/i.test(name)) return 'workflow';
  }
  if (cat === 'METHOD_ENTRY') return 'method';
  if (cat === 'SYSTEM_METHOD_ENTRY') return 'system-method';
  return 'other';
}

// Classify a CODE_UNIT_STARTED by its *original* raw name before any resolution
function classifyCodeUnitName(rawName) {
  if (!rawName) return 'other';
  const n = rawName.toLowerCase();
  if (/before\s*(insert|update|delete)/i.test(n)) return 'before-trigger';
  if (/after\s*(insert|update|delete)/i.test(n)) return 'after-trigger';
  if (/^validation:/i.test(n)) return 'validation';
  if (/^flow:/i.test(n) || n === 'flow') return 'flow';
  if (/trigger/i.test(n)) return 'trigger';
  if (/^apexdatasource:/i.test(n)) return 'datasource';
  if (/^workflow:/i.test(n)) return 'workflow';
  return 'other';
}

// Darker shades for light mode (same hue, lower lightness for readability)
const PHASE_COLORS_DARK  = { 'before-trigger':'#3ca0c8','after-trigger':'#e07b39','validation':'#c8960a','flow':'#9b7fe8','trigger':'#4a9eff','soql':'#2eb87e','dml':'#8878c8','datasource':'#5ca0c8','method':'#4a9eff','system-method':'#4ecdc4','workflow':'#c8a050','other':'#888' };
const PHASE_COLORS_LIGHT = { 'before-trigger':'#0077aa','after-trigger':'#c05a1a','validation':'#8a6200','flow':'#6040c0','trigger':'#0057cc','soql':'#006e44','dml':'#5040a0','datasource':'#004f88','method':'#0057cc','system-method':'#007a72','workflow':'#7a5a00','other':'#555' };

function phaseColor(type) {
  const isLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  return (isLight ? PHASE_COLORS_LIGHT : PHASE_COLORS_DARK)[type] || '#888';
}

const PHASE_META = {
  'before-trigger': { label: 'Before Trigger',  get color() { return phaseColor('before-trigger'); }, show: true },
  'after-trigger':  { label: 'After Trigger',   get color() { return phaseColor('after-trigger');  }, show: true },
  'validation':     { label: 'Validation',       get color() { return phaseColor('validation');     }, show: true },
  'flow':           { label: 'Flow',             get color() { return phaseColor('flow');           }, show: true },
  'trigger':        { label: 'Trigger',          get color() { return phaseColor('trigger');        }, show: true },
  'soql':           { label: 'SOQL',             get color() { return phaseColor('soql');           }, show: true },
  'dml':            { label: 'DML',              get color() { return phaseColor('dml');            }, show: true },
  'datasource':     { label: 'Data Source',      get color() { return phaseColor('datasource');     }, show: true },
  'method':         { label: 'Apex Method',      get color() { return phaseColor('method');         }, show: true },
  'system-method':  { label: 'System Method',    get color() { return phaseColor('system-method');  }, show: true },
  'workflow':       { label: 'Workflow',         get color() { return phaseColor('workflow');        }, show: false },
  'other':          { label: 'Other',            get color() { return phaseColor('other');           }, show: true  },
};

function buildOverviewPhases(spans) {
  if (spans.length === 0) return [];
  const phases = [];
  let cur = null;
  for (const span of spans) {
    const rawType = classifyPhase(span);
    // Map uninteresting types to a muted 'other' filler so no blank gaps appear
    const type = PHASE_META[rawType]?.show ? rawType : 'other';
    const meta = PHASE_META[type];
    if (cur && cur.type === type && span.startMs - cur.endMs < 5) {
      cur.endMs = Math.max(cur.endMs, span.endMs);
      cur.count++;
      cur.spans.push(span);
    } else {
      if (cur) phases.push(cur);
      cur = { type, label: meta.label, color: meta.color,
              startMs: span.startMs, endMs: span.endMs, count: 1, spans: [span] };
    }
  }
  if (cur) phases.push(cur);
  return phases;
}

function renderTimelineGantt(spans, timelineStart, totalMs) {
  const rows = packRows(spans);
  const ROW_H = 26;
  const TOTAL_H = Math.max(ROW_H, rows.length * ROW_H);

  const segs = rows.flatMap((row, rowIdx) =>
    row.map(span => {
      const leftPct  = ((span.startMs - timelineStart) / totalMs) * 100;
      const widthPct = Math.max(0.5, ((span.endMs - span.startMs) / totalMs) * 100);
      const dur = Math.round(span.endMs - span.startMs);
      const phase = classifyPhase(span);
      const color = PHASE_META[phase]?.color || colorFor(span.category);
      const label = span.name || getCategoryDescription(span.category);
      const top = rowIdx * ROW_H;
      return `<div class="timeline-segment tl-cat-${phase}"
             style="position:absolute;left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%;
                    top:${top}px;height:${ROW_H - 3}px;background:${color};border-radius:3px;"
             data-line-index="${span.startLineIndex}"
             data-end-line-index="${span.endLineIndex}"
             data-label="${escapeHtml(label)}"
             data-type="${escapeHtml(getTypeLabel(span.category))}"
             data-dur="${dur}"
             data-start="${span.startMs.toFixed(1)}"
             data-rows="${span.rowCount !== null && span.rowCount !== undefined ? span.rowCount : ''}">
          <span class="segment-label">${escapeHtml(label)}</span>
        </div>`;
    })
  ).join('');

  return `<div class="timeline-bar-row gantt-row" style="height:${TOTAL_H}px;position:relative;">${segs}</div>`;
}

function renderPointStrip(pointEvents, timelineStart, totalMs, firstNanosRef) {
  if (pointEvents.length === 0) return '';

  const markers = pointEvents.map(ev => {
    const t = firstNanosRef !== null && ev.nanos !== null
      ? (ev.nanos - firstNanosRef) / 1e6
      : ev.timeMs;
    // Clamp to timeline range
    const leftPct = Math.max(0, Math.min(100, ((t - timelineStart) / totalMs) * 100));
    const isError = ev.category === 'FATAL_ERROR' || ev.category === 'EXCEPTION_THROWN';
    const isDebug = ev.category === 'USER_DEBUG';
    const color = isError ? '#d94545' : '#888';
    const icon  = isError ? '✕' : '·';
    const parts = ev.line.split('|');
    const msg   = parts.slice(3).join('|').trim().substring(0, 120);
    const label = isError ? (msg || ev.category) : 'Debug';
    return `<div class="tl-point-marker ${isError ? 'tl-cat-errors tl-point-error' : 'tl-cat-debug tl-point-debug'}"
         style="position:absolute;left:${leftPct.toFixed(3)}%;top:0;bottom:0;"
         data-line-index="${ev.lineIndex}"
         data-label="${escapeHtml(label)}"
         data-type="${isError ? 'Error / Exception' : 'Debug'}"
         data-dur="0"
         data-start="${(t - timelineStart).toFixed(1)}"
         data-rows="">
      <span class="tl-point-dot" style="background:${color};">${icon}</span>
    </div>`;
  }).join('');

  return `<div class="tl-point-strip" style="position:relative;height:20px;">${markers}</div>`;
}

function resolveFlowSpanName(name, flowNames) {
  if (!flowNames || !name) return name;
  const apiPart = name.replace(/^Flow:/i, '').trim();
  // Exact match on SF API name
  const allLabels = Object.values(flowNames);
  // If api part is a 15-18 char SF ID, just return all labels joined (usually one per code unit)
  if (/^[a-zA-Z0-9]{15,18}$/.test(apiPart)) {
    // Return a join of all flow labels that aren't already accounted for
    return allLabels.length > 0 ? allLabels.join(', ') : name;
  }
  // API name like "Opportunity" — find labels that reference it
  const match = allLabels.find(l =>
    l.toLowerCase().startsWith(apiPart.toLowerCase() + ':') ||
    l.toLowerCase().startsWith(apiPart.toLowerCase() + ' ')
  );
  return match || (apiPart !== 'Flow' ? apiPart : name);
}

function renderTimeline(events, flowNames) {
  if (events.length === 0) {
    return '<p class="muted">No execution events found.</p>';
  }

  // Separate point events (errors, exceptions, debug) from span events
  const POINT_CATS = new Set(['FATAL_ERROR', 'EXCEPTION_THROWN', 'USER_DEBUG']);
  const pointEvents = events.filter(e => POINT_CATS.has(e.category));
  const spanEvents  = events.filter(e => !POINT_CATS.has(e.category));

  let spans = buildTimelineSpans(spanEvents);
  if (spans.length === 0 && pointEvents.length === 0) {
    return '<p class="muted">No paired execution spans found.</p>';
  }

  // Post-process: filter TRIGGERS spans and resolve flow names
  spans = spans.filter(s => s.name !== 'TRIGGERS');
  if (flowNames) {
    spans = spans.map(s => {
      if (s.category === 'CODE_UNIT_STARTED' && /^Flow:/i.test(s.name || '')) {
        return { ...s, name: resolveFlowSpanName(s.name, flowNames) };
      }
      return s;
    });
  }

  const allMs = [
    ...spans.map(s => s.startMs),
    ...spans.map(s => s.endMs),
  ];
  const timelineStart = allMs.length > 0 ? Math.min(...allMs) : 0;
  const timelineEnd   = allMs.length > 0 ? Math.max(...allMs) : 1;
  const totalMs = Math.max(1, timelineEnd - timelineStart);

  // Overview row: merged phase blocks + explicit gap segments for platform time
  const phases = buildOverviewPhases(spans);
  const overviewSegs = [];

  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i];
    // Insert a gap segment before this phase if there's unaccounted time
    if (i === 0 && ph.startMs > timelineStart + 10) {
      const gapStart = timelineStart;
      const gapEnd   = ph.startMs;
      const gapLeft  = 0;
      const gapWidth = ((gapEnd - gapStart) / totalMs) * 100;
      const gapDur   = Math.round(gapEnd - gapStart);
      overviewSegs.push(`<div class="overview-segment overview-gap"
           style="position:absolute;left:${gapLeft.toFixed(3)}%;width:${gapWidth.toFixed(3)}%;top:0;bottom:0;"
           data-phase="gap" data-label="Platform overhead" data-dur="${gapDur}" data-count="0"
           data-range-start="${gapStart.toFixed(1)}" data-range-end="${gapEnd.toFixed(1)}">
        <span class="segment-label gap-label">${gapDur} ms</span>
      </div>`);
    } else if (i > 0) {
      const prev = phases[i - 1];
      const gapMs = ph.startMs - prev.endMs;
      if (gapMs > 10) {
        const gapLeft  = ((prev.endMs - timelineStart) / totalMs) * 100;
        const gapWidth = (gapMs / totalMs) * 100;
        overviewSegs.push(`<div class="overview-segment overview-gap"
             style="position:absolute;left:${gapLeft.toFixed(3)}%;width:${gapWidth.toFixed(3)}%;top:0;bottom:0;"
             data-phase="gap" data-label="Platform overhead" data-dur="${Math.round(gapMs)}" data-count="0"
             data-range-start="${prev.endMs.toFixed(1)}" data-range-end="${ph.startMs.toFixed(1)}">
          <span class="segment-label gap-label">${Math.round(gapMs)} ms</span>
        </div>`);
      }
    }

    const leftPct  = ((ph.startMs - timelineStart) / totalMs) * 100;
    const widthPct = Math.max(1.5, ((ph.endMs - ph.startMs) / totalMs) * 100);
    const dur = Math.round(ph.endMs - ph.startMs);
    overviewSegs.push(`<div class="overview-segment tl-cat-${ph.type}"
         style="position:absolute;left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%;
                top:0;bottom:0;background:${ph.color};border-radius:3px;"
         data-phase="${escapeHtml(ph.type)}"
         data-label="${escapeHtml(ph.label)}"
         data-dur="${dur}"
         data-count="${ph.count}"
         data-range-start="${ph.startMs.toFixed(1)}"
         data-range-end="${ph.endMs.toFixed(1)}">
      <span class="segment-label">${escapeHtml(ph.label)}</span>
    </div>`);
  }

  // Trailing gap
  if (phases.length > 0) {
    const last = phases[phases.length - 1];
    const trailEnd = timelineStart + totalMs;
    const trailMs = trailEnd - last.endMs;
    if (trailMs > 10) {
      const gapLeft  = ((last.endMs - timelineStart) / totalMs) * 100;
      const gapWidth = (trailMs / totalMs) * 100;
      overviewSegs.push(`<div class="overview-segment overview-gap"
           style="position:absolute;left:${gapLeft.toFixed(3)}%;width:${gapWidth.toFixed(3)}%;top:0;bottom:0;"
           data-phase="gap" data-label="Platform overhead" data-dur="${Math.round(trailMs)}" data-count="0"
           data-range-start="${last.endMs.toFixed(1)}" data-range-end="${trailEnd.toFixed(1)}">
        <span class="segment-label gap-label">${Math.round(trailMs)} ms</span>
      </div>`);
    }
  }

  const overviewSegsHtml = overviewSegs.join('');

  // Detail gantt (initially hidden, shown when overview block is clicked)
  const ganttHtml = renderTimelineGantt(spans, timelineStart, totalMs);

  // Compute the shared nanos reference for point positioning
  const firstNanosRef = spanEvents.find(e => e.nanos !== null)?.nanos ?? null;
  // Point event strip (errors, exceptions, debug markers)
  const pointStripHtml = renderPointStrip(pointEvents, timelineStart, totalMs, firstNanosRef);

  // Filter buttons — one per distinct phase type present, skip hidden ones
  const presentPhases = [...new Set(spans.map(s => classifyPhase(s)))]
    .filter(ph => PHASE_META[ph]?.show !== false);
  const filterBtns = presentPhases.map(ph => {
    const meta = PHASE_META[ph] || { label: ph, color: '#888' };
    return `<button class="tl-filter-btn" data-filter="${ph}"
              style="--filter-color:${meta.color};">
              <span class="tl-filter-dot" style="background:${meta.color};"></span>
              ${escapeHtml(meta.label)}
            </button>`;
  }).join('');
  const errorEvents = pointEvents.filter(e => e.category === 'FATAL_ERROR' || e.category === 'EXCEPTION_THROWN');
  const debugEvents = pointEvents.filter(e => e.category === 'USER_DEBUG');
  const errFilterBtn = errorEvents.length > 0
    ? `<button class="tl-filter-btn" data-filter="errors" style="--filter-color:#d94545;">
         <span class="tl-filter-dot" style="background:#d94545;"></span>Errors (${errorEvents.length})
       </button>`
    : '';
  const debugFilterBtn = debugEvents.length > 0
    ? `<button class="tl-filter-btn" data-filter="debug" style="--filter-color:#888;">
         <span class="tl-filter-dot" style="background:#888;"></span>Debug (${debugEvents.length})
       </button>`
    : '';

  // Gap explanation note
  const gapNote = `<div class="tl-gap-note">Hatched areas are platform overhead (DB commits, sharing recalculation, lock waits) — counted in total time but not visible in Apex code.</div>`;

  const startTime = events[0].time;
  const endTime   = events[events.length - 1].time;

  return `
    <div class="timeline-container" id="timeline-root">
      <div class="tl-filters">${filterBtns}${errFilterBtn}${debugFilterBtn}
        <button class="tl-filter-btn tl-filter-all active" data-filter="all">Show all</button>
      </div>
      <div class="tl-overview-label">Overview <span class="tl-click-hint">— click a block to expand</span></div>
      <div class="timeline-bar-row overview-row" style="height:40px;position:relative;">
        ${overviewSegsHtml}
      </div>
      <div class="tl-detail" id="tl-detail" style="display:none;">
        <div class="tl-detail-label" id="tl-detail-label"></div>
        <div class="tl-detail-scroll" id="tl-detail-scroll">
          ${ganttHtml}
        </div>
        <div class="tl-zoom-hint" id="tl-gantt-zoom-hint" style="display:none;">Pinch or Ctrl+scroll to zoom · Scroll to pan · Double-click to reset</div>
      </div>
      ${errorEvents.length > 0 ? `<div class="tl-event-group tl-event-group-errors"><div class="tl-points-label tl-points-label-error">Errors &amp; Exceptions (${errorEvents.length})</div>${renderPointStrip(errorEvents, timelineStart, totalMs, firstNanosRef)}</div>` : ''}
      ${debugEvents.length > 0 ? `<div class="tl-event-group tl-event-group-debug"><div class="tl-points-label">Debug statements (${debugEvents.length})</div>${renderPointStrip(debugEvents, timelineStart, totalMs, firstNanosRef)}</div>` : ''}
      <div id="tl-line-detail" class="tl-line-detail" style="display:none;"></div>
      <div class="timeline-axis">
        <span class="axis-start">${startTime}</span>
        <span>${totalMs.toFixed(0)} ms total</span>
        <span class="axis-end">${endTime}</span>
      </div>
      ${gapNote}
    </div>
  `;
}

function attachInteractionHandlers() {
  const tooltip = document.getElementById('span-tooltip');

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('tab-' + btn.getAttribute('data-tab'));
      if (panel) panel.classList.add('active');
    });
  });

  // Collapsible panels
  document.querySelectorAll('.collapsible-header').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.collapsible-panel');
      if (!panel) return;
      const open = panel.classList.toggle('open');
      btn.setAttribute('aria-expanded', open);
    });
  });

  // Code scan findings: hide "Open in log" buttons (no editor in browser)
  document.querySelectorAll('.scan-open-btn[data-line-index]').forEach((btn) => {
    btn.style.display = 'none';
  });

  // Narrative step rows: remove pointer cursor (can't open editor)
  document.querySelectorAll('.narr-step[data-line-index]').forEach((el) => {
    el.style.cursor = '';
  });

  // Validation rule rows: keep tooltip but remove editor click
  document.querySelectorAll('.vr-row').forEach((el) => {

    const formula = el.getAttribute('data-formula');
    if (formula && tooltip) {
      el.addEventListener('mouseenter', (ev) => {
        const name = el.querySelector('.vr-name')?.textContent || '';
        tooltip.innerHTML = `
          <div class="tooltip-type">Validation Formula</div>
          <div class="tooltip-name">${escapeHtml(name)}</div>
          <div class="tooltip-formula">${escapeHtml(formula)}</div>
          `;
        tooltip.style.display = 'block';
        positionTooltip(ev, tooltip);
      });
      el.addEventListener('mousemove', (ev) => positionTooltip(ev, tooltip));
      el.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    }
  });

  // Validation accordion toggle
  document.querySelectorAll('.vr-group-title').forEach((el) => {
    el.addEventListener('click', () => {
      const group = el.closest('.vr-group');
      if (group) group.classList.toggle('vr-group-collapsed');
    });
  });

  // Timeline segment (detail gantt) interactions
  function attachSegmentHandlers(container) {
    container.querySelectorAll('.timeline-segment, .tl-point-marker').forEach((el) => {
      el.addEventListener('click', () => {
        if (tooltip) tooltip.style.display = 'none';
        showLineDetail(el);
      });

      el.addEventListener('mouseenter', (ev) => showSegmentTooltip(ev, el, tooltip));
      el.addEventListener('mousemove', (ev) => { if (tooltip) positionTooltip(ev, tooltip); });
      el.addEventListener('mouseleave', () => { if (tooltip) tooltip.style.display = 'none'; });
    });
  }
  attachSegmentHandlers(document);

  // Overview segment click -> expand detail filtered to that phase
  const detailEl = document.getElementById('tl-detail');
  const detailLabel = document.getElementById('tl-detail-label');
  document.querySelectorAll('.overview-segment').forEach((el) => {
    el.addEventListener('mouseenter', (ev) => {
      if (!tooltip) return;
      const label = el.getAttribute('data-label') || '';
      const dur   = el.getAttribute('data-dur') || '';
      const count = el.getAttribute('data-count') || '';
      tooltip.innerHTML = `
        <div class="tooltip-type">Phase</div>
        <div class="tooltip-name">${escapeHtml(label)}</div>
        <div class="tooltip-meta">
          <span>${dur} ms</span>
          <span>${count} span${count === '1' ? '' : 's'}</span>
        </div>
        <div class="tooltip-hint">Click to expand detail</div>`;
      tooltip.style.display = 'block';
      positionTooltip(ev, tooltip);
    });
    el.addEventListener('mousemove', (ev) => { if (tooltip) positionTooltip(ev, tooltip); });
    el.addEventListener('mouseleave', () => { if (tooltip) tooltip.style.display = 'none'; });

    el.addEventListener('click', () => {
      if (!detailEl) return;
      const phase = el.getAttribute('data-phase');
      const label = el.getAttribute('data-label') || '';
      const rangeStart = parseFloat(el.getAttribute('data-range-start') || '0');
      const rangeEnd   = parseFloat(el.getAttribute('data-range-end')   || '999999999');
      const wasActive = el.classList.contains('overview-active');

      // Always fully reset gantt state first
      document.querySelectorAll('.overview-segment').forEach(s => s.classList.remove('overview-active'));
      detailEl.querySelectorAll('.timeline-segment').forEach(seg => {
        seg.classList.remove('gantt-highlight', 'gantt-dimmed', 'gantt-in-window');
        seg.style.visibility = '';
        seg.style.pointerEvents = '';
      });

      if (wasActive) {
        detailEl.style.display = 'none';
        return;
      }

      el.classList.add('overview-active');
      detailEl.style.display = 'block';

      // When clicking an overview block, switch the filter to match that phase
      // so the gantt shows the right category (not whatever was filtered before)
      if (phase && phase !== 'gap') {
        document.querySelectorAll('.tl-filter-btn').forEach(b => b.classList.remove('active'));
        const matchingBtn = document.querySelector(`.tl-filter-btn[data-filter="${phase}"]`);
        if (matchingBtn) {
          matchingBtn.classList.add('active');
        } else {
          // No matching filter button — fall back to show all
          document.querySelector('.tl-filter-all')?.classList.add('active');
        }
      }

      const activeFilter = phase && phase !== 'gap'
        ? phase
        : (document.querySelector('.tl-filter-btn.active')?.getAttribute('data-filter') || 'all');
      let highlightCount = 0;
      detailEl.querySelectorAll('.timeline-segment').forEach(seg => {
        const segStart   = parseFloat(seg.getAttribute('data-start') || '0');
        const segDur     = parseFloat(seg.getAttribute('data-dur')   || '0');
        const segEnd     = segStart + segDur;
        const inRange    = segStart <= rangeEnd + 1 && segEnd >= rangeStart - 1;
        const matchPhase = phase === 'gap' || phase === 'all' || seg.classList.contains(`tl-cat-${phase}`);
        const matchFilter = activeFilter === 'all' || seg.classList.contains(`tl-cat-${activeFilter}`);

        if (!matchFilter) {
          seg.style.visibility = 'hidden';
          seg.style.pointerEvents = 'none';
        } else if (inRange && matchPhase) {
          // Exact match: same type AND in time window → strong highlight
          seg.classList.add('gantt-highlight');
          highlightCount++;
        } else if (inRange) {
          // In time window but different type → subtle context style
          seg.classList.add('gantt-in-window');
        } else {
          // Outside this window → dim
          seg.classList.add('gantt-dimmed');
        }
      });

      // Update detail label with phase name and count
      if (detailLabel) {
        const phaseName = phase === 'gap' ? 'Platform Overhead' : label;
        detailLabel.textContent = highlightCount > 0
          ? `${phaseName.toUpperCase()} — ${highlightCount} span${highlightCount === 1 ? '' : 's'} in this window`
          : `${phaseName.toUpperCase()} — no matching spans in this window`;
      }

      // Scroll the first highlighted segment into view
      const firstHighlight = detailEl.querySelector('.gantt-highlight');
      if (firstHighlight) {
        firstHighlight.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      }
    });
  });

  // Filter buttons
  document.querySelectorAll('.tl-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const filter = btn.getAttribute('data-filter');
      document.querySelectorAll('.tl-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // In the detail gantt — clear range highlights when filter changes
      if (detailEl) {
        detailEl.querySelectorAll('.timeline-segment').forEach(seg => {
          seg.classList.remove('gantt-highlight', 'gantt-dimmed', 'gantt-in-window');
          const visible = filter === 'all' || seg.classList.contains(`tl-cat-${filter}`);
          seg.style.visibility = visible ? 'visible' : 'hidden';
          seg.style.pointerEvents = visible ? 'auto' : 'none';
        });
        document.querySelectorAll('.overview-segment').forEach(s => s.classList.remove('overview-active'));
      }
      // In the overview — hide non-matching blocks entirely
      document.querySelectorAll('.overview-segment').forEach(seg => {
        const visible = filter === 'all' || seg.classList.contains(`tl-cat-${filter}`);
        seg.style.visibility = visible ? 'visible' : 'hidden';
        seg.style.pointerEvents = visible ? 'auto' : 'none';
      });
      // Show/hide error and debug strips based on filter
      const showErrors = filter === 'all' || filter === 'errors';
      const showDebug  = filter === 'all' || filter === 'debug';
      const errGroup = document.querySelector('.tl-event-group-errors');
      const dbgGroup = document.querySelector('.tl-event-group-debug');
      if (errGroup) errGroup.style.display = showErrors ? '' : 'none';
      if (dbgGroup) dbgGroup.style.display = showDebug  ? '' : 'none';
    });
  });

  // ── Pinch-to-zoom + pan on the overview row ───────────────────────────────
  const overviewRow = document.querySelector('.overview-row');
  if (overviewRow) {
    let zoom = 1;    // scale factor (1 = full width, 10 = 10× zoomed)
    let pan  = 0;    // left offset as fraction of total width (0–1)

    function applyZoom() {
      // Clamp pan so we don't scroll past edges
      const maxPan = Math.max(0, 1 - 1 / zoom);
      pan = Math.max(0, Math.min(maxPan, pan));
      overviewRow.querySelectorAll('.overview-segment').forEach(seg => {
        // Each segment has its natural left% and width% baked into its style
        // We re-derive them from data attributes we'll add, or parse existing style
        const origLeft  = parseFloat(seg.dataset.origLeft  ?? (seg.dataset.origLeft  = parseFloat(seg.style.left)));
        const origWidth = parseFloat(seg.dataset.origWidth ?? (seg.dataset.origWidth = parseFloat(seg.style.width)));
        const newLeft  = (origLeft  / 100 - pan) * zoom * 100;
        const newWidth = origWidth * zoom;
        seg.style.left  = `${newLeft}%`;
        seg.style.width = `${Math.max(0.3, newWidth)}%`;
        seg.style.visibility = (newLeft + newWidth < 0 || newLeft > 100) ? 'hidden' : '';
      });
      // Show a reset hint when zoomed in
      let hint = overviewRow.parentElement.querySelector('.tl-zoom-hint');
      if (zoom > 1.05) {
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'tl-zoom-hint';
          hint.textContent = 'Pinch or Ctrl+scroll to zoom · Scroll to pan · Double-click or Esc to reset';
          overviewRow.parentElement.insertBefore(hint, overviewRow.nextSibling);
        }
      } else {
        hint?.remove();
      }
    }

    // Normalise wheel delta across platforms:
    // deltaMode 0 = pixels (Mac trackpad), 1 = lines (Windows mouse), 2 = pages
    function normaliseDelta(e) {
      if (e.deltaMode === 1) return e.deltaY * 20; // ~20px per line
      if (e.deltaMode === 2) return e.deltaY * 400;
      return e.deltaY;
    }

    function zoomToward(factor, cursorFraction) {
      const prevZoom = zoom;
      zoom = Math.max(1, Math.min(50, zoom * factor));
      const cursorInTimeline = pan + cursorFraction / prevZoom;
      pan = cursorInTimeline - cursorFraction / zoom;
      applyZoom();
    }

    overviewRow.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = overviewRow.getBoundingClientRect();
      const cursorFraction = (e.clientX - rect.left) / rect.width;
      const delta = normaliseDelta(e);

      if (e.ctrlKey) {
        // Pinch-to-zoom on Mac trackpad AND Ctrl+scroll on Windows
        zoomToward(delta < 0 ? 1.12 : 0.89, cursorFraction);
      } else {
        // Two-finger scroll to pan
        const panDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        pan += (normaliseDelta({ deltaY: panDelta, deltaMode: e.deltaMode }) / rect.width) / zoom;
        applyZoom();
      }
    }, { passive: false });

    overviewRow.addEventListener('dblclick', () => {
      zoom = 1; pan = 0; applyZoom();
    });

    // ── Pinch-to-zoom on the gantt detail panel ───────────────────────────
    const ganttDetail  = document.getElementById('tl-detail');
    const ganttScroll  = document.getElementById('tl-detail-scroll');
    const ganttHint    = document.getElementById('tl-gantt-zoom-hint');
    if (ganttDetail && ganttScroll) {
      let ganttZoom = 1;

      function applyGanttZoom(factor, pivotFraction) {
        // 1. Record the cursor's absolute position in the content BEFORE zoom
        const scrollBefore = ganttDetail.scrollLeft;
        const visibleWidth  = ganttDetail.clientWidth;
        const contentWidthBefore = ganttDetail.scrollWidth; // total scrollable width
        const cursorAbsPx = scrollBefore + pivotFraction * visibleWidth;
        // Cursor as a fraction of total content (stays fixed across zoom)
        const cursorContentFrac = contentWidthBefore > 0 ? cursorAbsPx / contentWidthBefore : pivotFraction;

        // 2. Apply new zoom
        ganttZoom = Math.max(1, Math.min(50, ganttZoom * factor));
        ganttScroll.style.width = ganttZoom <= 1 ? '' : `${ganttZoom * 100}%`;

        // 3. Compute new scroll so the same content fraction stays under the cursor
        const contentWidthAfter = ganttDetail.scrollWidth;
        ganttDetail.scrollLeft = cursorContentFrac * contentWidthAfter - pivotFraction * visibleWidth;

        if (ganttHint) ganttHint.style.display = ganttZoom > 1.05 ? 'block' : 'none';
      }

      ganttDetail.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const rect = ganttDetail.getBoundingClientRect();
        const pivotFraction = (e.clientX - rect.left) / rect.width;
        const delta = normaliseDelta(e);
        applyGanttZoom(delta < 0 ? 1.12 : 0.89, pivotFraction);
      }, { passive: false });

      ganttDetail.addEventListener('dblclick', () => {
        ganttZoom = 1;
        ganttScroll.style.width = '';
        ganttDetail.scrollLeft = 0;
        if (ganttHint) ganttHint.style.display = 'none';
      });
    }

    // Keyboard zoom: +/- or Ctrl+=/- while overview is focused
    overviewRow.setAttribute('tabindex', '0');
    overviewRow.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=' || (e.ctrlKey && e.key === '=')) {
        e.preventDefault();
        zoomToward(1.25, 0.5);
      } else if (e.key === '-' || (e.ctrlKey && e.key === '-')) {
        e.preventDefault();
        zoomToward(0.8, 0.5);
      } else if (e.key === '0' || e.key === 'Escape') {
        zoom = 1; pan = 0; applyZoom();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        pan -= 0.1 / zoom; applyZoom();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        pan += 0.1 / zoom; applyZoom();
      }
    });
  }
}

function showSegmentTooltip(ev, el, tooltip) {
  if (!tooltip) return;
  const label = el.getAttribute('data-label') || '';
  const type  = el.getAttribute('data-type') || '';
  const dur   = el.getAttribute('data-dur') || '';
  const start = el.getAttribute('data-start') || '';
  const rows  = el.getAttribute('data-rows');
  const rowsHtml = rows !== '' && rows !== null
    ? `<span>${rows} row${rows === '0' ? 's — no results' : rows === '1' ? '' : 's'} returned</span>`
    : '';
  const tooltipLabel = label.length > 120 ? label.substring(0, 120) + '…' : label;
  tooltip.innerHTML = `
    <div class="tooltip-type">${escapeHtml(type)}</div>
    <div class="tooltip-name">${escapeHtml(tooltipLabel)}</div>
    <div class="tooltip-meta">
      <span>${dur} ms</span>
      ${start ? `<span>@ +${parseFloat(start).toFixed(1)} ms</span>` : ''}
      ${rowsHtml}
    </div>
    <div class="tooltip-hint">Click to view log lines</div>`;
  tooltip.style.display = 'block';
  positionTooltip(ev, tooltip);
}

// Salesforce replaces SOQL bind variables with synthetic :tmpVarN names that are never
// explicitly logged. We can't resolve them directly, but we can show the variable
// assignments that happened just before the query — these are the in-scope values at
// the call site and typically include the actual IDs/sets that were bound.
function resolveBindVariables(query, soqlLineIdx) {
  const bindTokens = query.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g) || [];
  if (bindTokens.length === 0) return [];
  const bindCount = new Set(bindTokens).size;

  // Scan backwards up to 60 lines, keep the most-recent assignment per variable name
  const recent = new Map(); // varName → {name, value}
  const limit = Math.max(0, soqlLineIdx - 60);
  for (let i = soqlLineIdx - 1; i >= limit; i--) {
    const line = currentLogLines[i] || '';
    if (!line.includes('VARIABLE_ASSIGNMENT')) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const varName = parts[3];
    if (recent.has(varName)) continue; // already have most-recent
    let val = parts.slice(4).join('|');
    val = val.replace(/\|0x[0-9a-f]+$/i, '').trim();
    // Skip uninteresting null/empty/object-ref-only values
    if (val === 'null' || val === '' || val === '{}' || val === '[]') continue;
    if (val.length > 300) val = val.slice(0, 300) + '…';
    recent.set(varName, { name: varName, value: val });
    if (recent.size >= bindCount * 3) break; // enough context
  }
  // Return in reverse insertion order so most-recently assigned appears last (chronological)
  return [...recent.values()].reverse();
}

function showLineDetail(el) {
  const detailBox = document.getElementById('tl-line-detail');
  if (!detailBox) return;

  const startIdx = parseInt(el.getAttribute('data-line-index') || '-1');
  const endIdx   = parseInt(el.getAttribute('data-end-line-index') || startIdx);
  const label    = el.getAttribute('data-label') || '';
  const type     = el.getAttribute('data-type') || '';
  const dur      = el.getAttribute('data-dur') || '';
  const rows     = el.getAttribute('data-rows');

  // If same element clicked again, toggle closed
  if (detailBox.style.display !== 'none' && detailBox.getAttribute('data-for') === String(startIdx)) {
    detailBox.style.display = 'none';
    detailBox.removeAttribute('data-for');
    el.classList.remove('segment-selected');
    return;
  }

  // Deselect previous
  document.querySelectorAll('.segment-selected').forEach(s => s.classList.remove('segment-selected'));
  el.classList.add('segment-selected');

  // Collect log lines for this span
  const lineSlice = [];
  if (startIdx >= 0 && currentLogLines.length > 0) {
    const end = endIdx >= startIdx ? Math.min(endIdx, startIdx + 60) : startIdx;
    for (let i = startIdx; i <= end && i < currentLogLines.length; i++) {
      lineSlice.push({ n: i + 1, text: currentLogLines[i] });
    }
  }

  const rowsNote = rows !== '' && rows !== null
    ? `<span class="detail-meta-item">${rows} row${rows === '0' ? 's — no results' : rows === '1' ? '' : 's'} returned</span>`
    : '';
  const durNote = dur ? `<span class="detail-meta-item">${dur} ms</span>` : '';

  const linesHtml = lineSlice.length > 0
    ? lineSlice.map(l => {
        return `<div class="detail-line">
          <span class="detail-line-num">${l.n}</span>
          <span class="detail-line-text">${escapeHtml(l.text)}</span>
        </div>`;
      }).join('')
    : '<p class="muted" style="margin:0">No log lines available — log was not loaded from a file.</p>';

  const openBtn = startIdx >= 0
    ? `<button class="detail-open-btn" data-line-index="${startIdx}">Open log</button>`
    : '';

  // Find source reference: for SOQL spans, use the bracket line number from the SOQL line
  // to find the METHOD_ENTRY that matches — avoids landing on an unrelated class that happened
  // to run recently. For other spans, fall back to the generic backwards scan.
  const startLineText = startIdx >= 0 ? (currentLogLines[startIdx] || '') : '';
  let headerSourceInfo = null;

  if ((type === 'SOQL Query' || type === 'DML Operation') && startIdx >= 0) {
    headerSourceInfo = extractSourceInfoForSoql(startIdx);
  }

  if (!headerSourceInfo) {
    headerSourceInfo = extractSourceInfo(startLineText);
  }
  if (!headerSourceInfo && startIdx >= 0) {
    for (let i = startIdx - 1; i >= Math.max(0, startIdx - 80); i--) {
      const info = extractSourceInfo(currentLogLines[i] || '');
      if (info) { headerSourceInfo = info; break; }
    }
  }

  // For SOQL spans, extract the full query from the raw log line (label is truncated)
  let fullQuery = null;
  let bindVars = null;
  if (type === 'SOQL Query' && startIdx >= 0) {
    const rawLine = currentLogLines[startIdx] || '';
    const parts = rawLine.split('|');
    if (parts[1]?.trim() === 'SOQL_EXECUTE_BEGIN') {
      const raw = parts.slice(3).join('|');
      const m = raw.match(/SELECT\s+.+/i);
      if (m) {
        fullQuery = m[0];
        bindVars = resolveBindVariables(fullQuery, startIdx);
      }
    }
  }

  const isValidationSpan = el.classList.contains('tl-cat-validation');
  const isDatasourceSpan = el.classList.contains('tl-cat-datasource');
  // In the Chrome extension, source files are not accessible — only show source panel
  // for validation and datasource spans which render from log data, not local files
  const hasSrc = isValidationSpan || isDatasourceSpan;

  let bindHtml = '';
  if (bindVars && bindVars.length > 0) {
    const rows = bindVars.map(b =>
      `<tr><td class="bind-var-name">${escapeHtml(b.name)}</td><td class="bind-var-value">${escapeHtml(b.value)}</td></tr>`
    ).join('');
    bindHtml = `<div class="bind-vars-label">Variables in scope before query</div><table class="bind-vars-table"><tbody>${rows}</tbody></table>`;
  }

  const nameHtml = fullQuery
    ? `<div class="detail-query-wrap">
         <div class="detail-query-full">${escapeHtml(fullQuery)}</div>
         <button class="detail-query-copy" title="Copy query">Copy</button>
       </div>${bindHtml}`
    : `<span class="detail-name">${escapeHtml(label)}</span>`;

  detailBox.innerHTML = `
    <div class="detail-header">
      <div style="min-width:0;flex:1;">
        <span class="detail-type">${escapeHtml(type)}</span>
        ${nameHtml}
        <div class="detail-description" style="display:none;"></div>
        <span class="detail-meta">${durNote}${rowsNote}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
        ${openBtn}
        <button class="detail-close-btn">✕</button>
      </div>
    </div>
    <div class="detail-split${hasSrc ? ' has-source' : ''}">
      <div class="detail-log-pane">
        <div class="detail-pane-label">Log lines</div>
        <div class="detail-lines">${linesHtml}</div>
      </div>
      ${hasSrc ? `<div class="detail-source-panel"><div class="detail-src-loading">Loading source…</div></div>` : ''}
    </div>`;

  detailBox.setAttribute('data-for', String(startIdx));
  detailBox.style.display = 'block';

  // Request description asynchronously — renders into .detail-description when response arrives
  // requestDescription not available in Chrome extension (requires local file access)

  // Wire up buttons
  detailBox.querySelector('.detail-close-btn')?.addEventListener('click', () => {
    detailBox.style.display = 'none';
    el.classList.remove('segment-selected');
  });
  detailBox.querySelector('.detail-open-btn')?.addEventListener('click', () => {
    // In the browser, scroll the log lines section into view
    const logLinesSection = detailBox.querySelector('.detail-log-lines');
    if (logLinesSection) {
      logLinesSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // Highlight the first line briefly
      const firstLine = logLinesSection.querySelector('.detail-log-line');
      if (firstLine) {
        firstLine.style.background = 'var(--vscode-editor-selectionBackground)';
        setTimeout(() => { firstLine.style.background = ''; }, 1500);
      }
    }
  });
  detailBox.querySelector('.detail-query-copy')?.addEventListener('click', (ev) => {
    const pre = detailBox.querySelector('.detail-query-full');
    if (!pre) return;
    navigator.clipboard.writeText(pre.textContent || '').then(() => {
      const btn = ev.currentTarget;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
  // detail-src-btn removed in Chrome extension build

  const srcPanel = detailBox.querySelector('.detail-source-panel');
  if (!srcPanel) return;

  // Detect flow spans — but never treat SOQL/DML as flows even if flow activity
  // appears inside their time range (that's downstream, not the caller)
  const isDmlOrSoql = type === 'SOQL Query' || type === 'DML Operation';
  const isFlow = !isDmlOrSoql && (el.classList.contains('tl-cat-flow') || (endIdx >= 0 && isFlowSpan(startIdx, endIdx)));

  if (isFlow) {
    srcPanel.innerHTML = renderFlowTrace(startIdx, endIdx);
    srcPanel.querySelectorAll('.flow-org-link').forEach(a => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        vscode.postMessage({ type: 'openExternal', url: a.getAttribute('href') });
      });
    });
    return;
  }

  // Validation spans: show the rules executed in this CODE_UNIT in the right panel
  if (isValidationSpan) {
    srcPanel.innerHTML = renderValidationDetail(startIdx, endIdx);
    return;
  }

  // Datasource spans: show provider info + method + capabilities
  if (isDatasourceSpan) {
    srcPanel.innerHTML = renderDatasourceDetail(startIdx, endIdx, label);
    srcPanel.querySelector('.detail-src-open-btn')?.addEventListener('click', () => {
      const btn = srcPanel.querySelector('.detail-src-open-btn');
      if (btn) vscode.postMessage({ type: 'openSource', className: btn.getAttribute('data-class'), lineNumber: 1 });
    });
    return;
  }

  // Source snippets require local file access — not available in Chrome extension
  srcPanel.innerHTML = '<div class="detail-src-not-found">Source code not available in browser. Use the VS Code extension to view source files.</div>';
}

// Request description from extension host based on span type, and show it in the header
function requestDescription(el, type, label, startIdx, endIdx) {
  // Check specific span types by CSS class first (before generic type fallback)
  if (el.classList.contains('tl-cat-flow')) {
    let flowApiName = label.replace(/^Flow:/i, '').trim();
    for (let i = startIdx; i <= Math.min(endIdx, startIdx + 50); i++) {
      const line = currentLogLines[i] || '';
      if (line.includes('FLOW_START_INTERVIEW_BEGIN')) {
        const parts = line.split('|');
        const candidate = parts[3]?.trim() || '';
        if (candidate) { flowApiName = candidate; break; }
      }
    }
    if (flowApiName) {
      vscode.postMessage({ type: 'getDescription', kind: 'flow', name: flowApiName });
    }
    return;
  }
  if (el.classList.contains('tl-cat-validation')) {
    const rule = currentValidationRules.find(r => r.lineIndex >= startIdx && r.lineIndex <= endIdx);
    if (rule) {
      vscode.postMessage({ type: 'getDescription', kind: 'validationRule', name: rule.name, object: rule.object });
    }
    return;
  }
  if (el.classList.contains('tl-cat-datasource')) {
    const providerClass = label.replace(/^ApexDataSource:/i, '').trim();
    if (providerClass) {
      vscode.postMessage({ type: 'getDescription', kind: 'apex', name: providerClass });
    }
    return;
  }
  // Trigger spans: extract trigger name from the label e.g. "SMT_OpportunityTrigger on Opportunity trigger event AfterInsert"
  if (el.classList.contains('tl-cat-before-trigger') || el.classList.contains('tl-cat-after-trigger') || el.classList.contains('tl-cat-trigger')) {
    const triggerMatch = label.match(/^(\w+)\s+on\s+(\w+)\s+trigger\s+event\s+(\w+)/i);
    const triggerName = triggerMatch ? triggerMatch[1] : label.match(/^(\w+)/)?.[1];
    if (triggerName) {
      vscode.postMessage({ type: 'getDescription', kind: 'trigger', name: triggerName,
        object: triggerMatch?.[2], event: triggerMatch?.[3] });
    }
    return;
  }

  // For all other spans (Apex, SOQL, DML, etc.) look up the active Apex class
  // Extract class+method from the span's own start line (most reliable for method spans)
  const startLineParts = (currentLogLines[startIdx] || '').split('|');
  const startLineSig = startLineParts[4]?.trim() || startLineParts[3]?.trim() || '';
  const methodMatch = startLineSig.match(/^([A-Z]\w*)\.([\w]+\(.*?\))/);

  if (methodMatch) {
    // Try the span's own class first; if it's a system/custom-setting class with no .cls,
    // the host returns null and we fall back to the calling frame via the call stack.
    const callerInfo = extractSourceInfoForSoql(startIdx);
    if (callerInfo && callerInfo.className !== methodMatch[1]) {
      // Span belongs to a different class than the active Apex frame — show both:
      // try span's own class first, and include caller as fallback context
      vscode.postMessage({ type: 'getDescription', kind: 'apexMethod', name: methodMatch[1],
        object: methodMatch[2], fallbackClass: callerInfo.className });
    } else {
      vscode.postMessage({ type: 'getDescription', kind: 'apexMethod', name: methodMatch[1], object: methodMatch[2] });
    }
    return;
  }

  // Fallback for SOQL/DML/trigger spans: use call stack to find the executing class
  const info = extractSourceInfoForSoql(startIdx) || (() => {
    const m = startLineSig.match(/^([A-Z]\w*)\./);
    return m ? { className: m[1], lineNumber: 0 } : null;
  })();
  if (info) {
    vscode.postMessage({ type: 'getDescription', kind: 'apex', name: info.className });
  }
}

function renderDescription(msg) {
  const descEl = document.querySelector('.detail-description');
  if (!descEl) { return; }
  if (!msg.description) { return; }

  // Build a source label so the user knows what the description refers to
  let sourceLabel = '';
  if (msg.kind === 'apexMethod' && msg.object) {
    sourceLabel = `${msg.name}.${msg.object.replace(/\(.*$/, '()')}`;
  } else if (msg.kind === 'apex' || msg.kind === 'trigger') {
    sourceLabel = msg.name;
  } else if (msg.kind === 'flow') {
    sourceLabel = 'Flow';
  } else if (msg.kind === 'validationRule') {
    sourceLabel = msg.name;
  }

  descEl.innerHTML = sourceLabel
    ? `<span class="desc-source">${escapeHtml(sourceLabel)}</span> ${escapeHtml(msg.description)}`
    : escapeHtml(msg.description);
  descEl.style.display = 'block';
}

function isFlowSpan(startIdx, endIdx) {
  for (let i = startIdx; i <= Math.min(endIdx, startIdx + 20); i++) {
    const line = currentLogLines[i] || '';
    if (line.includes('FLOW_ELEMENT_BEGIN') || line.includes('FLOW_START_INTERVIEW_BEGIN') ||
        line.includes('CODE_UNIT_STARTED') && /\|Flow:/i.test(line)) return true;
  }
  return false;
}

function renderFlowTrace(startIdx, endIdx) {
  const elements = [];
  let flowName = '';
  let flowId = '';   // 15/18-char SF ID used to build the Flow Builder URL
  const limit = Math.min(endIdx, startIdx + 2000);

  for (let i = startIdx; i <= limit; i++) {
    const line = currentLogLines[i] || '';
    const parts = line.split('|');
    const cat = parts[1]?.trim();
    if (!cat) continue;

    if (cat === 'CODE_UNIT_STARTED' && !flowId) {
      // Format: |[EXTERNAL]|FlowId  (e.g. 01I1r000001ZzTf) or |[EXTERNAL]|Flow:ApiName
      const p3 = parts[3]?.trim() || '';
      if (/^[a-zA-Z0-9]{15,18}$/.test(p3)) flowId = p3;
      else if (/^Flow:/i.test(p3)) {
        const apiPart = p3.replace(/^Flow:/i, '');
        // apiPart may itself be an ID
        if (/^[a-zA-Z0-9]{15,18}$/.test(apiPart)) flowId = apiPart;
      }
    }
    if (cat === 'FLOW_START_INTERVIEW_BEGIN') {
      if (!flowName) flowName = parts[3]?.trim() || '';
    }
    if ((cat === 'FLOW_START_INTERVIEW_BEGIN' || cat === 'CODE_UNIT_STARTED') && !flowName) {
      flowName = parts[3]?.trim() || '';
      if (/^Flow:/i.test(flowName)) flowName = flowName.replace(/^Flow:/i, '');
    }

    if (cat === 'FLOW_ELEMENT_BEGIN') {
      // |interviewId|FlowElementType|ElementApiName
      const elType = parts[3]?.trim() || '';
      const elName = parts[4]?.trim() || '';
      elements.push({ type: elType, name: elName, details: [], lineIdx: i });
    }

    if (cat === 'FLOW_RULE_DETAIL' && elements.length > 0) {
      // |interviewId|RuleName|outcome|...
      const ruleName = parts[3]?.trim() || '';
      const outcome  = parts[4]?.trim();
      const last = elements[elements.length - 1];
      last.details.push({ kind: 'rule', label: ruleName, value: outcome === 'true' ? '✓ true' : outcome === 'false' ? '✗ false' : outcome });
    }

    if (cat === 'FLOW_ASSIGNMENT_DETAIL' && elements.length > 0) {
      // |interviewId|Field|ASSIGN|Value
      const field = parts[3]?.trim() || '';
      const value = parts[5]?.trim() || parts[4]?.trim() || '';
      const last = elements[elements.length - 1];
      last.details.push({ kind: 'assign', label: field, value });
    }
  }

  if (elements.length === 0) {
    return '<div class="detail-src-not-found">No flow elements found in this span.</div>';
  }

  const FLOW_ICONS = {
    'FlowDecision':     { icon: '◆', color: '#f0c040', label: 'Decision' },
    'FlowAssignment':   { icon: '←', color: '#4a9eff', label: 'Assignment' },
    'FlowRecordUpdate': { icon: '✎', color: '#aa96da', label: 'Update Record' },
    'FlowRecordCreate': { icon: '+', color: '#2eb87e', label: 'Create Record' },
    'FlowRecordQuery':  { icon: '?', color: '#2eb87e', label: 'Get Records' },
    'FlowRecordDelete': { icon: '✕', color: '#d94545', label: 'Delete Record' },
    'FlowLoop':         { icon: '↻', color: '#4ecdc4', label: 'Loop' },
    'FlowSubflow':      { icon: '⊞', color: '#9b7fe8', label: 'Subflow' },
    'FlowScreen':       { icon: '☐', color: '#888',    label: 'Screen' },
  };

  const rows = elements.map(el => {
    const meta  = FLOW_ICONS[el.type] || { icon: '▸', color: '#888', label: el.type.replace('Flow', '') };
    const detailHtml = el.details.map(d => {
      const cls = d.kind === 'rule'
        ? (d.value.includes('true') ? 'flow-detail-true' : d.value.includes('false') ? 'flow-detail-false' : '')
        : 'flow-detail-assign';
      return `<div class="flow-detail ${cls}">
        <span class="flow-detail-label">${escapeHtml(d.label)}</span>
        <span class="flow-detail-value">${escapeHtml(d.value)}</span>
      </div>`;
    }).join('');
    const apiName = el.name.replace(/_/g, ' ');
    return `<div class="flow-element">
      <div class="flow-el-icon" style="background:${meta.color};">${meta.icon}</div>
      <div class="flow-el-body">
        <span class="flow-el-type">${escapeHtml(meta.label)}</span>
        <span class="flow-el-name">${escapeHtml(apiName)}</span>
        ${detailHtml}
      </div>
    </div>`;
  }).join('<div class="flow-connector"></div>');

  // Build Flow Builder link.
  // The Flow Builder URL uses lightning.force.com, not my.salesforce.com.
  // Format: https://{pod}.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId={id}
  let flowBuilderLink = '';
  if (currentOrgUrl) {
    const lightningBase = currentOrgUrl
      .replace(/\.my\.salesforce\.com\/?$/, '.lightning.force.com')
      .replace(/\.salesforce\.com\/?$/, '.lightning.force.com');
    if (flowId) {
      // 01I = FlowDefinition ID — open its Setup detail page which links to the active version
      // 301 = FlowVersion ID — can open directly in Flow Builder
      const isFlowVersion = flowId.startsWith('301');
      const url = isFlowVersion
        ? `${lightningBase}/builder_platform_interaction/flowBuilder.app?flowId=${flowId}`
        : `${lightningBase}/lightning/setup/Flows/page?address=%2F${flowId}`;
      const linkLabel = isFlowVersion ? 'Open in Flow Builder ↗' : 'Open flow in Setup ↗';
      flowBuilderLink = `<a class="flow-org-link" href="${escapeHtml(url)}" title="${linkLabel}">${linkLabel}</a>`;
    } else if (flowName) {
      // No ID — link to Flows list so user can find it by name
      const url = `${lightningBase}/lightning/setup/Flows/home`;
      flowBuilderLink = `<a class="flow-org-link" href="${escapeHtml(url)}" title="Open Flows list in Setup">Flows in Setup ↗</a>`;
    }
  }

  const title = `<div class="detail-src-header">
    <span class="detail-src-filename">${escapeHtml(flowName || 'Flow')}</span>
    ${flowBuilderLink}
  </div>`;

  return `${title}<div class="detail-src-lines flow-trace">${rows}</div>`;
}

// Returns true for class names that are Salesforce/Java platform internals, not user Apex
function isSystemClass(className) {
  if (!className) return true;
  // Platform patterns: all-lowercase, dot-separated, Java/SF system prefixes, generic collections
  if (/^(system|schema|database|limits|math|string|integer|long|boolean|date|datetime|list|map|set|sobject)\b/i.test(className)) return true;
  if (/^com\.salesforce\./i.test(className)) return true;
  if (/^(List|Map|Set|SObject)</.test(className)) return true;
  // Must start with an uppercase letter to be a user-defined Apex class
  if (!/^[A-Z]/.test(className)) return true;
  return false;
}

// For SOQL spans: find the Apex class that issued the query.
// Strategy: use the SOQL line's [srcLineNo] bracket directly — find the most-recent
// METHOD_ENTRY whose source-line bracket is ≤ soqlSrcLine AND which has not been
// closed by a matching METHOD_EXIT (matched by identical full signature string).
// Using the full sig for exit-matching is more reliable than counting by class alone.
function extractSourceInfoForSoql(soqlLineIdx) {
  const soqlLine = currentLogLines[soqlLineIdx] || '';
  const bracketM = soqlLine.match(/\|(\[\d+\])\|/);
  if (!bracketM) return null;
  const soqlSrcLine = parseInt(bracketM[1].slice(1, -1));

  // First pass (forward): walk outward from SOQL to collect exits
  // Actually scan backwards: track exits, cancel matching entries
  const exitStack = []; // exit sigs collected while scanning backwards
  const limit = Math.max(0, soqlLineIdx - 600);

  for (let i = soqlLineIdx - 1; i >= limit; i--) {
    const line = currentLogLines[i] || '';
    const parts = line.split('|');
    const cat = parts[1]?.trim();

    if (cat === 'METHOD_EXIT') {
      const sig = parts[4]?.trim() || parts[3]?.trim() || '';
      exitStack.push(sig);
      continue;
    }

    if (cat === 'METHOD_ENTRY') {
      const sig = parts[4]?.trim() || parts[3]?.trim() || '';
      // Remove the first matching exit (same as Python list.remove — removes earliest push)
      const exitIdx = exitStack.indexOf(sig);
      if (exitIdx !== -1) {
        exitStack.splice(exitIdx, 1);
        continue;
      }
      // No matching exit found — this frame is still active at the SOQL
      const classMatch = sig.match(/^([A-Z]\w*)\./);
      if (classMatch && !isSystemClass(classMatch[1])) {
        return { className: classMatch[1], lineNumber: soqlSrcLine };
      }
    }
  }
  return null;
}

// Parse a log line for a source reference: class name + line number.
// Only returns user-written Apex classes, not system/platform internals.
function extractSourceInfo(logLine) {
  const parts = logLine.split('|');
  const cat = parts[1]?.trim();
  if (!cat) return null;

  if (cat === 'METHOD_ENTRY' || cat === 'METHOD_EXIT') {
    // Format: |[lineNo]|SfId|ClassName.method()
    const lineRef = parts[2]?.match(/\[(\d+)\]/);
    const methodFull = parts[4]?.trim() || parts[3]?.trim() || '';
    const classMatch = methodFull.match(/^([A-Z]\w*)\./);
    if (classMatch && lineRef && !isSystemClass(classMatch[1])) {
      return { className: classMatch[1], lineNumber: parseInt(lineRef[1]) };
    }
  }
  if (cat === 'CODE_UNIT_STARTED') {
    // Trigger: |[EXTERNAL]|SfId|TriggerName on Object trigger event ...|path
    const path = parts[5]?.trim(); // e.g. __sfdc_trigger/SMT_OpportunityTrigger
    if (path) {
      const triggerMatch = path.match(/\/(\w+)$/);
      if (triggerMatch) return { className: triggerMatch[1], lineNumber: 1 };
    }
  }
  // SYSTEM_METHOD_ENTRY, SOQL_EXECUTE_BEGIN, DML_BEGIN etc. don't have user class refs
  return null;
}

function positionTooltip(ev, tooltip) {
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const tw = tooltip.offsetWidth || 260;
  const th = tooltip.offsetHeight || 80;
  if (x + tw > window.innerWidth - 8) x = ev.clientX - tw - pad;
  if (y + th > window.innerHeight - 8) y = ev.clientY - th - pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top  = y + 'px';
}

function renderCategoryLines(category, lines) {
  const container = document.getElementById('categoryDetails');
  if (!container) return;
  if (!lines || lines.length === 0) {
    container.innerHTML = `<div class="chart-panel"><h3>Lines for ${escapeHtml(category)}</h3><p class="muted">No matching lines found.</p></div>`;
    return;
  }

  const rows = lines
    .map((l) => `<div class="cat-line" data-line-index="${l.index}"><span class="cat-line-index">${l.index}</span> <span class="cat-line-text">${escapeHtml(l.text)}</span></div>`)
    .join('');

  container.innerHTML = `<div class="chart-panel"><h3>Lines for ${escapeHtml(category)}</h3><div class="chart-container">${rows}</div></div>`;

  // Copy line text to clipboard on click (editor not available in browser)
  const lineEls = container.querySelectorAll('.cat-line');
  lineEls.forEach((el) => {
    el.title = 'Click to copy line';
    el.addEventListener('click', () => {
      const text = el.querySelector('.cat-line-text')?.textContent || '';
      navigator.clipboard.writeText(text).catch(() => {});
      el.style.background = 'var(--vscode-editor-selectionBackground)';
      setTimeout(() => { el.style.background = ''; }, 600);
    });
  });
}

function renderNarrative(result) {
  // Sort execSteps by nanos, deduplicate flow steps
  const flowLabelSet = new Set(Object.values(result.flowNames));
  const steps = result.execSteps
    .filter(s => {
      if (s.type === 'flow' && flowLabelSet.size > 0) {
        return flowLabelSet.has(s.name);
      }
      return true;
    })
    .sort((a, b) => (a.nanos || 0) - (b.nanos || 0));

  if (steps.length === 0) {
    return '<p class="muted">Not enough data to summarise.</p>';
  }

  // ── Duration helpers ──────────────────────────────────────────────────────
  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    if (ms >= 1) return `${Math.round(ms)} ms`;
    return `<1 ms`;
  }

  // Derive per-step duration: gap to next step start (in nanos → ms)
  const totalNanos = steps.length > 1
    ? (steps[steps.length - 1].nanos || 0) - (steps[0].nanos || 0)
    : null;

  // ── Prose summary paragraph ───────────────────────────────────────────────
  function buildSummary() {
    const counts = {};
    for (const s of steps) {
      counts[s.type] = (counts[s.type] || 0) + 1;
    }
    const parts = [];
    const bt = counts['before-trigger'] || 0;
    const at = counts['after-trigger'] || 0;
    const vl = counts['validation'] || 0;
    const fl = counts['flow'] || 0;
    const dl = counts['dml'] || 0;
    const ds = counts['datasource'] || 0;

    // What triggered the execution?
    const allTriggerNames = steps
      .filter(s => s.type === 'before-trigger' || s.type === 'after-trigger')
      .map(s => {
        const m = s.name.match(/^(\S+)\s+on\s+(\S+)\s+trigger\s+event\s+(\S+)/i);
        return m ? m[2] : null;
      })
      .filter(Boolean);
    const triggerObjects = [...new Set(allTriggerNames)];

    if (triggerObjects.length > 0) {
      const eventTypes = [...new Set(steps
        .filter(s => s.type === 'before-trigger' || s.type === 'after-trigger')
        .map(s => { const m = s.name.match(/trigger\s+event\s+(\S+)/i); return m ? m[1] : null; })
        .filter(Boolean))];
      parts.push(`A <strong>${eventTypes.join(' / ')}</strong> event on <strong>${triggerObjects.join(', ')}</strong> started this transaction.`);
    } else {
      parts.push('This transaction executed without a DML trigger.');
    }

    const summary = [];
    if (bt + at > 0) summary.push(`${bt + at} trigger handler${bt + at > 1 ? 's' : ''} (${bt} before, ${at} after)`);
    if (vl > 0) {
      const failCount = result.validationRules.filter(r => r.result === 'fail').length;
      summary.push(`${vl} validation phase${vl > 1 ? 's' : ''}${failCount > 0 ? ` — <span class="narrative-error">${failCount} rule${failCount > 1 ? 's' : ''} failed</span>` : ''}`);
    }
    if (fl > 0) summary.push(`${fl} flow${fl > 1 ? 's' : ''}`);
    if (dl > 0) summary.push(`${dl} DML operation${dl > 1 ? 's' : ''}`);
    if (ds > 0) summary.push(`${ds} external data source call${ds > 1 ? 's' : ''}`);
    if (summary.length > 0) {
      parts.push(`It ran ${summary.join(', ')}.`);
    }
    if (result.execCount > 1) {
      parts.push(`This log captured <strong>${result.execCount} separate transactions</strong> for the same user session.`);
    }
    if (result.totalDurationMs) {
      parts.push(`Total time: <strong>${fmtMs(result.totalDurationMs)}</strong>.`);
    }
    return parts.join(' ');
  }

  // ── Step rendering ────────────────────────────────────────────────────────
  const TYPE_META = {
    'before-trigger': { dot: 'dot-trigger-before', label: 'Before Trigger' },
    'after-trigger':  { dot: 'dot-trigger-after',  label: 'After Trigger'  },
    'validation':     { dot: 'dot-validation',      label: 'Validation'     },
    'flow':           { dot: 'dot-flow',            label: 'Flow'           },
    'dml':            { dot: 'dot-dml',             label: 'DML'            },
    'datasource':     { dot: 'dot-datasource',      label: 'Data Source'    },
    'code-unit':      { dot: 'dot-code-unit',       label: 'Code'           },
  };

  // Count repetitions for design notes
  const stepCounts = {};
  steps.forEach(s => { stepCounts[s.name] = (stepCounts[s.name] || 0) + 1; });

  // Merge consecutive identical steps
  const merged = [];
  for (const s of steps) {
    const last = merged[merged.length - 1];
    if (last && last.name === s.name && last.type === s.type) {
      last.count++;
      last.nanosEnd = s.nanos;
    } else {
      merged.push({ ...s, count: 1, nanosEnd: s.nanos });
    }
  }

  function fmtStep(s, idx) {
    const meta = TYPE_META[s.type] || { dot: 'dot-code-unit', label: s.type };

    let title = '';
    let subtitle = '';
    let warningNote = '';

    if (s.type === 'before-trigger' || s.type === 'after-trigger') {
      const m = s.name.match(/^(\S+)\s+on\s+(\S+)\s+trigger\s+event\s+(\S+)/i);
      if (m) {
        title = `${escapeHtml(m[3])} on ${escapeHtml(m[2])}`;
        subtitle = escapeHtml(m[1]);
      } else {
        title = escapeHtml(s.name);
      }
    } else if (s.type === 'validation') {
      const obj = (s.name.split(':')[1] || '').trim();
      title = `Validation — ${escapeHtml(obj)}`;
      const ruleCount = result.validationRules.filter(r => r.object === obj).length;
      const failCount = result.validationRules.filter(r => r.object === obj && r.result === 'fail').length;
      if (ruleCount > 0) {
        subtitle = failCount > 0
          ? `${ruleCount} rules · <span class="narrative-error">${failCount} failed</span>`
          : `${ruleCount} rules · all passed`;
      }
    } else if (s.type === 'flow') {
      title = escapeHtml(s.name);
    } else if (s.type === 'dml') {
      title = escapeHtml(s.name);
      subtitle = s.rows !== null ? `${s.rows} row${s.rows === 1 ? '' : 's'}` : '';
    } else if (s.type === 'datasource') {
      title = escapeHtml(s.name.replace(/^ApexDataSource:\s*/i, ''));
    } else {
      title = escapeHtml(s.name);
    }

    const totalCount = stepCounts[s.name] || 1;
    if (totalCount > 1 && s.count === totalCount) {
      if (s.type.includes('trigger')) {
        warningNote = `<span class="narr-warning">Fired ${totalCount}× — check for unintended recursion</span>`;
      } else if (s.type === 'dml') {
        warningNote = `<span class="narr-warning">Ran ${totalCount}× — possible loop or cascade</span>`;
      }
    }

    const countBadge = s.count > 1
      ? `<span class="narr-badge">${s.count}×</span>`
      : '';

    // Show step number
    const stepNum = `<span class="narr-step-num">${idx + 1}</span>`;

    return `
      <div class="narr-step narr-step-${s.type}" data-line-index="${s.lineIndex}">
        <div class="narr-left">
          ${stepNum}
          <span class="narr-dot ${meta.dot}"></span>
          <span class="narr-connector"></span>
        </div>
        <div class="narr-content">
          <div class="narr-header">
            <span class="narr-type-pill narr-pill-${s.type}">${meta.label}</span>
            <span class="narr-title">${title}${countBadge}</span>
          </div>
          ${subtitle ? `<div class="narr-subtitle">${subtitle}</div>` : ''}
          ${warningNote}
        </div>
      </div>`;
  }

  const summaryHtml = buildSummary();
  // Group merged steps by execution context
  const execGroups = [];
  for (const s of merged) {
    const execNum = s.exec || 1;
    let group = execGroups.find(g => g.exec === execNum);
    if (!group) { group = { exec: execNum, steps: [] }; execGroups.push(group); }
    group.steps.push(s);
  }

  let globalIdx = 0;
  let stepsHtml = '';
  const COMPACT_LIMITS = [
    { key: 'Number of SOQL queries',   label: 'SOQL',     max: 100 },
    { key: 'Number of DML statements', label: 'DML',      max: 150 },
    { key: 'Maximum CPU time',         label: 'CPU',      max: 10000, unit: 'ms' },
    { key: 'Number of DML rows',       label: 'DML rows', max: 10000 },
    { key: 'Number of callouts',       label: 'Callouts',      max: 100 },
    { key: 'Number of future calls',   label: 'Future calls',  max: 50 },
    { key: 'Number of Email Invocations', label: 'Emails',     max: 10 },
  ];

  function fmtLimits(execNum) {
    const data = result.limitDataPerExec && result.limitDataPerExec[execNum];
    if (!data) return '';
    const chips = COMPACT_LIMITS.map(lk => {
      const entry = data[lk.key];
      if (!entry || entry.used === 0) return null;
      const max = entry.max || lk.max;
      const pct = Math.min(100, Math.round((entry.used / max) * 100));
      const level = pct >= 80 ? 'danger' : pct >= 50 ? 'warn' : 'ok';
      const valStr = lk.unit ? `${entry.used.toLocaleString()} ${lk.unit}` : entry.used.toLocaleString();
      const maxStr = `${max.toLocaleString()}${lk.unit ? ' ' + lk.unit : ''}`;
      return `<span class="narr-limit-chip narr-limit-${level}" title="${lk.label}: ${valStr} of ${maxStr} (${pct}%)">
        <span class="narr-limit-name">${lk.label}</span>
        <span class="narr-limit-val">${valStr}</span>
        <span class="narr-limit-of">/ ${maxStr}</span>
      </span>`;
    }).filter(Boolean);
    if (chips.length === 0) return '';
    return `<div class="narr-limits">
      <span class="narr-limits-label">Governor limits consumed</span>
      <div class="narr-limits-chips">${chips.join('')}</div>
    </div>`;
  }

  if (execGroups.length > 1) {
    for (const group of execGroups) {
      const label = `Transaction ${group.exec} of ${execGroups.length}`;
      stepsHtml += `<div class="narr-exec-divider"><span class="narr-exec-label">${label}</span></div>`;
      stepsHtml += fmtLimits(group.exec);
      stepsHtml += group.steps.map(s => fmtStep(s, globalIdx++)).join('');
    }
  } else {
    stepsHtml = merged.map((s, i) => fmtStep(s, i)).join('');
    stepsHtml += fmtLimits(1);
  }

  return `
    <div class="narrative">
      <div class="narr-summary">${summaryHtml}</div>
      <div class="narr-steps">${stepsHtml}</div>
    </div>`;
}

function refreshReportNBA() {
  const nbaEl = document.getElementById('rpt-nba-section');
  if (!nbaEl) return;
  nbaEl.innerHTML = renderNBA(currentScanFindings, currentStaticFindings);
}

function renderNBA(runtimeFindings, staticViolations) {
  // Build a prioritised list of next best actions from both sources
  const actions = [];

  // ── From runtime findings ──────────────────────────────────────────────────
  for (const f of runtimeFindings) {
    if (f.severity === 'critical') {
      actions.push({ priority: 1, source: 'runtime', icon: '🔴', title: f.rule, body: f.message, detail: f.detail });
    } else if (f.severity === 'warning') {
      actions.push({ priority: 2, source: 'runtime', icon: '🟡', title: f.rule, body: f.message, detail: f.detail });
    } else if (f.severity === 'info') {
      actions.push({ priority: 3, source: 'runtime', icon: '🔵', title: f.rule, body: f.message, detail: f.detail });
    }
  }

  // ── From static analysis (if run) ─────────────────────────────────────────
  if (staticViolations !== null) {
    // Group static by rule, pick top issues by severity then count
    const ruleMap = {};
    for (const v of staticViolations) {
      if (!v.rule || (v.rule === 'UninstantiableEngineError')) continue;
      if (!ruleMap[v.rule]) ruleMap[v.rule] = { sev: v.severity, count: 0, message: v.message, resource: v.resources?.[0], engine: v.engine, tags: v.tags };
      ruleMap[v.rule].count++;
    }
    // Top critical/high static rules (sev 1-2), up to 5
    const critRules = Object.entries(ruleMap)
      .filter(([,v]) => v.sev <= 2)
      .sort((a,b) => b[1].count - a[1].count)
      .slice(0, 5);
    for (const [rule, info] of critRules) {
      actions.push({
        priority: 1, source: 'static', icon: '🔴',
        title: `${rule} (${info.count} occurrence${info.count > 1 ? 's' : ''})`,
        body: info.message,
        detail: `Detected by ${info.engine || 'Code Analyzer'} static analysis.`,
        link: info.resource,
      });
    }
    // Top medium rules, up to 3
    const medRules = Object.entries(ruleMap)
      .filter(([,v]) => v.sev === 3)
      .sort((a,b) => b[1].count - a[1].count)
      .slice(0, 3);
    for (const [rule, info] of medRules) {
      actions.push({
        priority: 2, source: 'static', icon: '🟡',
        title: `${rule} (${info.count} occurrence${info.count > 1 ? 's' : ''})`,
        body: info.message,
        detail: `Detected by ${info.engine || 'Code Analyzer'} static analysis.`,
        link: info.resource,
      });
    }
  }

  if (actions.length === 0 && staticViolations === null) {
    return `<div class="rpt-nba-placeholder">
      <span class="rpt-nba-placeholder-icon">⚡</span>
      <div>
        <strong>Run Code Scan for personalised recommendations</strong><br>
        <span style="font-size:0.82rem;color:var(--vscode-descriptionForeground);">
          Once you run the static analysis in the Code Scan tab, this section will show prioritised next best actions based on both runtime behaviour and code quality findings.
        </span>
      </div>
    </div>`;
  }

  if (actions.length === 0) {
    return `<div class="rpt-concern rpt-concern-good">✓ No actions required — runtime and static analysis found no significant issues.</div>`;
  }

  // Sort by priority then source (runtime first)
  actions.sort((a, b) => a.priority - b.priority || (a.source === 'runtime' ? -1 : 1));

  return actions.map((a, i) => `
    <div class="rpt-nba-item rpt-nba-p${a.priority}">
      <div class="rpt-nba-num">${i + 1}</div>
      <div class="rpt-nba-body">
        <div class="rpt-nba-header">
          <span class="rpt-nba-icon">${a.icon}</span>
          <span class="rpt-nba-title">${escapeHtml(a.title)}</span>
          <span class="rpt-nba-source">${a.source === 'static' ? 'Static' : 'Runtime'}</span>
          ${a.link ? `<a class="scan-resource-link" href="${escapeHtml(a.link)}" onclick="vscode.postMessage({type:'openExternal',url:'${escapeHtml(a.link)}'});return false;">Docs ↗</a>` : ''}
        </div>
        <div class="rpt-nba-msg">${escapeHtml(a.body || '')}</div>
        ${a.detail ? `<div class="rpt-nba-detail">${escapeHtml(a.detail)}</div>` : ''}
      </div>
    </div>`).join('');
}

function renderReport(result) {
  const ms = result.totalDurationMs || 0;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function pct(used, max) { return max > 0 ? Math.min(100, Math.round(used / max * 100)) : 0; }
  function fmtMs(v) {
    if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
    return `${Math.round(v)} ms`;
  }
  function miniBar(usedPct, color) {
    const level = usedPct >= 80 ? '#e05555' : usedPct >= 50 ? '#e8a020' : color;
    return `<div class="rpt-bar-track"><div class="rpt-bar-fill" style="width:${usedPct}%;background:${level};"></div></div>`;
  }

  // ── Performance verdict ────────────────────────────────────────────────────
  let verdict, verdictClass, verdictIcon;
  if (ms === 0)          { verdict = 'Unknown';  verdictClass = 'neutral'; verdictIcon = '—'; }
  else if (ms < 1000)    { verdict = 'Fast';     verdictClass = 'good';    verdictIcon = '✓'; }
  else if (ms < 3000)    { verdict = 'Moderate'; verdictClass = 'warn';    verdictIcon = '◎'; }
  else if (ms < 8000)    { verdict = 'Slow';     verdictClass = 'bad';     verdictIcon = '⚠'; }
  else                   { verdict = 'Very slow'; verdictClass = 'bad';    verdictIcon = '✕'; }

  // ── Concerns ──────────────────────────────────────────────────────────────
  const concerns = [];

  // Governor limit proximity
  const LIMIT_CHECKS = [
    { key: 'Number of SOQL queries',   label: 'SOQL queries',      max: 100 },
    { key: 'Number of DML statements', label: 'DML statements',    max: 150 },
    { key: 'Maximum CPU time',         label: 'CPU time',          max: 10000 },
    { key: 'Number of DML rows',       label: 'DML rows',          max: 10000 },
    { key: 'Number of callouts',       label: 'Callouts',          max: 100 },
    { key: 'Number of future calls',   label: 'Future calls',      max: 50 },
    { key: 'Maximum heap size',        label: 'Heap size',         max: 6000000 },
  ];
  for (const lk of LIMIT_CHECKS) {
    const entry = result.limitData[lk.key];
    if (!entry) continue;
    const p = pct(entry.used, entry.max || lk.max);
    if (p >= 80) concerns.push({ level: 'critical', text: `${lk.label} at ${p}% of limit (${entry.used.toLocaleString()} / ${(entry.max || lk.max).toLocaleString()})` });
    else if (p >= 50) concerns.push({ level: 'warn', text: `${lk.label} at ${p}% of limit` });
  }

  // Validation failures
  const failedRules = result.validationRules.filter(r => r.result === 'fail');
  if (failedRules.length > 0) {
    concerns.push({ level: 'critical', text: `${failedRules.length} validation rule${failedRules.length > 1 ? 's' : ''} failed: ${failedRules.map(r => r.name || r.id).slice(0, 3).join(', ')}${failedRules.length > 3 ? '…' : ''}` });
  }

  // Repeated triggers — group by trigger+object ignoring event type (same fix as scanFindings)
  const triggerCounts = {};
  result.execSteps.filter(s => s.type === 'before-trigger' || s.type === 'after-trigger')
    .forEach(s => {
      const m = s.name.match(/^(\S+)\s+on\s+(\S+)/i);
      const key = m ? `${m[1]} on ${m[2]}` : s.name;
      triggerCounts[key] = (triggerCounts[key] || 0) + 1;
    });
  for (const [key, count] of Object.entries(triggerCounts)) {
    if (count > 1) {
      concerns.push({ level: 'warn', text: `Trigger "${key}" fired ${count}× — possible recursion` });
    }
  }

  // Multiple transactions — only show if not already obvious from prose summary
  // (prose already says "This log captured N separate transactions" so skip here)

  // Errors
  if (result.errors > 0) {
    concerns.push({ level: 'critical', text: `${result.errors} error${result.errors > 1 ? 's' : ''} / exception${result.errors > 1 ? 's' : ''} thrown` });
  }

  // High method count relative to code units
  if (result.methodEntry > 500) {
    concerns.push({ level: 'info', text: `${result.methodEntry.toLocaleString()} method calls — deep call stack may indicate over-engineering` });
  }

  // CPU vs total time ratio
  const cpuEntry = result.limitData['Maximum CPU time'];
  if (cpuEntry && ms > 0) {
    const cpuRatio = Math.round(cpuEntry.used / ms * 100);
    if (cpuRatio < 15 && ms > 2000) {
      concerns.push({ level: 'info', text: `Only ${cpuRatio}% of total time was Apex CPU — remaining ${100 - cpuRatio}% is platform overhead (DB, sharing, locks)` });
    }
  }

  const concernsHtml = concerns.length === 0
    ? `<div class="rpt-concern rpt-concern-good">✓ No significant concerns detected</div>`
    : concerns.map(c => `<div class="rpt-concern rpt-concern-${c.level}">
        <span class="rpt-concern-icon">${c.level === 'critical' ? '✕' : c.level === 'warn' ? '⚠' : 'ℹ'}</span>
        <span>${escapeHtml(c.text)}</span>
      </div>`).join('');

  // ── Executive summary prose ────────────────────────────────────────────────
  const triggerObjects = [...new Set(result.execSteps
    .filter(s => s.type === 'before-trigger' || s.type === 'after-trigger')
    .map(s => { const m = s.name.match(/on\s+(\S+)\s+trigger/i); return m ? m[1] : null; })
    .filter(Boolean))];
  const eventTypes = [...new Set(result.execSteps
    .filter(s => s.type === 'before-trigger' || s.type === 'after-trigger')
    .map(s => { const m = s.name.match(/trigger\s+event\s+(\S+)/i); return m ? m[1] : null; })
    .filter(Boolean))];

  const flowCount  = result.execSteps.filter(s => s.type === 'flow').length;
  const dmlCount   = result.execSteps.filter(s => s.type === 'dml').length;
  const valCount   = result.execSteps.filter(s => s.type === 'validation').length;
  const btCount    = result.execSteps.filter(s => s.type === 'before-trigger').length;
  const atCount    = result.execSteps.filter(s => s.type === 'after-trigger').length;

  let summaryProse = '';
  if (triggerObjects.length > 0) {
    summaryProse += `A <strong>${eventTypes.join(' / ')}</strong> event on <strong>${triggerObjects.join(', ')}</strong> triggered this execution. `;
  }
  summaryProse += `The transaction took <strong>${fmtMs(ms)}</strong> total`;
  if (cpuEntry) summaryProse += `, of which <strong>${fmtMs(cpuEntry.used)} was Apex CPU</strong> time`;
  summaryProse += '. ';
  const parts = [];
  if (btCount + atCount > 0) parts.push(`${btCount + atCount} trigger handler${btCount + atCount > 1 ? 's' : ''}`);
  if (valCount > 0) parts.push(`${valCount} validation phase${valCount > 1 ? 's' : ''}`);
  if (flowCount > 0) parts.push(`${flowCount} flow${flowCount > 1 ? 's' : ''}`);
  if (dmlCount > 0) parts.push(`${dmlCount} DML operation${dmlCount > 1 ? 's' : ''}`);
  if (result.soqlBegin > 0) parts.push(`${result.soqlBegin} SOQL quer${result.soqlBegin > 1 ? 'ies' : 'y'}`);
  if (parts.length > 0) summaryProse += `It ran ${parts.join(', ')}.`;
  if (failedRules.length > 0) summaryProse += ` <strong class="rpt-red">${failedRules.length} validation rule${failedRules.length > 1 ? 's' : ''} failed.</strong>`;
  else if (result.validationRules.length > 0) summaryProse += ` All ${result.validationRules.length} validation rules passed.`;

  // ── Governor limits table ──────────────────────────────────────────────────
  const limitsHtml = LIMIT_CHECKS.map(lk => {
    const entry = result.limitData[lk.key];
    if (!entry) return '';
    const max = entry.max || lk.max;
    const p = pct(entry.used, max);
    return `<div class="rpt-limit-row">
      <span class="rpt-limit-name">${escapeHtml(lk.label)}</span>
      ${miniBar(p, '#4a9eff')}
      <span class="rpt-limit-nums ${p >= 80 ? 'rpt-red' : p >= 50 ? 'rpt-amber' : ''}">${entry.used.toLocaleString()} <span class="rpt-limit-max">/ ${max.toLocaleString()}</span></span>
      <span class="rpt-limit-pct ${p >= 80 ? 'rpt-red' : p >= 50 ? 'rpt-amber' : 'rpt-muted'}">${p}%</span>
    </div>`;
  }).filter(Boolean).join('');

  // ── Time breakdown bar ────────────────────────────────────────────────────
  const STEP_COLORS = {
    'before-trigger': '#3ca0c8', 'after-trigger': '#e07b39', 'validation': '#f0c040',
    'flow': '#9b7fe8', 'dml': '#aa96da', 'datasource': '#5ca0c8', 'code-unit': '#4a9eff',
  };
  const typeNanos = {};
  for (const s of result.execSteps) {
    if (s.nanos !== null && s.nanos !== undefined) {
      typeNanos[s.type] = (typeNanos[s.type] || 0) + 1;
    }
  }
  const stepTypeCounts = {};
  for (const s of result.execSteps) stepTypeCounts[s.type] = (stepTypeCounts[s.type] || 0) + 1;
  const totalSteps = result.execSteps.length || 1;
  const breakdownBars = Object.entries(stepTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const w = Math.max(1, Math.round(count / totalSteps * 100));
      const color = STEP_COLORS[type] || '#666';
      const label = type.replace(/-/g, ' ');
      return `<div class="rpt-breakdown-seg" style="width:${w}%;background:${color};" title="${label}: ${count}"></div>`;
    }).join('');

  const breakdownLegend = Object.entries(stepTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const color = STEP_COLORS[type] || '#666';
      const label = type.replace(/-/g, ' ');
      return `<span class="rpt-legend-item"><span class="rpt-legend-dot" style="background:${color};"></span>${escapeHtml(label)} <strong>${count}</strong></span>`;
    }).join('');

  // ── DML summary ────────────────────────────────────────────────────────────
  const dmlSummary = {};
  for (const d of result.dmlOps) {
    const key = `${d.op} ${d.type}`;
    if (!dmlSummary[key]) dmlSummary[key] = { count: 0, rows: 0 };
    dmlSummary[key].count++;
    dmlSummary[key].rows += d.rows || 0;
  }
  const dmlRows = Object.entries(dmlSummary).map(([key, v]) =>
    `<tr><td>${escapeHtml(key)}</td><td>${v.count}</td><td>${v.rows.toLocaleString()}</td></tr>`
  ).join('');

  // ── SOQL objects ───────────────────────────────────────────────────────────
  const soqlObjectChips = result.soqlObjects.length > 0
    ? result.soqlObjects.map(o => `<span class="rpt-chip">${escapeHtml(o)}</span>`).join('')
    : '<span class="rpt-muted">None detected</span>';

  // ── Summary headline ───────────────────────────────────────────────────────
  // Build a 1-line headline that captures the most important fact
  let headline = '';
  if (result.errors > 0) {
    headline = `${result.errors} error${result.errors > 1 ? 's' : ''} thrown during execution`;
  } else if (failedRules.length > 0) {
    headline = `${failedRules.length} validation rule${failedRules.length > 1 ? 's' : ''} failed`;
  } else if (ms > 8000) {
    headline = `Execution was very slow at ${fmtMs(ms)}`;
  } else if (ms > 3000) {
    headline = `Execution took ${fmtMs(ms)} — review for optimisation`;
  } else {
    headline = `Execution completed in ${fmtMs(ms)} with no errors`;
  }

  return `
  <div class="rpt-page">

    <div class="rpt-section rpt-hero">
      <div class="rpt-verdict rpt-verdict-${verdictClass}">
        <span class="rpt-verdict-icon">${verdictIcon}</span>
        <div>
          <div class="rpt-verdict-label">Performance</div>
          <div class="rpt-verdict-value">${verdict}</div>
        </div>
        <div class="rpt-verdict-time">${fmtMs(ms)}</div>
      </div>
      <div class="rpt-exec-headline">${escapeHtml(headline)}</div>
      <div class="rpt-exec-summary">${summaryProse}</div>
      ${concerns.length > 0 ? `<div class="rpt-concerns rpt-concerns-inline">${concerns.map(c => `<div class="rpt-concern rpt-concern-${c.level}"><span class="rpt-concern-icon">${c.level === 'critical' ? '✕' : c.level === 'warn' ? '⚠' : 'ℹ'}</span><span>${escapeHtml(c.text)}</span></div>`).join('')}</div>` : ''}
    </div>

    <div class="rpt-section">
      <div class="rpt-section-title">Next Best Actions</div>
      <div id="rpt-nba-section">${renderNBA(result.scanFindings, currentStaticFindings)}</div>
    </div>

    <div class="rpt-two-col">
      <div class="rpt-section">
        <div class="rpt-section-title">Governor Limits</div>
        <div class="rpt-limits">${limitsHtml || '<span class="rpt-muted">No limit data in log</span>'}</div>
      </div>
      <div class="rpt-section">
        <div class="rpt-section-title">Execution Breakdown</div>
        <div class="rpt-breakdown-bar">${breakdownBars}</div>
        <div class="rpt-legend">${breakdownLegend}</div>
        <div class="rpt-stats-mini">
          <div class="rpt-stat"><span class="rpt-stat-val">${result.soqlBegin}</span><span class="rpt-stat-lbl">SOQL queries</span></div>
          <div class="rpt-stat"><span class="rpt-stat-val">${result.dmlBegin}</span><span class="rpt-stat-lbl">DML operations</span></div>
          <div class="rpt-stat"><span class="rpt-stat-val">${result.codeUnitStarted}</span><span class="rpt-stat-lbl">Code units</span></div>
          <div class="rpt-stat"><span class="rpt-stat-val">${result.methodEntry.toLocaleString()}</span><span class="rpt-stat-lbl">Method calls</span></div>
          <div class="rpt-stat"><span class="rpt-stat-val ${result.errors > 0 ? 'rpt-red' : ''}">${result.errors}</span><span class="rpt-stat-lbl">Errors</span></div>
          <div class="rpt-stat"><span class="rpt-stat-val">${result.execCount}</span><span class="rpt-stat-lbl">Transactions</span></div>
        </div>
      </div>
    </div>

    ${dmlRows ? `
    <div class="rpt-section">
      <div class="rpt-section-title">DML Operations</div>
      <table class="rpt-table">
        <thead><tr><th>Operation</th><th>Count</th><th>Rows</th></tr></thead>
        <tbody>${dmlRows}</tbody>
      </table>
    </div>` : ''}

    <div class="rpt-section">
      <div class="rpt-section-title">Objects Queried via SOQL</div>
      <div class="rpt-chips">${soqlObjectChips}</div>
    </div>

    ${result.validationRules.length > 0 ? `
    <div class="rpt-section">
      <div class="rpt-section-title">Validation Rules</div>
      <div class="rpt-val-summary">
        <div class="rpt-val-stat rpt-val-pass">
          <span class="rpt-val-num">${result.validationRules.filter(r => r.result === 'pass').length}</span>
          <span class="rpt-val-lbl">Passed</span>
        </div>
        <div class="rpt-val-stat rpt-val-fail">
          <span class="rpt-val-num">${failedRules.length}</span>
          <span class="rpt-val-lbl">Failed</span>
        </div>
        <div class="rpt-val-stat">
          <span class="rpt-val-num">${result.validationRules.length}</span>
          <span class="rpt-val-lbl">Total</span>
        </div>
      </div>
      ${failedRules.length > 0 ? `
        <div class="rpt-section-subtitle">Failed rules</div>
        ${failedRules.map(r => `<div class="rpt-failed-rule">
          <span class="rpt-failed-name">${escapeHtml(r.name || r.id)}</span>
          ${r.object ? `<span class="rpt-chip rpt-chip-sm">${escapeHtml(r.object)}</span>` : ''}
          ${r.errorMessage ? `<div class="rpt-failed-msg">${escapeHtml(r.errorMessage)}</div>` : ''}
        </div>`).join('')}
      ` : ''}
    </div>` : ''}

  </div>`;
}

function renderStaticScanResults(msg) {
  const btn = document.getElementById('scan-run-static-btn');
  const statusEl = document.getElementById('scan-static-status');
  const resultsEl = document.getElementById('scan-static-results');
  if (btn) { btn.disabled = false; btn.textContent = 'Re-run Static Analysis'; }
  if (!resultsEl) return;

  // Store for report NBA section
  if (!msg.error && !msg.notInstalled) {
    currentStaticFindings = msg.violations || [];
    refreshReportNBA();
  }

  if (msg.notInstalled) {
    if (statusEl) statusEl.textContent = '';
    // Show runtime findings inline with a note about getting more via sf scanner
    const findings = currentScanFindings;
    const findingsHtml = findings.length === 0
      ? `<div class="scan-clean"><div class="scan-clean-icon">✓</div><div class="scan-clean-title">No runtime issues detected</div></div>`
      : findings.sort((a, b) => ({'critical':0,'warning':1,'info':2}[a.severity]||9) - ({'critical':0,'warning':1,'info':2}[b.severity]||9))
          .map((f, i) => {
            const sev = {critical:{cls:'scan-sev-critical',label:'Critical',icon:'✕'},warning:{cls:'scan-sev-warning',label:'Warning',icon:'⚠'},info:{cls:'scan-sev-info',label:'Info',icon:'ℹ'}}[f.severity]||{cls:'scan-sev-info',label:'Info',icon:'ℹ'};
            const catMeta = SCAN_CATEGORY_META[f.category]||{label:f.category,icon:'•',color:'#888'};
            return `<div class="scan-finding scan-finding-${f.severity}">
              <div class="scan-finding-header">
                <span class="scan-sev-badge ${sev.cls}">${sev.icon} ${sev.label}</span>
                <span class="scan-cat-label" style="color:${catMeta.color};">${catMeta.icon} ${catMeta.label}</span>
                <span class="scan-rule-name">${escapeHtml(f.rule)}</span>
                ${f.lineIndex !== null ? `<span class="scan-line-ref">Line ${f.lineIndex}</span>` : ''}
              </div>
              <div class="scan-finding-msg">${escapeHtml(f.message)}</div>
              ${f.detail ? `<div class="scan-finding-detail">${escapeHtml(f.detail)}</div>` : ''}
            </div>`;
          }).join('');
    resultsEl.innerHTML = `
      <div class="scan-not-installed-note">
        <strong>Salesforce Code Analyzer not installed.</strong>
        Showing runtime analysis only — issues detected from the actual execution.<br>
        Install the Code Analyzer CLI plugin for deeper static analysis (PMD, security, complexity rules):<br>
        <code>sf plugins install @salesforce/plugin-code-analyzer</code>
      </div>
      <div class="scan-findings" style="margin-top:12px;">${findingsHtml}</div>`;
    return;
  }

  if (msg.error) {
    if (statusEl) statusEl.textContent = '';
    resultsEl.innerHTML = `<div class="scan-static-error">${escapeHtml(msg.error)}</div>`;
    return;
  }

  const violations = msg.violations || [];
  if (statusEl) statusEl.textContent = '';

  if (violations.length === 0) {
    resultsEl.innerHTML = `<div class="scan-clean"><div class="scan-clean-icon">✓</div><div class="scan-clean-title">No violations found</div></div>`;
    return;
  }

  const SEV_SECTIONS = [
    { sevs: [1, 2], key: 'critical', label: 'Critical & High',  badgeCls: 'scan-sev-critical', color: '#e05555',
      desc: 'Must fix — these represent security vulnerabilities, potential data loss, or logic errors likely to cause failures in production.' },
    { sevs: [3],    key: 'medium',   label: 'Medium',           badgeCls: 'scan-sev-warning',  color: '#e8a020',
      desc: 'Should fix — code quality issues that increase risk, reduce maintainability, or may cause subtle bugs under edge conditions.' },
    { sevs: [4],    key: 'low',      label: 'Low',              badgeCls: 'scan-sev-info',     color: '#4a9eff',
      desc: 'Good to fix — best practice violations and style issues that don\'t pose immediate risk but reduce code clarity.' },
    { sevs: [5],    key: 'info',     label: 'Info',             badgeCls: 'scan-sev-info',     color: '#888',
      desc: 'Informational — minor style notes such as trailing whitespace or missing documentation. Low priority.' },
  ];

  // Separate engine/tool errors from real code violations
  const engineErrors = violations.filter(v => v.rule === 'UninstantiableEngineError' || !v.locations?.length);
  const codeViols    = violations.filter(v => v.rule !== 'UninstantiableEngineError' && v.locations?.length > 0);

  // Attach loc to each code violation
  const enriched = codeViols.map(v => ({
    ...v,
    loc: v.locations?.[v.primaryLocationIndex ?? 0] || v.locations?.[0],
  }));

  // Show engine setup warnings if any
  const engineWarningsHtml = engineErrors.length > 0
    ? engineErrors.map(e => {
        const rawMsg = e.message || '';
        const engine = (e.engine || 'unknown').toLowerCase();
        // Translate known engine errors into plain English
        let title, explanation, fix;
        if (engine === 'flow' && rawMsg.includes('python')) {
          title = 'Flow analysis skipped — Python 3.10+ not found';
          explanation = 'The Code Analyzer flow engine scans Salesforce Flow metadata files (.flow-meta.xml) for issues, but it requires Python 3.10 or later, which is not installed (or not on your PATH). The Apex results above are complete and unaffected.';
          fix = `<strong>To fix:</strong> install Python 3.10+ using one of these options:<br>
• <strong>macOS (recommended):</strong> <code>brew install python3</code> — requires <a href="https://brew.sh" onclick="vscode.postMessage({type:'openExternal',url:'https://brew.sh'});return false;">Homebrew</a><br>
• <strong>Windows:</strong> download from <a href="https://www.python.org/downloads/" onclick="vscode.postMessage({type:'openExternal',url:'https://www.python.org/downloads/'});return false;">python.org/downloads</a> — tick "Add to PATH" during install<br>
• <strong>Not interested in Flow scanning?</strong> Add this to a <code>code-analyzer.yml</code> file at your project root to silence this warning permanently:<br>
<code style="display:block;margin-top:4px;padding:6px 8px;white-space:pre;">engines:\n  flow:\n    disable_engine: true</code>`;
        } else {
          title = `Engine skipped (${escapeHtml(engine)})`;
          explanation = rawMsg.split(/\s+at\s+/)[0].trim().substring(0, 300);
          fix = null;
        }
        return `<div class="scan-engine-warning">
          <span class="scan-engine-warning-label">⚠ ${escapeHtml(title)}</span>
          <span class="scan-engine-warning-body">${escapeHtml(explanation || '')}</span>
          ${fix ? `<span class="scan-engine-warning-fix">${fix}</span>` : ''}

        </div>`;
      }).join('')
    : '';

  const fileCount = new Set(enriched.map(v => v.loc?.file || '?')).size;
  const critHighCount = enriched.filter(v => v.severity <= 2).length;
  const medCount      = enriched.filter(v => v.severity === 3).length;
  const lowCount      = enriched.filter(v => v.severity === 4).length;
  const infoCount     = enriched.filter(v => v.severity === 5).length;
  const summary = `<div class="scan-static-summary">
    Found <strong>${enriched.length} violation${enriched.length !== 1 ? 's' : ''}</strong> across ${fileCount} file${fileCount !== 1 ? 's' : ''}
    ${critHighCount ? `· <span style="color:#e05555">${critHighCount} critical/high</span>` : ''}
    ${medCount      ? `· <span style="color:#e8a020">${medCount} medium</span>` : ''}
    ${lowCount      ? `· <span style="color:#4a9eff">${lowCount} low</span>` : ''}
    ${infoCount     ? `· <span style="color:#888">${infoCount} info</span>` : ''}
    ${msg.versions?.['code-analyzer'] ? `<span class="scan-version">Code Analyzer v${escapeHtml(msg.versions['code-analyzer'])}</span>` : ''}
  </div>`;

  const sevBlocks = SEV_SECTIONS.map(sec => {
    const viols = enriched.filter(v => sec.sevs.includes(v.severity || 5));
    if (viols.length === 0) return '';

    // Group by rule → file → lines
    const byRule = {};
    for (const v of viols) {
      const rule = v.rule || 'Unknown';
      const file = (v.loc?.file || '').split(/[\\/]/).pop() || 'unknown';
      const fullFile = v.loc?.file || '';
      if (!byRule[rule]) byRule[rule] = { engine: v.engine, tags: v.tags, message: v.message, resource: v.resources?.[0], files: {} };
      if (!byRule[rule].files[file]) byRule[rule].files[file] = { fullFile, lines: [] };
      if (v.loc?.startLine) byRule[rule].files[file].lines.push(v.loc.startLine);
    }

    const ruleCards = Object.entries(byRule)
      .sort((a, b) => {
        // Sort by total occurrence count desc
        const ca = Object.values(a[1].files).reduce((s, f) => s + Math.max(1, f.lines.length), 0);
        const cb = Object.values(b[1].files).reduce((s, f) => s + Math.max(1, f.lines.length), 0);
        return cb - ca;
      })
      .map(([rule, info]) => {
        const totalHits = Object.values(info.files).reduce((s, f) => s + Math.max(1, f.lines.length), 0);
        const tags = (info.tags || []).filter(t => t !== 'Recommended').slice(0, 2)
          .map(t => `<span class="scan-tag">${escapeHtml(t)}</span>`).join('');
        const fileRows = Object.entries(info.files).map(([shortFile, fd]) => {
          const lineChips = fd.lines.sort((a,b)=>a-b).map(l =>
            `<span class="scan-line-chip">L${l}</span>`).join('');
          return `<div class="scan-rule-file-row">
            <span class="scan-viol-file">${escapeHtml(shortFile)}</span>
            <span class="scan-line-chips">${lineChips || '<span class="scan-line-chip">—</span>'}</span>
          </div>`;
        }).join('');
        return `<div class="scan-rule-card">
          <div class="scan-rule-card-header">
            <span class="scan-rule-name">${escapeHtml(rule)}</span>
            <span class="scan-rule-hit-count">${totalHits}×</span>
            <span class="scan-engine-label">${escapeHtml(info.engine || '')}</span>
            ${tags}
            ${info.resource ? `<a class="scan-resource-link" href="${escapeHtml(info.resource)}" onclick="vscode.postMessage({type:'openExternal',url:'${escapeHtml(info.resource)}'});return false;">Docs ↗</a>` : ''}
          </div>
          <div class="scan-finding-msg">${escapeHtml(info.message || '')}</div>
          <div class="scan-rule-files">${fileRows}</div>
        </div>`;
      }).join('');

    return `<div class="scan-sev-section">
      <div class="scan-sev-section-header" style="border-left-color:${sec.color};">
        <span class="scan-sev-section-title" style="color:${sec.color};">${sec.label}</span>
        <span class="scan-sev-section-count">${viols.length}</span>
        <span class="scan-sev-section-desc">${escapeHtml(sec.desc)}</span>
      </div>
      <div class="scan-sev-section-body">${ruleCards}</div>
    </div>`;
  }).join('');

  resultsEl.innerHTML = engineWarningsHtml + summary + (enriched.length === 0
    ? `<div class="scan-clean"><div class="scan-clean-icon">✓</div><div class="scan-clean-title">No code violations found</div></div>`
    : sevBlocks);
}

const SCAN_CATEGORY_META = {
  performance: { label: 'Performance',  color: '#e07b39', icon: '⚡' },
  limits:      { label: 'Governor Limits', color: '#e05555', icon: '🔴' },
  validation:  { label: 'Validation',   color: '#e8a020', icon: '⚠' },
  design:      { label: 'Design',       color: '#9b7fe8', icon: '◎' },
  error:       { label: 'Error',        color: '#e05555', icon: '✕' },
  info:        { label: 'Info',         color: '#4a9eff', icon: 'ℹ' },
};

const SCAN_SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function renderCodeScan(result) {
  const findings = [...(result.scanFindings || [])].sort((a, b) =>
    (SCAN_SEVERITY_ORDER[a.severity] ?? 9) - (SCAN_SEVERITY_ORDER[b.severity] ?? 9)
  );

  const criticals = findings.filter(f => f.severity === 'critical');
  const warnings  = findings.filter(f => f.severity === 'warning');
  const infos     = findings.filter(f => f.severity === 'info');

  // Category breakdown chips
  const catCounts = {};
  for (const f of findings) catCounts[f.category] = (catCounts[f.category] || 0) + 1;
  const catChips = Object.entries(catCounts).map(([cat, n]) => {
    const meta = SCAN_CATEGORY_META[cat] || { label: cat, color: '#888', icon: '•' };
    return `<span class="scan-cat-chip" style="border-color:${meta.color};color:${meta.color};">
      ${meta.icon} ${meta.label} <strong>${n}</strong>
    </span>`;
  }).join('');

  if (findings.length === 0) {
    return `<div class="scan-page">
      <div class="scan-clean">
        <div class="scan-clean-icon">✓</div>
        <div class="scan-clean-title">No issues detected</div>
        <div class="scan-clean-sub">Runtime analysis found no problems in this execution.</div>
      </div>
      <div class="scan-note">This scan is based on runtime log analysis. Install the <strong>Salesforce Code Analyzer</strong> (<code>sf scanner</code>) CLI plugin to also run static analysis on the source files.</div>
    </div>`;
  }

  function renderFinding(f, idx) {
    const sevMeta = {
      critical: { cls: 'scan-sev-critical', label: 'Critical', icon: '✕' },
      warning:  { cls: 'scan-sev-warning',  label: 'Warning',  icon: '⚠' },
      info:     { cls: 'scan-sev-info',     label: 'Info',     icon: 'ℹ' },
    }[f.severity] || { cls: 'scan-sev-info', label: 'Info', icon: 'ℹ' };
    const catMeta = SCAN_CATEGORY_META[f.category] || { label: f.category, icon: '•', color: '#888' };
    const openBtn = f.lineIndex !== null
      ? `<button class="scan-open-btn" data-line-index="${f.lineIndex}">Open in log</button>`
      : '';
    return `<div class="scan-finding scan-finding-${f.severity}" data-idx="${idx}">
      <div class="scan-finding-header">
        <span class="scan-sev-badge ${sevMeta.cls}">${sevMeta.icon} ${sevMeta.label}</span>
        <span class="scan-cat-label" style="color:${catMeta.color};">${catMeta.icon} ${catMeta.label}</span>
        <span class="scan-rule-name">${escapeHtml(f.rule)}</span>
        ${openBtn}
      </div>
      <div class="scan-finding-msg">${escapeHtml(f.message)}</div>
      ${f.detail ? `<div class="scan-finding-detail">${escapeHtml(f.detail)}</div>` : ''}
    </div>`;
  }

  const summaryBar = `
    <div class="scan-summary-bar">
      <div class="scan-summary-stat scan-stat-critical">
        <span class="scan-stat-num">${criticals.length}</span>
        <span class="scan-stat-lbl">Critical</span>
      </div>
      <div class="scan-summary-stat scan-stat-warning">
        <span class="scan-stat-num">${warnings.length}</span>
        <span class="scan-stat-lbl">Warnings</span>
      </div>
      <div class="scan-summary-stat scan-stat-info">
        <span class="scan-stat-num">${infos.length}</span>
        <span class="scan-stat-lbl">Info</span>
      </div>
      <div class="scan-cat-chips">${catChips}</div>
    </div>`;

  const findingsHtml = findings.map((f, i) => renderFinding(f, i)).join('');

  return `<div class="scan-page">
    ${summaryBar}
    <div class="scan-findings">${findingsHtml}</div>
    <div class="scan-note">Runtime analysis only — detects issues that occurred during this execution. Static analysis (PMD, security rules) requires the VS Code extension with Salesforce Code Analyzer installed.</div>
  </div>`;
}

function renderGovernorLimits(limitData) {
  const LIMIT_KEYS = [
    { key: 'Number of SOQL queries',      label: 'SOQL Queries',      max: 100 },
    { key: 'Number of DML statements',    label: 'DML Statements',    max: 150 },
    { key: 'Number of DML rows',          label: 'DML Rows',          max: 10000 },
    { key: 'Maximum CPU time',            label: 'CPU Time (ms)',     max: 10000 },
    { key: 'Maximum heap size',           label: 'Heap Size (bytes)', max: 6000000 },
    { key: 'Number of callouts',          label: 'Callouts',          max: 100 },
    { key: 'Number of Email Invocations', label: 'Email Invocations', max: 10 },
    { key: 'Number of future calls',      label: 'Future Calls',      max: 50 },
  ];

  const available = LIMIT_KEYS.filter(lk => limitData[lk.key]);
  if (available.length === 0) return '<p class="muted">No governor limit data found in this log.</p>';
  const allZero = available.every(lk => limitData[lk.key].used === 0);
  const zeroNote = allZero ? '<p class="muted" style="margin:0 0 10px">All limits are 0 — this log was captured for a UI/system operation with no Apex execution.</p>' : '';

  const bars = available.map(lk => {
    const entry = limitData[lk.key];
    const used = entry.used;
    const max  = entry.max || lk.max;
    const pct  = Math.min(100, Math.round((used / max) * 100));
    const level = pct >= 80 ? 'danger' : pct >= 50 ? 'warn' : 'ok';
    const label = pct >= 80 ? `⚠ ${pct}%` : `${pct}%`;
    return `
      <div class="limit-row">
        <span class="limit-label">${escapeHtml(lk.label)}</span>
        <div class="limit-track">
          <div class="limit-fill limit-${level}" style="width:${pct}%"></div>
        </div>
        <span class="limit-value limit-value-${level}">${used.toLocaleString()} / ${max.toLocaleString()}</span>
        <span class="limit-pct limit-pct-${level}">${label}</span>
      </div>`;
  }).join('');

  return `${zeroNote}<div class="limits-container">${bars}</div>`;
}

function renderDatasourceDetail(startIdx, endIdx, label) {
  // Extract provider class name from label e.g. "ApexDataSource:ORS_ExternalDataSourceProvider"
  const providerClass = label.replace(/^ApexDataSource:/i, '').trim();

  // Scan lines in the span to extract useful info
  const methods = [];       // user-defined methods called
  const capabilities = [];  // DataSource.Capability values added
  const seenMethods = new Set();

  const scanEnd = Math.min(endIdx, startIdx + 200);
  for (let i = startIdx; i <= scanEnd; i++) {
    const line = currentLogLines[i] || '';
    const parts = line.split('|');
    const cat = parts[1]?.trim();

    // Collect user METHOD_ENTRY (not system, not constructor)
    if (cat === 'METHOD_ENTRY') {
      const sig = parts[4]?.trim() || '';
      const classMatch = sig.match(/^([A-Z]\w*)\./);
      if (classMatch && classMatch[1] === providerClass && !seenMethods.has(sig)) {
        seenMethods.add(sig);
        // Extract just the method name + params, strip class prefix
        const methodName = sig.replace(providerClass + '.', '');
        methods.push(methodName);
      }
    }

    // Count DataSource.Capability.add() calls — actual enum names aren't logged by SF
    if (cat === 'SYSTEM_METHOD_ENTRY' && line.includes('DataSource.Capability') && line.includes('.add(')) {
      capabilities.push(true);
    }
  }

  const methodsHtml = methods.length > 0
    ? methods.map(m => `<div class="ds-method">${escapeHtml(m)}</div>`).join('')
    : '<div class="ds-none">No methods logged</div>';

  const capsHtml = capabilities.length > 0
    ? `<span class="ds-cap">${capabilities.length} capability value${capabilities.length > 1 ? 's' : ''} registered</span>
       <span class="ds-none" style="display:block;margin-top:4px;">Open source file to see enum names</span>`
    : '<span class="ds-none">None logged</span>';

  return `
    <div class="detail-src-header">
      <span class="detail-src-filename">${escapeHtml(providerClass)}.cls</span>
    </div>
    <div class="ds-detail">
      <div class="ds-section-label">Methods called</div>
      <div class="ds-methods">${methodsHtml}</div>
      <div class="ds-section-label" style="margin-top:12px;">Capabilities</div>
      <div class="ds-caps">${capsHtml}</div>
    </div>`;
}

function renderValidationDetail(startIdx, endIdx) {
  // Find all validation rules whose lineIndex falls within this span's log line range
  const rules = currentValidationRules.filter(r => r.lineIndex >= startIdx && r.lineIndex <= endIdx);
  if (rules.length === 0) {
    return '<div class="detail-src-not-found">No validation rule details found for this span.</div>';
  }

  const rows = rules.map(r => {
    const passed = r.result === 'pass';
    const badge = passed
      ? `<span class="vd-badge vd-pass">PASS</span>`
      : `<span class="vd-badge vd-fail">FAIL</span>`;
    const formula = r.formula
      ? `<div class="vd-formula">${escapeHtml(r.formula)}</div>`
      : '';
    const error = r.errorMessage
      ? `<div class="vd-error">${escapeHtml(r.errorMessage)}</div>`
      : '';
    return `<div class="vd-rule">
      <div class="vd-rule-header">${badge}<span class="vd-rule-name">${escapeHtml(r.name)}</span></div>
      ${formula}${error}
    </div>`;
  }).join('');

  return `
    <div class="detail-src-header">
      <span class="detail-src-filename">Validation Rules (${rules.length})</span>
    </div>
    <div class="detail-src-lines vd-list">${rows}</div>`;
}

function renderValidationRules(validationRules) {
  if (validationRules.length === 0) {
    return '<p class="muted">No validation rule events found in this log.</p>';
  }

  const fails = validationRules.filter(r => r.result === 'fail');
  const passes = validationRules.filter(r => r.result === 'pass');

  const failBanner = fails.length > 0
    ? `<div class="validation-banner validation-fail-banner">⚠ ${fails.length} validation rule${fails.length > 1 ? 's' : ''} failed</div>`
    : `<div class="validation-banner validation-pass-banner">✓ All ${passes.length} validation rules passed</div>`;

  // Group by object
  const byObject = {};
  validationRules.forEach(r => {
    const obj = r.object || 'Unknown';
    if (!byObject[obj]) byObject[obj] = [];
    byObject[obj].push(r);
  });

  const groups = Object.entries(byObject).map(([obj, rules]) => {
    const objFails = rules.filter(r => r.result === 'fail').length;
    const badge = objFails > 0
      ? `<span class="vr-group-badge vr-group-badge-fail">${objFails} failed</span>`
      : `<span class="vr-group-badge vr-group-badge-pass">${rules.length} passed</span>`;
    const rows = rules.map(r => {
      const resultClass = r.result === 'fail' ? 'vr-fail' : 'vr-pass';
      const resultIcon  = r.result === 'fail' ? '✗' : '✓';
      const formulaAttr = r.formula ? ` data-formula="${escapeHtml(r.formula)}"` : '';
      const errMsg  = r.errorMessage ? `<div class="vr-error-msg">${escapeHtml(r.errorMessage)}</div>` : '';
      return `
        <div class="vr-row ${r.result === 'fail' ? 'vr-row-fail' : ''}" data-line-index="${r.lineIndex}"${formulaAttr}>
          <span class="vr-result ${resultClass}">${resultIcon}</span>
          <div class="vr-detail">
            <span class="vr-name">${escapeHtml(r.name)}</span>
            ${errMsg}
          </div>
        </div>`;
    }).join('');
    return `<div class="vr-group"><div class="vr-group-title">${escapeHtml(obj)}${badge}<span class="vr-group-chevron">▾</span></div><div class="vr-group-body">${rows}</div></div>`;
  }).join('');

  return `<div class="validation-container">${failBanner}${groups}</div>`;
}

function renderSourceSnippet(msg) {
  const panel = document.querySelector('.detail-source-panel');
  if (!panel) return;

  if (!msg.lines) {
    panel.innerHTML = `<div class="detail-src-not-found">Source not found.<br>Open your Salesforce project folder in VSCode (File → Open Folder) to enable inline source view.</div>`;
    return;
  }

  const fileName = msg.fileName || msg.className;
  const linesHtml = msg.lines.map(l => `
    <div class="detail-line${l.isTarget ? ' detail-line-target' : ''}">
      <span class="detail-line-num">${l.n}</span>
      <span class="detail-line-text">${escapeHtml(l.text)}</span>
    </div>`).join('');

  panel.innerHTML = `
    <div class="detail-src-header">
      <span class="detail-src-filename">${escapeHtml(fileName)}</span>
    </div>
    <div class="detail-src-lines">${linesHtml}</div>`;

  // Scroll the source container to the highlighted line
  const srcLines = panel.querySelector('.detail-src-lines');
  const target = panel.querySelector('.detail-line-target');
  if (srcLines && target) {
    const offsetTop = target.offsetTop - srcLines.offsetTop;
    srcLines.scrollTop = Math.max(0, offsetTop - srcLines.clientHeight / 2);
  }

  panel.querySelector('.detail-src-open-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSource', className: msg.className, lineNumber: msg.lineNumber });
  });
  // Wire flow builder links (rendered as <a> but clicks go through postMessage)
  panel.querySelectorAll('.flow-org-link').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: a.getAttribute('href') });
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
