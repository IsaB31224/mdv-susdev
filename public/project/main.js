require('dotenv').config();
const express = require('express');
const { encodingForModel, getEncoding } = require("js-tiktoken");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const port = 3000;

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
const WH_PER_TOKEN = 0.0003;
const S_WEIGHT = 0.6;
const I_WEIGHT = 0.4;
const KETTLE_BOIL_WH = 0.025;
const STREAM_WH_PER_SEC = 0.001;
const LED_WH_PER_MIN = 0.01;
const PHONE_BATTERY_WH = 12;
const DAILY_SESSIONS = 10;

// In-memory store of last analysis result
let lastScores = null;

function sig2(n) {
  if (n < 0.001) return '< 0.001';
  return parseFloat(n.toPrecision(2)).toString();
}

function computeEnergy(T, S, I) {
  const baseWh = T * WH_PER_TOKEN;
  const complexityMult = 1 + S * S_WEIGHT + I * I_WEIGHT;
  return baseWh * complexityMult;
}

function fmtWh(wh) {
  if (wh >= 1000) return sig2(wh / 1000) + ' kWh';
  if (wh >= 1) return sig2(wh) + ' Wh';
  return sig2(wh * 1000) + ' mWh';
}

function scoreColor(score, lo, hi) {
  if (score < lo) return '#22c55e';
  if (score < hi) return '#f59e0b';
  return '#ef4444';
}

function energyColor(wh) {
  if (wh < 0.0005) return '#22c55e';
  if (wh < 0.002) return '#f59e0b';
  return '#ef4444';
}

function gaugeArc(score) {
  return Math.round(251.2 * score);
}

function numTokensFromMessages(messages, model = "gpt-4o-mini-2024-07-18") {
  let encoding;
  try {
    encoding = encodingForModel(model);
  } catch (e) {
    encoding = getEncoding("o200k_base");
  }

  const exactModels = new Set([
    "gpt-3.5-turbo-0125","gpt-4-0314","gpt-4-32k-0314",
    "gpt-4-0613","gpt-4-32k-0613","gpt-4o-mini-2024-07-18","gpt-4o-2024-08-06"
  ]);

  let tokensPerMessage = 3;
  let tokensPerName = 1;

  if (exactModels.has(model)) {
    tokensPerMessage = 3; tokensPerName = 1;
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
      if (key === "name") numTokens += tokensPerName;
    }
  }
  numTokens += 3;
  return numTokens;
}

function numTokensForTools(functions, messages, model) {
  let funcInit = 0, propInit = 0, propKey = 0, enumInit = 0, enumItem = 0, funcEnd = 0;

  if (["gpt-4o","gpt-4o-mini"].includes(model)) {
    funcInit=7; propInit=3; propKey=3; enumInit=-3; enumItem=3; funcEnd=12;
  } else if (["gpt-3.5-turbo","gpt-4"].includes(model)) {
    funcInit=10; propInit=3; propKey=3; enumInit=-3; enumItem=3; funcEnd=12;
  }

  let encoding;
  try { encoding = encodingForModel(model); }
  catch (e) { encoding = getEncoding("o200k_base"); }

  let funcTokenCount = 0;
  if (functions.length > 0) {
    for (const f of functions) {
      funcTokenCount += funcInit;
      const functionDef = f.function;
      const fName = functionDef.name;
      let fDesc = functionDef.description || "";
      if (fDesc.endsWith(".")) fDesc = fDesc.slice(0, -1);
      funcTokenCount += encoding.encode(`${fName}:${fDesc}`).length;
      const properties = functionDef.parameters?.properties || {};
      if (Object.keys(properties).length > 0) {
        funcTokenCount += propInit;
        for (const key of Object.keys(properties)) {
          funcTokenCount += propKey;
          let pDesc = properties[key].description || "";
          if (properties[key].enum) {
            funcTokenCount += enumInit;
            for (const item of properties[key].enum) {
              funcTokenCount += enumItem;
              funcTokenCount += encoding.encode(String(item)).length;
            }
          }
          if (pDesc.endsWith(".")) pDesc = pDesc.slice(0, -1);
          funcTokenCount += encoding.encode(`${key}:${properties[key].type}:${pDesc}`).length;
        }
      }
    }
    funcTokenCount += funcEnd;
  }
  return numTokensFromMessages(messages, model) + funcTokenCount;
}

