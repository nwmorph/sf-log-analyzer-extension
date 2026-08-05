# How to Enable Chrome Built-in AI

The SF Log Analyzer extension can use Chrome's built-in AI (Gemini Nano) to generate intelligent log summaries — completely **on-device and private**.

## Requirements

- **Chrome 127 or later** (check: `chrome://version`)
- **~1.5 GB free disk space** (for the AI model download)
- **Internet connection** (one-time, for model download)

## Setup Steps

### 1. Enable the AI Feature Flags

Open these two pages in Chrome and set both to **Enabled**:

1. Navigate to: `chrome://flags/#optimization-guide-on-device-model`
   - Set: **Enabled**

2. Navigate to: `chrome://flags/#prompt-api-for-gemini-nano`
   - Set: **Enabled**

### 2. Restart Chrome

Click **Relaunch** button at the bottom of the flags page, or fully quit and restart Chrome.

### 3. Trigger Model Download

The AI model downloads automatically when first needed. To trigger it now:

1. Open Chrome DevTools (F12 or Cmd+Option+I)
2. Go to the **Console** tab
3. Run this command:
   ```javascript
   await ai.summarizer.create()
   ```

**Expected behavior:**
- First time: Returns an error like `"Model download in progress"` or `"Available: after-download"`
- After download completes (a few minutes): Returns a `Summarizer` object

### 4. Wait for Download

The model downloads in the background. Check progress:

```javascript
await ai.summarizer.capabilities()
```

**Response meanings:**
- `{ available: "no" }` — Not supported
- `{ available: "after-download" }` — Downloading...
- `{ available: "readily" }` — ✅ Ready to use!

Download typically takes **2-5 minutes** on good internet.

### 5. Test It

Once `available: "readily"`, test it:

```javascript
const summarizer = await ai.summarizer.create();
const summary = await summarizer.summarize("This is a long text about Salesforce Apex execution...");
console.log(summary);
summarizer.destroy();
```

If this works, you're all set! The SF Log Analyzer will automatically detect and use Chrome AI.

## Troubleshooting

### "AI not available in this browser"
- Make sure you're on **Chrome 127+** (not Edge, Brave, or other browsers)
- Check flags are enabled: both should show **Enabled** in blue

### "Available: no"
- Your Chrome version might not support it yet
- Try Chrome Canary or Dev channel for earliest access
- Check system requirements: works on Windows, Mac, Linux, ChromeOS

### Model won't download
- Check internet connection
- Check disk space (~1.5 GB needed)
- Try: `chrome://components` → find "Optimization Guide On Device Model" → click **Check for update**

### Still not working?
- Clear Chrome cache: `chrome://settings/clearBrowserData`
- Disable/re-enable the flags
- Try in an Incognito window
- Check Chrome forums: search for "Prompt API Gemini Nano"

## Privacy & Security

### Is it safe?
**Yes, 100% private:**
- Model runs **entirely on your device**
- **Zero data sent to Google** or any server
- No internet needed after initial download
- Same privacy as any local computation

### What data is used?
The extension sends only:
- Execution duration, method counts, error counts
- Governor limit usage percentages
- Execution step names (trigger names, flow names, etc.)

**Never sent:**
- Actual log text content
- Variable values
- User data
- Record IDs

The AI processes this locally and generates a 2-3 sentence summary.

## How to Disable AI Summaries

If you prefer not to use AI summaries:

1. Open the log analyzer
2. Click the **⚙️** (settings) button on any AI summary
3. Choose **Disable**
4. Refresh the log

The extension will fall back to rule-based summaries (no AI).

---

## References

- [Chrome Built-in AI](https://developer.chrome.com/docs/ai/built-in)
- [Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api)
- [Chrome AI Origin Trial](https://developer.chrome.com/origintrials/#/view_trial/5171595133755392)
