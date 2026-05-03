require('dotenv').config();
const express = require('express');
const { encodingForModel, getEncoding } = require("js-tiktoken");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const port = 3000;

// Allow cross-origin fetch from the React frontend via the BrowserPod portal
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const BASELINE_THRESHOLD = 10000;

function numTokensFromMessages(messages, model = "gpt-4o-mini-2024-07-18") {
  let encoding;
  try {
    encoding = encodingForModel(model);
  } catch (e) {
    encoding = getEncoding("o200k_base");
  }

  const exactModels = new Set([
    "gpt-3.5-turbo-0125",
    "gpt-4-0314",
    "gpt-4-32k-0314",
    "gpt-4-0613",
    "gpt-4-32k-0613",
    "gpt-4o-mini-2024-07-18",
    "gpt-4o-2024-08-06"
  ]);

  let tokensPerMessage = 3;
  let tokensPerName = 1;

  if (exactModels.has(model)) {
    tokensPerMessage = 3;
    tokensPerName = 1;
  } else if (model.includes("gpt-3.5-turbo")) {
    return numTokensFromMessages(messages, "gpt-3.5-turbo-0125");
  } else if (model.includes("gpt-4o-mini")) {
    return numTokensFromMessages(messages, "gpt-4o-mini-2024-07-18");
  } else if (model.includes("gpt-4o")) {
    return numTokensFromMessages(messages, "gpt-4o-2024-08-06");
  } else if (model.includes("gpt-4")) {
    return numTokensFromMessages(messages, "gpt-4-0613");
  }

  let numTokens = 0;
  for (const message of messages) {
    numTokens += tokensPerMessage;
    for (const [key, value] of Object.entries(message)) {
      numTokens += encoding.encode(String(value)).length;
      if (key === "name") {
        numTokens += tokensPerName;
      }
    }
  }
  numTokens += 3;
  return numTokens;
}

function numTokensForTools(functions, messages, model) {
  let funcInit = 0;
  let propInit = 0;
  let propKey = 0;
  let enumInit = 0;
  let enumItem = 0;
  let funcEnd = 0;

  if (["gpt-4o", "gpt-4o-mini"].includes(model)) {
    funcInit = 7;
    propInit = 3;
    propKey = 3;
    enumInit = -3;
    enumItem = 3;
    funcEnd = 12;
  } else if (["gpt-3.5-turbo", "gpt-4"].includes(model)) {
    funcInit = 10;
    propInit = 3;
    propKey = 3;
    enumInit = -3;
    enumItem = 3;
    funcEnd = 12;
  }

  let encoding;
  try {
    encoding = encodingForModel(model);
  } catch (e) {
    encoding = getEncoding("o200k_base");
  }

  let funcTokenCount = 0;
  if (functions.length > 0) {
    for (const f of functions) {
      funcTokenCount += funcInit;
      const functionDef = f.function;
      const fName = functionDef.name;
      let fDesc = functionDef.description || "";
      if (fDesc.endsWith(".")) fDesc = fDesc.slice(0, -1);

      const line = `${fName}:${fDesc}`;
      funcTokenCount += encoding.encode(line).length;

      const properties = functionDef.parameters?.properties || {};
      if (Object.keys(properties).length > 0) {
        funcTokenCount += propInit;
        for (const key of Object.keys(properties)) {
          funcTokenCount += propKey;
          const pName = key;
          const pType = properties[key].type;
          let pDesc = properties[key].description || "";

          if (properties[key].enum) {
            funcTokenCount += enumInit;
            for (const item of properties[key].enum) {
              funcTokenCount += enumItem;
              funcTokenCount += encoding.encode(String(item)).length;
            }
          }
          if (pDesc.endsWith(".")) pDesc = pDesc.slice(0, -1);
          const propLine = `${pName}:${pType}:${pDesc}`;
          funcTokenCount += encoding.encode(propLine).length;
        }
      }
    }
    funcTokenCount += funcEnd;
  }

  return numTokensFromMessages(messages, model) + funcTokenCount;
}

