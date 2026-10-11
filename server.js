// Messenger bot powered by OpenRouter free models.
// Env vars: PAGE_ACCESS_TOKEN, VERIFY_TOKEN, OPENROUTER_API_KEY,
//           OPENROUTER_MODEL (optional), SYSTEM_PROMPT (optional),
//           ADMIN_PSID (optional), PORT (optional)
//
// Chat commands (sent to the bot on Messenger):
//   /model            - show the current model
//   /model list       - list free models available on OpenRouter
//   /model <model-id> - switch to another model (e.g. /model google/gemma-4-26b-a4b-it:free)
// The switch applies instantly and lasts until the service restarts.
// Set ADMIN_PSID to your sender id to restrict /model to yourself.

const express = require('express');
const app = express();
app.use(express.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'openrouter-bot-token';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';
let currentModel = MODEL; // runtime override via the /model chat command
const ADMIN_PSID = process.env.ADMIN_PSID || ''; // optional: restrict /model to one sender
// Models to try automatically if the current one errors (comma-separated).
const FALLBACK_MODELS = (process.env.FALLBACK_MODELS ||
  'google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,thinkingmachines/inkling:free')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = 60000;
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a friendly, helpful assistant chatting on Facebook Messenger. Keep replies concise and conversational.';
const GRAPH_VERSION = 'v21.0';
const MAX_HISTORY = 20; // messages kept per user (10 exchanges)
const MSG_LIMIT = 2000; // Messenger text limit

// In-memory chat history per sender id. (Restarts clear it; use Redis/DB for persistence.)
const conversations = new Map();

app.get('/', (_req, res) => res.send('Messenger OpenRouter bot is running.'));
app.get('/health', (_req, res) => res.json({ ok: true, model: currentModel }));

// Webhook verification (Meta calls this once when you save the webhook URL)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming Messenger events
app.post('/webhook', (req, res) => {
  res.sendStatus(200); // acknowledge immediately so Meta doesn't retry
  (async () => {
    try {
      const body = req.body;
      if (body.object !== 'page') return;
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const psid = event.sender && event.sender.id;
          if (!psid) continue;
          if (event.postback) {
            await handleMessage(psid, event.postback.payload || 'hi');
          } else if (event.message && !event.message.is_echo && event.message.text) {
            await handleMessage(psid, event.message.text);
          } else if (event.message && !event.message.is_echo && !event.message.text) {
            await handleNonText(psid);
          }
        }
      }
    } catch (err) {
      console.error('webhook error:', err.message);
    }
  })();
});

async function handleMessage(psid, text) {
  if (!PAGE_ACCESS_TOKEN || !OPENROUTER_API_KEY) {
    console.error('Missing PAGE_ACCESS_TOKEN or OPENROUTER_API_KEY env vars.');
    return;
  }
  if (text.trim().toLowerCase().startsWith('/model')) {
    await handleModelCommand(psid, text.trim());
    return;
  }
  await setTyping(psid, true);
  try {
    const history = conversations.get(psid) || [];
    history.push({ role: 'user', content: text });
    const reply = await askOpenRouter(history);
    history.push({ role: 'assistant', content: reply });
    conversations.set(psid, history.slice(-MAX_HISTORY));
    for (const chunk of chunkText(reply)) {
      await sendText(psid, chunk);
    }
  } catch (err) {
    console.error('reply error:', err.message);
    await sendText(psid, 'Sorry, I ran into an error. Try again in a moment.');
  } finally {
    await setTyping(psid, false);
  }
}