function loadJsonFile(p) {
  let rawData;
  try { rawData = fs.readFileSync(p, "utf8"); }
  catch (err) { rawData = "{}"; }
  const data = JSON.parse(rawData);
  const rawMessages = data.messages || [];
  const isClaudeExport = rawMessages.length > 0 && "sender" in rawMessages[0];
  const messages = isClaudeExport
    ? rawMessages.map(m => ({ role: m.sender === "human" ? "user" : "assistant", content: m.text ?? "" }))
    : rawMessages;
  const functions = data.functions || [];
  return { functions, messages, raw: rawData };
}

function loadPromptData() {
  const uploadedPath = path.join(__dirname, "prompt_data.json");
  const examplePath = path.join(__dirname, "prompt_data_example.json");
  return loadJsonFile(fs.existsSync(uploadedPath) ? uploadedPath : examplePath);
}

app.get('/analyze', async (req, res) => {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { functions, messages, raw } = loadPromptData();

  if (functions.length === 0 && messages.length === 0)
    return res.status(422).json({ error: "Prompt data is empty or could not be read." });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: "ANTHROPIC_API_KEY is not set." });

  let tokenRatio = 0, intentRatio = 0, structuralScore = 0;

  try {
    const tokenNumber = numTokensForTools(functions, messages, "gpt-4o");
    tokenRatio = Math.min(1, tokenNumber / BASELINE_THRESHOLD);

    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const userMessage = lastUserMsg ? String(lastUserMsg.content) : '';

    const intentResp = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 50,
      messages: [{ role: "user", content: `You are a cognitive load classifier. Assign an Intent Weight (I) between 0.1 and 1.0 based on the complexity of the following user request.\n\nRubric:\n0.1 - 0.2: Simple greetings or basic Yes/No.\n0.3 - 0.4: Basic fact retrieval.\n0.5 - 0.6: Summarization or formatting.\n0.7 - 0.8: Technical debugging or code writing.\n0.9 - 1.0: Deep architectural design or strategy.\n\nUser Message: "${userMessage}"\n\nReturn ONLY the numerical float value.` }]
    });
    const intentMatch = intentResp.content[0].text.trim().match(/\d+\.?\d*/);
    intentRatio = intentMatch ? Math.min(1.0, Math.max(0.0, parseFloat(intentMatch[0]))) : 0.5;

    const structResp = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 50,
      messages: [{ role: "user", content: `You are a structural complexity classifier. Analyze the following LLM API request and assign a Structural Weight (S) between 0.1 and 1.0.\n\nRubric:\n0.1 - 0.2: Simple single-turn message, no tools.\n0.3 - 0.4: A few messages or basic tool definitions.\n0.5 - 0.6: Multi-turn conversation or moderate tool complexity.\n0.7 - 0.8: Multiple tools with detailed parameters and enum constraints.\n0.9 - 1.0: Complex multi-tool systems with deep nesting and long conversation history.\n\nRequest:\n${raw}\n\nReturn ONLY the numerical float value.` }]
    });
    const structMatch = structResp.content[0].text.trim().match(/\d+\.?\d*/);
    structuralScore = structMatch ? Math.min(1.0, Math.max(0.0, parseFloat(structMatch[0]))) : 0.5;

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Store in memory for the display page
  lastScores = { tokenRatio, intentRatio, structuralScore, timestamp: new Date().toISOString() };

  res.json({ tokenRatio, intentRatio, structuralScore });
});

