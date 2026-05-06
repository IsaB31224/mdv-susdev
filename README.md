# Prompt Sustainability Analyzer

A browser-based tool that measures the environmental footprint of LLM conversations. Built for the AI in the Box 2026 Hackathon at the University of Leeds.

## What it does

You upload a JSON file of an AI conversation. The tool scores it across three dimensions:

- **T — Token Ratio** how much of a typical token budget the conversation uses, computed locally using js-tiktoken
- **S — Structural Weight** how complex the prompt is to process — turns, tools, nesting — scored by Claude
- **I — Intent Weight** how cognitively demanding the user's request is — scored by Claude

These three scores feed into an energy estimate which is translated into real-world equivalents — kettle boils, seconds of HD streaming, LED bulb minutes, phone charge percentage — and projected to 30-day and 1-year personal footprints, then scaled to collective UK impact.

A phrase efficiency feature identifies specific words and phrases in the conversation that cost tokens without adding meaning — filler words, padding phrases, redundant qualifiers — and highlights them in context. It annotates rather than rewrites, keeping human intent intact.

## Architecture

The entire scoring engine runs inside [BrowserPod](https://browserpod.io) — a WebAssembly-based Node.js runtime that executes within the user's browser tab. There is no backend server. Each user boots their own pod locally. BrowserPod generates a publicly accessible Portal URL that serves a live judge view of the results, auto-refreshing every 5 seconds.

## Tech stack

- React 19 + TypeScript + Vite
- Tailwind CSS v4 + shadcn/ui
- BrowserPod (WebAssembly Node.js runtime)
- Express.js (runs inside the pod)
- js-tiktoken (token counting inside the pod)
- Anthropic Claude API (S and I scoring, phrase efficiency)

## Running locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome. BrowserPod will boot automatically — allow 60–90 seconds for the engine to initialise.

## Environment variables

Copy `.env.example` to `.env` and fill in your keys:

```
VITE_BP_APIKEY=your-browserpod-api-key
VITE_ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```


Get a BrowserPod API key at [console.browserpod.io](https://console.browserpod.io) and an Anthropic key at [console.anthropic.com](https://console.anthropic.com).

## Supported input formats

The tool accepts two JSON formats:

**Claude.ai conversation exports** — exported directly from claude.ai with `sender` and `text` fields

**OpenAI-style prompt files** — with `messages` array using `role` and `content` fields, plus optional `functions` array for tool definitions

## Validated against

356 real Claude.ai conversations ranked by prompting inefficiency across filler word density, padding phrase density, redundant turn patterns, and information density. The algorithm correctly differentiates high, mid, and low efficiency prompting.

## Hackathon

Built at AI in the Box 2026, University of Leeds, May 2–3 2026. Entered for the Sustainability & Environment special category.
