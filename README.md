# SF Log Analyzer — Chrome Extension

A Chrome extension that connects directly to your authenticated Salesforce org, lists available Apex debug logs, and runs the full log analysis in a new browser tab — no downloading required.

---

## Key Features

- **Live log list** — fetches ApexLog records directly from the Salesforce Tooling API using your existing browser session
- **One-click analysis** — select a log from the list and the full analyzer opens instantly
- **Full analysis engine** — execution timeline with zoom, What Happened narrative, governor limits, validation rules, code scan, rule-based intelligent summary, and report — the same engine as the VS Code extension
- **Timeline zoom** — +/−/⊙ buttons for zooming on both overview and detail timelines; zoom respects active filter (zoom on SOQL shows only SOQL segments)
- **Intelligent Overview** — automatic plain-English summary describing what triggered execution, operations performed, performance assessment, and critical issues
- **Unread tracking** — visual indicators (bold text + blue highlight) for logs you haven't viewed yet
- **Smart filtering** — "Unread only" mode to focus on new logs; logs automatically disappear as you read them
- **Pagination** — configurable page size (25/50/100/200 logs) with Next button to load more via QueryMore API
- **Column sorting** — click User, Operation, Time, or Size headers to sort ascending/descending
- **Delete logs** — remove individual logs from the org directly from the UI
- **No download needed** — the log body is fetched and analysed in memory
- **Auto org detection** — detects which Salesforce org you're on and connects automatically

---

## How authentication works

The extension reads the **`sid` session cookie** that Chrome already holds when you are logged into a Salesforce org. It does not store credentials, does not contact any external server, and does not require a connected app or OAuth client ID.

All API calls go directly from your browser to your org — the same network path as any other tab you have open. The background service worker proxies those calls so the session cookie is included automatically.

This is the same approach used by [Salesforce Inspector Reloaded](https://github.com/tprouvot/Salesforce-Inspector-reloaded) and similar developer tools. A connected app (OAuth 2.0 with a client ID) is the right pattern for a *server* that needs long-lived access to an org. For a browser extension operating inside an already-authenticated session, reading the existing cookie is the cleaner and more appropriate solution — no external infrastructure, and no permissions beyond what the logged-in user already has.

**Manifest permissions explained:**

| Permission | Why it is needed |
|---|---|
| `cookies` | Read the `sid` session cookie to authenticate API calls |
| `tabs` | Detect which Salesforce org the active tab is pointed at |
| `storage` | Remember the org URL between tab opens (session storage only) |
| `activeTab` | Trigger org detection when you click the toolbar icon |
| `host_permissions` (`*.salesforce.com` etc.) | Allow the service worker to make fetch requests to your org's API |

---

## Requirements

| Item | Detail |
|---|---|
| Chrome | 114+ (Manifest V3 + storage.session API) |
| Salesforce | Any org you're logged into in the browser |

No Salesforce CLI, no build tools, no installation of other extensions required.

---

## Installation

> **Note:** This extension is currently installed via sideloading (developer mode), which is standard practice for internal tools during development. We are planning to publish it to the Chrome Web Store and Edge Add-ons store in the future for easier distribution and to work around enterprise browser policies.

This extension is not yet on the Chrome Web Store — it is installed directly from source via *sideloading*:

1. Download and unzip the [latest release](https://github.com/nwmorph/sf-log-analyzer-extension/releases/latest), **or** clone the repo:
   ```bash
   git clone https://github.com/nwmorph/sf-log-analyzer-extension.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `sf-log-analyzer-extension` folder
5. The SF Log Analyzer icon appears in your Chrome toolbar

> **Chrome may show a one-time banner saying *"You have extensions running in developer mode"*** — this is expected for sideloaded extensions and is not a security concern for a tool you have installed yourself from source.
>
> **Enterprise users:** If your organization has extension policies that block sideloading (common in Edge), this extension will not load until it's published to the official stores. Use Chrome in the meantime, or ask your IT team about extension allowlisting.

To update, pull the latest changes (or replace the folder) and click **↺** on the extension card in `chrome://extensions`.

---

## Usage

1. Log into a Salesforce org in any Chrome tab
2. Click the **SF Log Analyzer** icon in the toolbar → a new tab opens
3. The log list loads automatically from your current org
4. Click any log row → the full analysis renders on the right
5. **Unread logs** are shown in bold with a blue highlight; they disappear when clicked if "Unread only" is checked
6. Use the **page size dropdown** (25/50/100/200) to control how many logs load
7. Click **Next** to load more logs via pagination
8. Click column headers (User, Operation, Time, Size) to sort the list
9. Click **✕** on a row to delete that log from the org
10. Use **Refresh** to reload the log list from scratch

---

## What's included vs. the VS Code extension

This Chrome extension shares the same analysis engine as the **[SF Log Analyzer VS Code extension](https://github.com/nwmorph/sf-log-analyzer)** but differs in how logs are accessed and what IDE-specific features are available.

| Feature | VS Code | Chrome |
|---|---|---|
| **Analysis Features** | | |
| Execution timeline + zoom | ✓ | ✓ |
| Filter-aware zoom | ✓ | ✓ |
| What Happened narrative | ✓ | ✓ |
| Governor limits | ✓ | ✓ |
| Validation rules | ✓ | ✓ |
| Report tab (default) | ✓ | ✓ |
| Raw Log tab | ✓ | ✓ |
| Rule-based intelligent summary | ✓ | ✓ |
| Runtime code scan | ✓ | ✓ |
| Loading indicators | ✓ | ✓ |
| **IDE/Editor Features** | | |
| Static analysis (sf code-analyzer) | ✓ | — |
| Source file linking | ✓ | — |
| Apex @description lookup | ✓ | — |
| **Log Access Features** | | |
| Open from file | ✓ | — |
| Live log list from org | — | ✓ |
| Unread tracking | — | ✓ |
| Pagination (QueryMore) | — | ✓ |
| Column sorting | — | ✓ |
| Delete logs | — | ✓ |
| No download needed | — | ✓ |

**Use the Chrome extension when:**
- You want to browse and analyze logs directly from your org
- You don't want to download log files
- You need to quickly check recent logs with unread tracking
- You need to delete old logs to free up org storage

**Use the VS Code extension when:**
- You're actively developing Apex and want source file linking
- You need static analysis via Salesforce Code Analyzer
- You want to open downloaded log files from your filesystem
- You prefer working within your IDE

---

## Project Structure

```
manifest.json      # Chrome extension manifest (MV3)
background.js      # Service worker — API proxy, session handling
content.js         # Injected into Salesforce pages — org URL detection
newtab/
├── index.html     # Full-page analyzer UI
├── app.js         # Log list, org connection, Chrome API glue
├── main.js        # Analysis engine (adapted from VS Code extension)
└── styles.css     # Styles with light/dark mode support
icons/             # Extension icons
```

---

## Credits

Created by **Niklas Waller**; source code written with [Claude](https://claude.ai) (Anthropic) acting as a coding agent under Niklas's direction.

**License:** MIT
