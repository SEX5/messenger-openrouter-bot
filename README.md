# Messenger bot — free AI via OpenRouter

A Facebook Messenger chatbot that answers using OpenRouter's free models.
Built with Node.js + Express. Deploy it to Render (free tier works).

## How it works

1. Someone messages your Facebook Page.
2. Meta forwards the message to this server's `/webhook`.
3. The server asks OpenRouter (free `:free` model) and replies back through Messenger.

## Setup

### 1. Get a free OpenRouter API key
- Sign up at https://openrouter.ai and create a key at https://openrouter.ai/keys
- Free tier: ~20 requests/min, ~50 requests/day (rises to ~1000/day after a one-time $10 credit purchase — credits never expire).

### 2. Deploy to Render
- Push this folder to a GitHub repo, then create a **Web Service** on Render from that repo
  (or use the `render.yaml` blueprint).
- Add these environment variables in the Render dashboard:
  - `PAGE_ACCESS_TOKEN` — from step 3
  - `VERIFY_TOKEN` — any random secret string you invent (you'll paste it into Meta too)
  - `OPENROUTER_API_KEY` — from step 1
  - `OPENROUTER_MODEL` — optional, defaults to `google/gemma-4-31b-it:free`
- Note your service URL, e.g. `https://messenger-openrouter-bot.onrender.com`

### 3. Connect it to Messenger (Meta developer dashboard)
- Go to https://developers.facebook.com/apps and create an app (type: **Business**).
- Add the **Messenger** product.
- Create or select a Facebook **Page** for the bot, and generate a **Page access token**
  (paste it into Render as `PAGE_ACCESS_TOKEN`).
- Under Messenger settings → **Webhooks**, add:
  - Callback URL: `https://<your-render-url>/webhook`
  - Verify token: the same `VERIFY_TOKEN` string from Render
  - Subscribe to webhook fields: `messages`
- Subscribe the webhook to your Page.
- Open the Page in Messenger and send it a message — the bot should reply.

### 4. (Optional) Get Started button
In the Messenger settings you can set a Get Started button / greeting text for the Page.

## Changing the model
Set `OPENROUTER_MODEL` to any free model id (see https://openrouter.ai/models?fmt=free),
e.g. `nvidia/nemotron-3-ultra-550b-a55b:free` or `openai/gpt-oss-20b:free`.

You can also switch models by chatting with the bot — no redeploy needed:
- `/model` — show the current model
- `/model list` — list free models on OpenRouter
- `/model <model-id>` — switch to another model instantly

The chat-command switch lasts until the service restarts. To stop strangers from
using it, set `ADMIN_PSID` to your own sender id (only that person can run `/model`).

## Photos
Send a photo (with or without a caption) and a vision-capable model will describe
it or answer questions about it. If your current model can't see images, the bot
automatically borrows one just for that message. `/model list` marks vision
models with `(sees images)`.

## Notes
- Chat history is kept in memory per user (last 20 messages). Restarting the server clears it.
- Long AI replies are automatically split into Messenger-sized chunks.
- Reliability: transient OpenRouter errors (rate limits, 5xx, timeouts) are retried
  automatically, then the bot falls back through `FALLBACK_MODELS` before giving up.
  A bad API key is reported in the logs at startup via `/auth/key`.
- `GET /health` returns `{ ok: true, model }` for uptime monitoring.
- Note: on Render's free tier the instance spins down when idle, so the first
  message after a while can take ~50 seconds to get a reply. A free uptime
  pinger (or a paid instance) fixes that.
