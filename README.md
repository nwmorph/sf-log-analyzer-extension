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

## Requirements

| Item | Detail |
|---|---|
| Chrome | 114+ (Manifest V3 + storage.session API) |
| Salesforce | Any org you're logged into in the browser |

No Salesforce CLI, no build tools, no installation of other extensions required.

---

## Installation

1. Download the extension folder or clone the repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `sf-log-analyzer-extension` folder
5. The SF icon appears in your Chrome toolbar

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