// Judge display page — publicly accessible via portal URL
app.get('/', (req, res) => {
  if (!lastScores) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="3">
  <title>Prompt Sustainability Analyzer</title>
  <style>
    body{margin:0;font-family:-apple-system,sans-serif;background:#0a1a0f;color:#86efac;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
    .leaf{font-size:48px;margin-bottom:16px}
    h1{font-size:22px;font-weight:600;color:#f0fdf4;margin:0 0 8px}
    p{font-size:14px;color:#4ade80;margin:0}
  </style>
</head>
<body>
  <div>
    <div class="leaf">🌿</div>
    <h1>Prompt Sustainability Analyzer</h1>
    <p>Waiting for analysis to complete...</p>
  </div>
</body>
</html>`);
  }

  const { tokenRatio, intentRatio, structuralScore, timestamp } = lastScores;
  const energyWh = computeEnergy(tokenRatio, structuralScore, intentRatio);

  // Environmental translations
  const kettleBoils = energyWh / KETTLE_BOIL_WH;
  const kettleSeconds = kettleBoils * 120;
  const streamingSeconds = energyWh / STREAM_WH_PER_SEC;
  const ledMinutes = energyWh / LED_WH_PER_MIN;
  const phoneChargePct = (energyWh / PHONE_BATTERY_WH) * 100;

  // Projections
  const daily = energyWh * DAILY_SESSIONS;
  const monthly = daily * 30;
  const yearly = daily * 365;
  const ukYearlyKWh = (yearly * 1000000) / 1000;
  const householdsEquivalent = Math.round(ukYearlyKWh / 3500);

  const tColor = scoreColor(tokenRatio, 0.4, 0.75);
  const sColor = scoreColor(structuralScore, 0.35, 0.7);
  const iColor = scoreColor(intentRatio, 0.4, 0.75);
  const eColor = energyColor(energyWh);

  const time = new Date(timestamp).toLocaleTimeString('en-GB');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="5">
  <title>Prompt Sustainability Analyzer</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,sans-serif;background:#0a1a0f;color:#f0fdf4;min-height:100vh;padding:24px 16px}
    .header{text-align:center;margin-bottom:28px}
    .leaf-icon{width:48px;height:48px;background:#14532d;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:24px}
    h1{font-size:22px;font-weight:700;color:#f0fdf4;margin-bottom:4px}
    .subtitle{font-size:13px;color:#4ade80}
    .timestamp{font-size:11px;color:#166534;margin-top:4px}
    .section-title{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#4ade80;margin-bottom:12px;padding-left:2px}
    .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
    .card{background:#052e16;border:1px solid #14532d;border-radius:12px;padding:14px;text-align:center}
    .card-letter{font-size:18px;font-weight:700;color:#4ade80;font-family:monospace}
    .card-name{font-size:10px;color:#166534;margin-bottom:8px}
    .gauge-wrap{position:relative;width:72px;height:72px;margin:0 auto 6px}
    .gauge-wrap svg{transform:rotate(-90deg)}
    .gauge-val{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:14px;font-weight:700;font-family:monospace}
    .card-label{font-size:11px;font-weight:500}
    .impact-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px}
    .impact-item{background:#052e16;border:1px solid #14532d;border-radius:10px;padding:12px}
    .impact-icon{font-size:16px;margin-bottom:4px}
    .impact-label{font-size:10px;color:#166534;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}
    .impact-val{font-size:18px;font-weight:700;font-family:monospace;color:#4ade80}
    .impact-sentence{font-size:10px;color:#166534;margin-top:3px;line-height:1.4}
    .projection{background:#052e16;border:1px solid #14532d;border-radius:12px;padding:16px;margin-bottom:20px}
    .proj-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
    .proj-item{text-align:center}
    .proj-period{font-size:10px;color:#166534;margin-bottom:2px}
    .proj-val{font-size:14px;font-weight:700;font-family:monospace;color:#f0fdf4}
    .proj-sub{font-size:10px;color:#166534}
    .divider{border:none;border-top:1px solid #14532d;margin:12px 0}
    .scale-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .scale-item{text-align:center}
    .nudge{font-size:11px;color:#4ade80;line-height:1.5;margin-top:10px}
    .framing{background:#052e16;border:1px solid #166534;border-radius:12px;padding:14px;display:flex;gap:10px;align-items:flex-start}
    .framing-text{font-size:12px;line-height:1.6;font-weight:500}
    .live-dot{display:inline-block;width:6px;height:6px;background:#4ade80;border-radius:50%;margin-right:4px;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
  </style>
</head>
<body>
  <div class="header">
    <div class="leaf-icon">🌿</div>
    <h1>Prompt Sustainability Analyzer</h1>
    <div class="subtitle">Live environmental footprint analysis</div>
    <div class="timestamp"><span class="live-dot"></span>Last updated ${time} · refreshes every 5s</div>
  </div>

  <div class="section-title">MDV Scores</div>
  <div class="cards">
    <div class="card">
      <div class="card-letter">T</div>
      <div class="card-name">Token Ratio</div>
      <div class="gauge-wrap">
        <svg width="72" height="72" viewBox="0 0 100 100">
          <circle fill="none" stroke="#14532d" stroke-width="12" cx="50" cy="50" r="40"/>
          <circle fill="none" stroke="${tColor}" stroke-width="12" stroke-linecap="round" cx="50" cy="50" r="40"
            stroke-dasharray="${gaugeArc(tokenRatio)} 251.2"/>
        </svg>
        <div class="gauge-val" style="color:${tColor}">${tokenRatio.toFixed(2)}</div>
      </div>
      <div class="card-label" style="color:${tColor}">${tokenRatio < 0.4 ? 'Efficient' : tokenRatio < 0.75 ? 'Moderate' : 'High'}</div>
    </div>
    <div class="card">
      <div class="card-letter">S</div>
      <div class="card-name">Structural</div>
      <div class="gauge-wrap">
        <svg width="72" height="72" viewBox="0 0 100 100">
          <circle fill="none" stroke="#14532d" stroke-width="12" cx="50" cy="50" r="40"/>
          <circle fill="none" stroke="${sColor}" stroke-width="12" stroke-linecap="round" cx="50" cy="50" r="40"
            stroke-dasharray="${gaugeArc(structuralScore)} 251.2"/>
        </svg>
        <div class="gauge-val" style="color:${sColor}">${structuralScore.toFixed(2)}</div>
      </div>
      <div class="card-label" style="color:${sColor}">${structuralScore < 0.35 ? 'Efficient' : structuralScore < 0.7 ? 'Moderate' : 'High'}</div>
    </div>
    <div class="card">
      <div class="card-letter">I</div>
      <div class="card-name">Intent</div>
      <div class="gauge-wrap">
        <svg width="72" height="72" viewBox="0 0 100 100">
          <circle fill="none" stroke="#14532d" stroke-width="12" cx="50" cy="50" r="40"/>
          <circle fill="none" stroke="${iColor}" stroke-width="12" stroke-linecap="round" cx="50" cy="50" r="40"
            stroke-dasharray="${gaugeArc(intentRatio)} 251.2"/>
        </svg>
        <div class="gauge-val" style="color:${iColor}">${intentRatio.toFixed(2)}</div>
      </div>
      <div class="card-label" style="color:${iColor}">${intentRatio < 0.4 ? 'Efficient' : intentRatio < 0.75 ? 'Moderate' : 'High'}</div>
    </div>
  </div>

  <div class="section-title">Environmental impact</div>
  <div class="impact-grid">
    <div class="impact-item">
      <div class="impact-icon">⚡</div>
      <div class="impact-label">Kettle boil</div>
      <div class="impact-val" style="color:${kettleBoils < 0.04 ? '#22c55e' : kettleBoils < 0.16 ? '#f59e0b' : '#ef4444'}">
        ${kettleBoils < 0.1 ? sig2(kettleSeconds) + 's' : sig2(kettleBoils) + '×'}
      </div>
      <div class="impact-sentence">${kettleBoils < 0.1 ? `About ${sig2(kettleSeconds)} seconds of boiling your kettle.` : `As much energy as ${sig2(kettleBoils)} kettle boils.`}</div>
    </div>
    <div class="impact-item">
      <div class="impact-icon">📺</div>
      <div class="impact-label">HD streaming</div>
      <div class="impact-val" style="color:${streamingSeconds < 0.5 ? '#22c55e' : streamingSeconds < 2 ? '#f59e0b' : '#ef4444'}">
        ${streamingSeconds < 60 ? sig2(streamingSeconds) + 's' : sig2(streamingSeconds/60) + ' min'}
      </div>
      <div class="impact-sentence">${streamingSeconds < 60 ? `Equivalent to streaming ${sig2(streamingSeconds)} seconds of HD video.` : `Equivalent to ${sig2(streamingSeconds/60)} minutes of HD streaming.`}</div>
    </div>
    <div class="impact-item">
      <div class="impact-icon">💡</div>
      <div class="impact-label">LED bulb</div>
      <div class="impact-val" style="color:${ledMinutes < 0.05 ? '#22c55e' : ledMinutes < 0.2 ? '#f59e0b' : '#ef4444'}">
        ${ledMinutes < 60 ? sig2(ledMinutes) + ' min' : sig2(ledMinutes/60) + ' hrs'}
      </div>
      <div class="impact-sentence">Powers a light bulb for ${ledMinutes < 60 ? sig2(ledMinutes) + ' minutes.' : sig2(ledMinutes/60) + ' hours.'}</div>
    </div>
    <div class="impact-item">
      <div class="impact-icon">📱</div>
      <div class="impact-label">Phone charge</div>
      <div class="impact-val" style="color:${phoneChargePct < 0.005 ? '#22c55e' : phoneChargePct < 0.02 ? '#f59e0b' : '#ef4444'}">
        ${sig2(phoneChargePct)}%
      </div>
      <div class="impact-sentence">About ${sig2(phoneChargePct)}% of a single phone charge.</div>
    </div>
  </div>

  <div class="section-title">Usage projection</div>
  <div class="projection">
    <div class="proj-row">
      <div class="proj-item">
        <div class="proj-period">Per day</div>
        <div class="proj-val">${fmtWh(daily)}</div>
        <div class="proj-sub">${sig2(daily/KETTLE_BOIL_WH)} kettle boils</div>
      </div>
      <div class="proj-item">
        <div class="proj-period">30 days</div>
        <div class="proj-val">${fmtWh(monthly)}</div>
        <div class="proj-sub">${sig2(monthly/KETTLE_BOIL_WH)} kettle boils</div>
      </div>
      <div class="proj-item">
        <div class="proj-period">1 year</div>
        <div class="proj-val">${fmtWh(yearly)}</div>
        <div class="proj-sub">${sig2(yearly/KETTLE_BOIL_WH)} kettle boils</div>
      </div>
    </div>
    <hr class="divider">
    <div class="scale-row">
      <div class="scale-item">
        <div class="proj-period">1M UK users · monthly</div>
        <div class="proj-val">${fmtWh(monthly * 1000000)}</div>
      </div>
      <div class="scale-item">
        <div class="proj-period">Annual equivalent</div>
        <div class="proj-val">${householdsEquivalent > 0 ? householdsEquivalent.toLocaleString() + ' homes' : fmtWh(ukYearlyKWh * 1000)}</div>
      </div>
    </div>
    <div class="nudge">A 30% reduction in prompt complexity across 1M users saves ${Math.round(householdsEquivalent * 0.3) > 0 ? Math.round(householdsEquivalent * 0.3).toLocaleString() + ' UK homes' : 'significant energy'} worth of annual energy. Small habits, scaled, matter.</div>
  </div>

  <div class="section-title">Summary</div>
  <div class="framing">
    <div>🌱</div>
    <div class="framing-text" style="color:${eColor}">
      Total estimated energy: ${energyWh.toPrecision(2)} Wh —
      ${energyWh < 0.0005 ? 'negligible footprint. This conversation is highly efficient.' : energyWh < 0.002 ? 'modest footprint. Consider simplifying structure or intent for repeated use.' : 'notable footprint. Prompt redesign could meaningfully reduce energy cost.'}
    </div>
  </div>
</body>
</html>`);
});


app.get('/suggest-test', async (req, res) => {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  const testSentence = "I was wondering if you could possibly help me understand how the token counting system works in large language models.";
  
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `You are a prompt efficiency expert. Given this sentence from an LLM prompt, generate exactly one semantically equivalent alternative that is shorter and more direct. Preserve the complete meaning and intent. Do not change what is being asked.

Original sentence: "${testSentence}"

Return ONLY the alternative sentence as plain text. No explanation, no quotes, no other text.`
      }]
    });

    const alternative = response.content[0].text.trim();
    const originalTokens = testSentence.split(' ').length;
    const alternativeTokens = alternative.split(' ').length;
    const saving = Math.round(((originalTokens - alternativeTokens) / originalTokens) * 100);

    res.json({
      original: testSentence,
      alternative,
      tokenSaving: saving
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/suggest', async (req, res) => {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { messages } = loadPromptData();

  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return res.json([]);

  // Extract sentences with surrounding context
  const allSentences = [];
  for (const msg of userMessages) {
    const content = String(msg.content);
    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 30);

    for (let i = 0; i < sentences.length; i++) {
      allSentences.push({
        sentence: sentences[i],
        before: i > 0 ? sentences[i - 1] : null,
        after: i < sentences.length - 1 ? sentences[i + 1] : null
      });
    }
  }

  // Pick top 5 longest sentences
  const top5 = allSentences
    .sort((a, b) => b.sentence.length - a.sentence.length)
    .slice(0, 5);

  if (top5.length === 0) return res.json([]);

  const results = [];

  for (const item of top5) {
    const contextBlock = [
      item.before ? `Previous: "${item.before}"` : null,
      `Sentence: "${item.sentence}"`,
      item.after ? `Next: "${item.after}"` : null
    ].filter(Boolean).join('\n');

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `You are a balanced prompt efficiency analyst. Your job is to identify specific words or short phrases within a sentence that are likely wasteful — filler words, padding phrases, or redundant qualifiers that add tokens without meaningfully contributing to clarity or intent.

Rules:
- Flag things that are likely wasteful. Use judgment — if a phrase adds politeness or necessary nuance in context, note this but still flag it.
- Do NOT rewrite sentences. Only identify specific phrases within the original sentence.
- Do NOT flag words that carry tone, politeness, or necessary nuance.
- Maximum 3 findings per sentence.
- If nothing is clearly wasteful, return an empty array.

Categories:
- filler: single words like "basically", "literally", "actually", "just", "simply", "very", "quite", "honestly", "obviously"
- padding: multi-word phrases like "I was wondering if", "would it be possible to", "in order to", "at this point in time", "due to the fact that"
- redundant_qualifier: word pairs where the modifier adds nothing, like "completely finished", "very unique", "past history", "end result", "future plans"

Context:
${contextBlock}

Return ONLY a valid JSON array. Each item must have:
- "phrase": the exact text as it appears in the sentence
- "category": one of filler, padding, redundant_qualifier
- "suggestion": what to replace it with, or empty string if it should just be removed
- "reason": one short sentence explaining why this is wasteful

Example: [{"phrase":"basically","category":"filler","suggestion":"","reason":"Adds no meaning to the sentence."}]

If nothing qualifies, return: []`
        }]
      });

      let findings = [];
      try {
        const text = response.content[0].text.trim();
        const clean = text.replace(/```json|```/g, '').trim();
        findings = JSON.parse(clean);
        if (!Array.isArray(findings)) findings = [];
      } catch (e) {
        findings = [];
      }

      if (findings.length > 0) {
        results.push({
          sentence: item.sentence,
          findings
        });
      }

    } catch (e) {
      // skip failed sentence silently
    }
  }

  res.json(results);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});