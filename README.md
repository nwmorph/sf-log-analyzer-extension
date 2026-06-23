# SF Log Analyzer — Chrome Extension

A Chrome extension that connects directly to your authenticated Salesforce org, lists available Apex debug logs, and runs the full log analysis in a new browser tab — no downloading required.

---

## Key Features

- **Live log list** — fetches ApexLog records directly from the Salesforce Tooling API using your existing browser session
- **One-click analysis** — select a log from the list and the full analyzer opens instantly
- **Full analysis engine** — execution timeline, What Happened narrative, governor limits, validation rules, code scan, and report — the same engine as the VS Code extension
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

This extension is not on the Chrome Web Store — it is installed directly from source. This is standard practice for internal developer tools and is called *sideloading*.

1. Download and unzip the [latest release](https://github.com/nwmorph/sf-log-analyzer-extension/releases/latest), **or** clone the repo:
   ```bash
   git clone https://github.com/nwmorph/sf-log-analyzer-extension.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `sf-log-analyzer-extension` folder
5. The SF Log Analyzer icon appears in your Chrome toolbar

> Chrome may show a one-time banner saying *"You have extensions running in developer mode"* — this is expected for sideloaded extensions and is not a security concern for a tool you have installed yourself from source.

To update, pull the latest changes (or replace the folder) and click **↺** on the extension card in `chrome://extensions`.

---

## Usage

1. Log into a Salesforce org in any Chrome tab
2. Click the **SF Log Analyzer** icon in the toolbar → a new tab opens
3. Click **Refresh** — the log list loads from your current org
4. Click any log row → the full analysis renders on the right
5. Click **✕** on a row to delete that log from the org

---

## What's included vs. the VS Code extension

| Feature | VS Code | Chrome |
|---|---|---|
| Execution timeline + zoom | ✓ | ✓ |
| What Happened narrative | ✓ | ✓ |
| Governor limits | ✓ | ✓ |
| Validation rules | ✓ | ✓ |
| Report tab | ✓ | ✓ |
| Runtime code scan | ✓ | ✓ |
| Static analysis (sf code-analyzer) | ✓ | — |
| Source file linking | ✓ | — |
| Apex @description lookup | ✓ | — |
| Live log list from org | — | ✓ |
| Delete logs | — | ✓ |
| No download needed | — | ✓ |

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
