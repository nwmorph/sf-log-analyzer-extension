# Testing Einstein AI in Sandbox

The extension is now ready to test! Here's what to look for when testing in your sandbox org.

## What Was Implemented

The extension now attempts to detect Einstein AI in your org by:

1. **Probing Einstein endpoints** with HEAD requests
2. **Querying for Einstein objects** via Tooling API
3. **Trying multiple generation patterns** if detected

If Einstein is found, it uses it. Otherwise, it falls back to enhanced rule-based summaries.

## Test in Sandbox (With Einstein)

### 1. Load the Extension
```bash
git pull origin main
# In Chrome: chrome://extensions → click ↺ (reload)
```

### 2. Open a Debug Log
- Log into your **sandbox org** (the one with Einstein/Agentforce)
- Generate any Apex debug log
- Click the SF Log Analyzer icon
- Select a log

### 3. Check the Console
Open Chrome DevTools (F12) and watch the Console tab for:

#### ✅ **Success Case (Einstein Found)**
```
[AI] Einstein API detected
[Einstein] Found endpoint: /services/data/v65.0/einstein/llm/chat
[Einstein] Success with endpoint: /services/data/v65.0/einstein/llm/chat/completions
```

**You should see:**
- Report tab: "Einstein AI Summary" at the top
- Timeline tab: "Einstein AI Summary" above "What happened"
- Footer text: "🔒 Powered by Einstein AI in your org"

#### ❌ **Fallback Case (No Einstein)**
```
[AI] Einstein not available: ...
[AI] Using rule-based summaries
```

**You should see:**
- Report tab: "Overview" at the top
- Timeline tab: "Overview" above "What happened"
- No footer text

### 4. Check for Errors
Look for any of these in Console:

```
[Einstein] /services/data/v65.0/einstein/llm/chat returned 403: ...
```
**Meaning**: Endpoint exists but permission denied  
**Action**: Share the full error message with me

```
[Einstein] /services/data/v65.0/einstein/llm/chat returned 404: ...
```
**Meaning**: Endpoint doesn't exist  
**Action**: Normal if org doesn't have Einstein

```
[Einstein] /services/data/v65.0/einstein/llm/chat returned 400: ...
```
**Meaning**: Endpoint exists but wrong request format  
**Action**: Share the error — tells us the correct format

## What I Need From You

If Einstein **is detected** but generation **fails**, please share:

1. **Console logs** (all `[Einstein]` messages)
2. **Error response** (the `returned XXX: ...` messages)
3. **Org type** (sandbox with Agentforce? with Einstein 1:1?)

This will tell me:
- Which endpoint is available
- What request format it expects
- What the response format looks like

## Test in Production (Without Einstein)

### Expected Behavior
```
[AI] Einstein not available
[AI] Using rule-based summaries
```

The extension should work normally with "Overview" sections showing rule-based summaries.

## Endpoints Being Tested

The extension tries these in order:

### 1. Chat Completions (OpenAI-style)
```
POST /services/data/v65.0/einstein/llm/chat/completions
{
  "model": "sfdc_ai__DefaultGPT4Model",
  "messages": [...],
  "max_tokens": 200
}
```

### 2. Simple Chat
```
POST /services/data/v65.0/einstein/llm/chat
{
  "prompt": "...",
  "systemPrompt": "...",
  "maxTokens": 200
}
```

### 3. Legacy Einstein Platform
```
POST /services/einstein/v2/language
{
  "document": "...",
  "numResults": 1
}
```

One of these should work if Einstein is available!

## What Happens on Success

If Einstein API works, the summary will say something like:

> "This log shows a Contact record update that triggered an after-update flow. The execution took 247ms with 2 SOQL queries and 1 DML operation. CPU usage reached 45% of the governor limit, performance is good."

If rule-based, it will say:

> "A **After Update** operation on **Contact** triggered this execution. It executed 1 flow, 1 DML operation. Total time: **247 ms** (fast)."

Both are good! Einstein is just more natural-language.

## Debug Mode

To see more details, open Console and run:
```javascript
// Force re-detection
aiCapability = null;
detectAICapability('https://your-sandbox.my.salesforce.com')
```

This will re-run detection and show detailed logs.

## Next Steps

**After testing in sandbox:**

1. ✅ **Einstein works** → Share which endpoint succeeded! I'll optimize it
2. ❌ **Einstein fails** → Share the error messages, I'll adjust the request format
3. 🤷 **No Einstein detected** → Normal, rule-based summaries will work fine

---

**Bottom line**: The extension will work either way. Einstein is a nice-to-have enhancement, but not required for the extension to be useful!
