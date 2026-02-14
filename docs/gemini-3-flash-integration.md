# Gemini 3 Flash — Integration Reference (Feb 2026)

## Model Info
- **Model ID (Gemini API):** `gemini-3-flash-preview`
- **Vertex AI ID:** `gemini-3-flash-preview`
- **Status:** Public Preview (released Dec 17, 2025)
- **Knowledge cutoff:** January 2025

## API Endpoint
```
https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent
```

## Pricing (per 1M tokens)
- **Input:** $0.50 (same tier as 2.5 Flash)
- **Output:** $3.00
- **Cached input:** $0.05 (90% discount)
- Free tier available in AI Studio for low-volume use

## Capabilities
- 1,048,576 token context window (1M)
- 65,536 max output tokens
- Inputs: text, code, images, audio, video, PDF
- Output: text
- Supports: structured output (JSON mode), function calling, streaming, system instructions, thinking levels
- Thinking level parameter: minimal, low, medium, high

## Key Improvements over 2.0 Flash
- Near-Pro level reasoning at Flash latency/cost
- Better agentic workflows and multi-turn function calling
- Native tool use with thought signatures
- Media resolution control (low/medium/high/ultra high)
- Streaming function calling

## API Call Example
```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{"parts": [{"text": "Your prompt here"}]}],
    "generationConfig": {
      "response_mime_type": "application/json"
    }
  }'
```

## What to change in ctx
- **File:** `src/steering/llm.ts`
- **Old URL:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
- **New URL:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent`
- API request/response format is the same — no other changes needed