function loadJsonFile(p) {
  let rawData;
  try {
    rawData = fs.readFileSync(p, "utf8");
  } catch (err) {
    rawData = "{}";
  }
  const data = JSON.parse(rawData);
  return { functions: data.functions || [], messages: data.messages || [], raw: rawData };
}

function loadPromptData() {
  const uploadedPath = path.join(__dirname, "prompt_data.json");
  const examplePath = path.join(__dirname, "prompt_data_example.json");
  return loadJsonFile(fs.existsSync(uploadedPath) ? uploadedPath : examplePath);
}

// JSON scoring endpoint — used by the React frontend
app.get('/analyze', async (req, res) => {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { functions, messages, raw } = loadPromptData();

  if (functions.length === 0 && messages.length === 0) {
    return res.status(422).json({ error: "Prompt data is empty or could not be read." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY is not set." });
  }

  let tokenRatio = 0;
  let intentRatio = 0;
  let structuralScore = 0;

  try {
    const tokenNumber = numTokensForTools(functions, messages, "gpt-4o");
    tokenRatio = Math.min(1, tokenNumber / BASELINE_THRESHOLD);

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userMessage = lastUserMsg ? String(lastUserMsg.content) : '';

    const intentResp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      messages: [{
        role: "user",
        content: `You are a cognitive load classifier. Assign an Intent Weight (I) between 0.1 and 1.0 based on the complexity of the following user request.

Rubric:
0.1 - 0.2: Simple greetings or basic Yes/No.
0.3 - 0.4: Basic fact retrieval.
0.5 - 0.6: Summarization or formatting.
0.7 - 0.8: Technical debugging or code writing.
0.9 - 1.0: Deep architectural design or strategy.

User Message: "${userMessage}"

Return ONLY the numerical float value.`
      }]
    });

    const intentText = intentResp.content[0].text.trim();
    const intentMatch = intentText.match(/\d+\.?\d*/);
    intentRatio = intentMatch ? Math.min(1.0, Math.max(0.0, parseFloat(intentMatch[0]))) : 0.5;

    const structResp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      messages: [{
        role: "user",
        content: `You are a structural complexity classifier. Analyze the following LLM API request and assign a Structural Weight (S) between 0.1 and 1.0.

Rubric:
0.1 - 0.2: Simple single-turn message, no tools.
0.3 - 0.4: A few messages or basic tool definitions.
0.5 - 0.6: Multi-turn conversation or moderate tool complexity.
0.7 - 0.8: Multiple tools with detailed parameters and enum constraints.
0.9 - 1.0: Complex multi-tool systems with deep nesting and long conversation history.

Request:
${raw}

Return ONLY the numerical float value.`
      }]
    });

    const structText = structResp.content[0].text.trim();
    const structMatch = structText.match(/\d+\.?\d*/);
    structuralScore = structMatch ? Math.min(1.0, Math.max(0.0, parseFloat(structMatch[0]))) : 0.5;

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json({ tokenRatio, intentRatio, structuralScore });
});