// /model chat commands: view, list, or switch the active OpenRouter model.
async function handleModelCommand(psid, text) {
  if (ADMIN_PSID && psid !== ADMIN_PSID) {
    await sendText(psid, 'Only the bot owner can change the model.');
    return;
  }
  const arg = text.slice('/model'.length).trim();
  if (!arg) {
    await sendText(
      psid,
      `Current model: ${currentModel}\n\n/model list - show free models\n/model <model-id> - switch models`
    );
    return;
  }
  if (arg.toLowerCase() === 'list') {
    try {
      const ids = await fetchModelIds();
      const free = ids.filter((id) => id.endsWith(':free'));
      const list = free.length ? free : ids.slice(0, 30);
      await sendText(psid, 'Free models:\n' + list.map((id) => '- ' + id).join('\n'));
    } catch (err) {
      console.error('model list error:', err.message);
      await sendText(psid, 'Sorry, I ran into an error. Try again in a moment.');
    }
    return;
  }
  try {
    const ids = await fetchModelIds();
    if (!ids.includes(arg)) {
      await sendText(psid, `Couldn't find "${arg}" on OpenRouter. Send /model list to see what's available.`);
      return;
    }
  } catch (err) {
    console.error('model check error:', err.message);
    await sendText(psid, 'Sorry, I ran into an error. Try again in a moment.');
    return;
  }
  currentModel = arg;
  console.log('Model switched to ' + arg + ' by ' + psid);
  await sendText(psid, `Switched to ${arg}.`);
}

// Cached OpenRouter model catalogue (refreshed hourly).
let modelCache = { at: 0, ids: [] };
async function fetchModelIds() {
  if (modelCache.ids.length && Date.now() - modelCache.at < 3600e3) return modelCache.ids;
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error('models list ' + res.status);
  const data = await res.json();
  modelCache = { at: Date.now(), ids: (data.data || []).map((m) => m.id) };
  return modelCache.ids;
}

// Friendly reply for stickers, photos, and other non-text messages.
async function handleNonText(psid) {
  if (!PAGE_ACCESS_TOKEN) return;
  try {
    await sendText(psid, 'I can only read text messages for now — send me text and I\'ll reply.');
  } catch (err) {
    console.error('non-text reply error:', err.message);
  }
}

// Tries the current model, then fallbacks; retries transient failures.
async function askOpenRouter(history) {
  const models = [currentModel, ...FALLBACK_MODELS.filter((m) => m !== currentModel)];
  let lastErr = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await completeWithModel(model, history);
      } catch (err) {
        lastErr = err;
        console.error(`model ${model} attempt ${attempt} failed:`, err.message);
        if (err.authFailed) throw err; // bad API key — other models won't help
        if (!err.transient || attempt === 2) break;
        await sleep(2000 * attempt);
      }
    }
  }
  throw lastErr;
}

async function completeWithModel(model, history) {
  let res;
  try {
    res = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + OPENROUTER_API_KEY,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/',
          'X-Title': 'Messenger OpenRouter Bot',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-MAX_HISTORY)],
        }),
      },
      REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    throw transientError('network/timeout: ' + err.message);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw orError(res.status, body);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (content || "I didn't get a reply from the AI. Try again.").trim();
}

function orError(status, body) {
  const err = new Error('OpenRouter ' + status + ': ' + body.slice(0, 200));
  err.status = status;
  err.transient = status === 429 || status >= 500;
  err.authFailed = status === 401 || status === 403;
  return err;
}

function transientError(message) {
  const err = new Error(message);
  err.transient = true;
  return err;
}

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Validates the OpenRouter API key once at startup so a bad key shows up
// in the logs immediately instead of failing on the first message.
async function validateApiKey() {
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set — the bot will stay silent.');
    return;
  }
  try {
    const res = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/auth/key',
      { headers: { Authorization: 'Bearer ' + OPENROUTER_API_KEY } },
      15000
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('OPENROUTER_API_KEY check failed: HTTP ' + res.status + ' ' + body.slice(0, 200));
    } else {
      console.log('OpenRouter API key OK.');
    }
  } catch (err) {
    console.error('OPENROUTER_API_KEY check error:', err.message);
  }
}

async function graph(path, payload) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}${path}?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Graph API ' + res.status + ': ' + body.slice(0, 200));
  }
}

function sendText(psid, text) {
  return graph('/me/messages', {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { text },
  });
}

function setTyping(psid, on) {
  return graph('/me/messages', {
    recipient: { id: psid },
    sender_action: on ? 'typing_on' : 'typing_off',
  }).catch((err) => console.error('typing error:', err.message));
}

function chunkText(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > MSG_LIMIT) {
    let cut = rest.lastIndexOf('\n', MSG_LIMIT);
    if (cut < MSG_LIMIT / 2) cut = MSG_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Bot listening on port ' + PORT);
  validateApiKey();
});
