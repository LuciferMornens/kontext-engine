# GPT-5 Mini — Integration Reference (Feb 2026)

## Model Info
- **Model ID:** `gpt-5-mini`
- **Snapshot:** `gpt-5-mini-2025-08-07`
- **Status:** Stable (released Aug 7, 2025)
- **Knowledge cutoff:** May 31, 2024

## API Endpoint
```
https://api.openai.com/v1/chat/completions
```
(Same endpoint, just change the model name)

## Pricing (per 1M tokens)
- **Input:** $0.25
- **Cached input:** $0.025
- **Output:** $2.00

### Comparison
| Model | Input | Output |
|-------|-------|--------|
| GPT-5 | $1.25 | — |
| GPT-5 mini | $0.25 | $2.00 |
| GPT-5 nano | $0.05 | — |
| GPT-4o-mini (old) | $0.15 | $0.60 |

## Capabilities
- 400,000 token context window
- 128,000 max output tokens
- Inputs: text, image
- Output: text
- Supports: streaming, function calling, structured outputs, reasoning tokens
- Endpoints: Chat Completions (v1/chat/completions), Responses (v1/responses), Realtime, Assistants, Batch
- Tools: web search, file search, code interpreter, MCP

## Key Improvements over GPT-4o-mini
- Significantly better reasoning (reasoning token support)
- 400K context (up from 128K)
- 128K max output (up from 16K)
- Function calling + structured outputs improved
- Part of the GPT-5 family architecture

## API Call Example
```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Your prompt here"}
    ],
    "response_format": {"type": "json_object"}
  }'
```

## What to change in ctx
- **File:** `src/steering/llm.ts`
- **Old model:** `gpt-4o-mini` (line ~129)
- **New model:** `gpt-5-mini`
- API endpoint stays the same (`v1/chat/completions`)
- Request/response format is identical — just swap the model string