// HTML dashboard
app.get('/', async (req, res) => {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { functions, messages, raw } = loadPromptData();

  let tokenNumber = 0;
  let tokenRatio = 0;
  let intentRatio = 0;
  let errorMsg = null;

  if (functions.length === 0 && messages.length === 0) {
    errorMsg = "Could not load prompt data or file is empty.";
  } else {
    try {
      tokenNumber = numTokensForTools(functions, messages, "gpt-4o");
      tokenRatio = Math.min(1, tokenNumber / BASELINE_THRESHOLD);

      if (process.env.ANTHROPIC_API_KEY) {
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const userMessage = lastUserMsg ? String(lastUserMsg.content) : '';

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 50,
          messages: [{
            role: "user",
            content: `You are a cognitive load classifier. Assign an Intent Weight (I) between 0.1 and 1.0.

Rubric:
0.1 - 0.2: Simple greetings or basic Yes/No.
0.3 - 0.4: Basic fact retrieval.
0.5 - 0.6: Summarization or formatting.
0.7 - 0.8: Technical debugging or code writing.
0.9 - 1.0: Deep architectural design or strategy.

User Message: "${userMessage}"

Return ONLY the numerical float value.`
          }]
        });

        const rawResponse = response.content[0].text;
        const match = rawResponse.match(/\d+\.?\d*/);
        intentRatio = match ? Math.min(1.0, Math.max(0.0, parseFloat(match[0]))) : 0.0;
      } else {
        errorMsg = "No ANTHROPIC_API_KEY provided.";
      }
    } catch (e) {
      errorMsg = e.message;
    }
  }

  const uiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Token & Intent Analysis</title>
  <style>
    body{margin:0;font-family:'Inter',-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;min-height:100vh;box-sizing:border-box}
    .container{display:flex;flex-direction:row;flex-wrap:wrap;justify-content:center;gap:24px;width:100%;max-width:900px}
    .card{background:#1e293b;border-radius:16px;padding:30px;box-shadow:0 10px 25px rgba(0,0,0,.5);border:1px solid #334155;text-align:center;flex:1;min-width:280px}
    h1{margin-top:0;color:#f8fafc;font-weight:600;font-size:20px;margin-bottom:24px}
    .ratio-container{position:relative;width:160px;height:160px;margin:20px auto}
    .circle{fill:none;stroke-width:12;stroke-linecap:round}
    .circle-bg{stroke:#334155}
    .circle-progress{stroke:#3b82f6}
    .circle-progress-intent{stroke:#a855f7}
    .ratio-text{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:36px;font-weight:700;color:#60a5fa}
    .ratio-text-intent{color:#c084fc}
    .stats{display:flex;justify-content:space-between;margin-top:20px;padding-top:16px;border-top:1px solid #334155}
    .stat-box{flex:1}
    .stat-value{font-size:20px;font-weight:600;color:#f8fafc}
    .stat-label{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
    .error{color:#ef4444;background:#7f1d1d33;padding:12px;border-radius:8px;margin-top:16px}
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Token Usage Ratio</h1>
      ${errorMsg ? `<div class="error">${errorMsg}</div>` : `
      <div class="ratio-container">
        <svg viewBox="0 0 100 100">
          <circle class="circle circle-bg" cx="50" cy="50" r="40"></circle>
          <circle class="circle circle-progress" cx="50" cy="50" r="40"
            stroke-dasharray="${Math.round(251.2 * tokenRatio)} 251.2"
            transform="rotate(-90 50 50)"></circle>
        </svg>
        <div class="ratio-text">${tokenRatio.toFixed(2)}</div>
      </div>
      <div class="stats">
        <div class="stat-box"><div class="stat-value">${tokenNumber}</div><div class="stat-label">Tokens Used</div></div>
        <div class="stat-box"><div class="stat-value">${BASELINE_THRESHOLD}</div><div class="stat-label">Threshold</div></div>
      </div>`}
    </div>
    <div class="card">
      <h1>Intent Ratio</h1>
      ${errorMsg ? `<div class="error">Skipped due to error.</div>` : `
      <div class="ratio-container">
        <svg viewBox="0 0 100 100">
          <circle class="circle circle-bg" cx="50" cy="50" r="40"></circle>
          <circle class="circle circle-progress-intent" cx="50" cy="50" r="40"
            stroke-dasharray="${Math.round(251.2 * intentRatio)} 251.2"
            transform="rotate(-90 50 50)"></circle>
        </svg>
        <div class="ratio-text ratio-text-intent">${intentRatio.toFixed(2)}</div>
      </div>
      <div class="stats">
        <div class="stat-box"><div class="stat-value">Claude</div><div class="stat-label">Model</div></div>
        <div class="stat-box"><div class="stat-value">1.00</div><div class="stat-label">Max Bound</div></div>
      </div>`}
    </div>
  </div>
</body>
</html>`;
  res.send(uiHtml);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});