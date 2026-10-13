// Messenger bot powered by OpenRouter free models, with optional Claude
// (Anthropic) and Hugging Face providers.
// Env vars: PAGE_ACCESS_TOKEN, VERIFY_TOKEN, OPENROUTER_API_KEY,
//           OPENROUTER_MODEL (optional), SYSTEM_PROMPT (optional),
//           ADMIN_PSID (optional), PORT (optional),
//           ANTHROPIC_API_KEY (optional), ANTHROPIC_MODEL (optional),
//           HF_API_KEY (optional), HF_MODEL / HF_VISION_MODEL (optional)
//
// Chat commands (sent to the bot on Messenger):
//   /model            - show the current model
//   /model list       - list free models available on OpenRouter (vision ones marked)
//   /model <model-id> - switch to another model (e.g. /model google/gemma-4-26b-a4b-it:free)
// The switch applies instantly and lasts until the service restarts.
// Set ADMIN_PSID to your sender id to restrict /model to yourself.
//
// Photos: sending a photo (with or without a caption) gets a vision-capable
// model to describe/answer it. If the current model can't see images, the bot
// automatically borrows one for that message.

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
// Hugging Face Inference Providers — used as a final fallback when OpenRouter fails.
// Get a token at https://huggingface.co/settings/tokens (needs Inference Providers access).
const HF_API_KEY = process.env.HF_API_KEY || '';
const HF_MODEL = process.env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct';
const HF_VISION_MODEL = process.env.HF_VISION_MODEL || 'meta-llama/Llama-3.2-11B-Vision-Instruct';
const HF_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
// Anthropic (Claude) — when ANTHROPIC_API_KEY is set, Claude answers FIRST and
// OpenRouter / Hugging Face act as fallbacks. Get a key at https://console.anthropic.com/
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a friendly, helpful assistant chatting on Facebook Messenger. Keep replies concise and conversational.';
const GRAPH_VERSION = 'v21.0';
const MAX_HISTORY = 20; // messages kept per user (10 exchanges)
const MSG_LIMIT = 2000; // Messenger text limit

// In-memory chat history per sender id. (Restarts clear it; use Redis/DB for persistence.)
const conversations = new Map();
// Last /model list result per sender, so "/model 3" can pick by number.
const lastModelList = new Map();

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
          } else if (event.message && !event.message.is_echo) {
            const attachments = event.message.attachments || [];
            const images = attachments
              .filter((a) => a.type === 'image' && a.payload && a.payload.url)
              .map((a) => a.payload.url)
              .slice(0, 4);
            if (event.message.text || images.length) {
              await handleMessage(psid, event.message.text || '', images);
            } else {
              await handleNonText(psid);
            }
          }
        }
      }
    } catch (err) {
      console.error('webhook error:', err.message);
    }
  })();
});

async function handleMessage(psid, text, images = []) {
  if (!PAGE_ACCESS_TOKEN || (!OPENROUTER_API_KEY && !HF_API_KEY && !ANTHROPIC_API_KEY)) {
    console.error('Missing PAGE_ACCESS_TOKEN or any AI provider API key env vars.');
    return;
  }
  if (text.trim().toLowerCase().startsWith('/model')) {
    await handleModelCommand(psid, text.trim());
    return;
  }
  await setTyping(psid, true);
  try {
    const history = conversations.get(psid) || [];
    let modelForTurn = null;
    if (images.length) {
      // Photos need a vision-capable model; borrow one for this message if needed.
      const vision = await fetchVisionModels();
      if (!vision.has(currentModel)) {
        modelForTurn =
          [...FALLBACK_MODELS, 'google/gemma-4-31b-it:free'].find((m) => vision.has(m)) || currentModel;
        console.log(`current model ${currentModel} has no vision; using ${modelForTurn} for this image`);
      }
      history.push({ role: 'user', content: (text || '[sent a photo]').slice(0, 500) });
      const reply = await askOpenRouter(
        [
          ...history.slice(0, -1),
          {
            role: 'user',
            content: [
              { type: 'text', text: text || 'Describe this image in detail.' },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
        modelForTurn
      );
      history.push({ role: 'assistant', content: reply });
      conversations.set(psid, history.slice(-MAX_HISTORY));
      for (const chunk of chunkText(reply)) {
        await sendText(psid, chunk);
      }
      return;
    }
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
    const lead = ANTHROPIC_API_KEY
      ? `Claude (${ANTHROPIC_MODEL}) is answering first while ANTHROPIC_API_KEY is set.\nOpenRouter model: ${currentModel}`
      : `Current model: ${currentModel}`;
    await sendText(
      psid,
      `${lead}\n\n/model list - show free models\n/model <model-id> - switch models`
    );
    return;
  }
  if (arg.toLowerCase() === 'list') {
    try {
      const models = await fetchModels();
      const free = models.filter((m) => m.id.endsWith(':free'));
      const list = free.length ? free : models.slice(0, 30);
      lastModelList.set(psid, list.map((m) => m.id));
      await sendText(psid, 'Free models — tap and hold one to copy:');
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const modalities = (m.architecture && m.architecture.input_modalities) || [];
        const tag = modalities.includes('image') ? ' (sees images)' : '';
        await sendText(psid, `${i + 1}. ${m.id}${tag}`);
      }
      await sendText(psid, 'Or just send /model <number>, e.g. /model 3');
    } catch (err) {
      console.error('model list error:', err.message);
      await sendText(psid, 'Sorry, I ran into an error. Try again in a moment.');
    }
    return;
  }
  // Allow "/model 3" to pick from the last list shown to this sender.
  let target = arg;
  const cached = lastModelList.get(psid);
  const num = parseInt(arg, 10);
  if (cached && String(num) === arg && num >= 1 && num <= cached.length) {
    target = cached[num - 1];
  }
  try {
    const ids = await fetchModelIds();
    if (!ids.includes(target)) {
      await sendText(psid, `Couldn't find "${arg}" on OpenRouter. Send /model list to see what's available.`);
      return;
    }
  } catch (err) {
    console.error('model check error:', err.message);
    await sendText(psid, 'Sorry, I ran into an error. Try again in a moment.');
    return;
  }
  currentModel = target;
  console.log('Model switched to ' + target + ' by ' + psid);
  await sendText(psid, `Switched to ${target}.`);
}

// Cached OpenRouter model catalogue (refreshed hourly).
let modelsCache = { at: 0, data: [] };
async function fetchModels() {
  if (modelsCache.data.length && Date.now() - modelsCache.at < 3600e3) return modelsCache.data;
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {}, 15000);
  if (!res.ok) throw new Error('models list ' + res.status);
  const data = await res.json();
  modelsCache = { at: Date.now(), data: data.data || [] };
  return modelsCache.data;
}
async function fetchModelIds() {
  return (await fetchModels()).map((m) => m.id);
}
// Ids of models that accept image input.
async function fetchVisionModels() {
  const ids = new Set();
  for (const m of await fetchModels()) {
    const modalities = (m.architecture && m.architecture.input_modalities) || [];
    if (modalities.includes('image')) ids.add(m.id);
  }
  return ids;
}

// Friendly reply for stickers, files, and other non-text, non-image messages.
async function handleNonText(psid) {
  if (!PAGE_ACCESS_TOKEN) return;
  try {
    await sendText(psid, 'I can only read text and photos for now.');
  } catch (err) {
    console.error('non-text reply error:', err.message);
  }
}

// Provider chain: Claude (Anthropic) first when configured, then OpenRouter
// models, then Hugging Face. Each provider retries transient failures, and a
// bad key only skips that provider — it never aborts the whole chain.
async function askOpenRouter(history, modelOverride) {
  let lastErr = null;

  if (ANTHROPIC_API_KEY) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await completeWithAnthropic(history);
      } catch (err) {
        lastErr = err;
        console.error(`anthropic ${ANTHROPIC_MODEL} attempt ${attempt} failed:`, err.message);
        if (err.authFailed || !err.transient || attempt === 2) break;
        await sleep(2000 * attempt);
      }
    }
  }

  if (OPENROUTER_API_KEY) {
    const first = modelOverride || currentModel;
    const models = [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
    openrouterLoop:
    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await completeWithModel(model, history);
        } catch (err) {
          lastErr = err;
          console.error(`model ${model} attempt ${attempt} failed:`, err.message);
          if (err.authFailed) break openrouterLoop; // bad key — other OpenRouter models won't help
          if (!err.transient || attempt === 2) break;
          await sleep(2000 * attempt);
        }
      }
    }
  }
  // Final fallback: Hugging Face Inference Providers (if configured).
  if (HF_API_KEY) {
    const hfModel = historyHasImages(history) ? HF_VISION_MODEL : HF_MODEL;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await completeWithHuggingFace(hfModel, history);
      } catch (err) {
        lastErr = err;
        console.error(`huggingface ${hfModel} attempt ${attempt} failed:`, err.message);
        if (err.authFailed) break; // bad token — retrying won't help
        if (!err.transient || attempt === 2) break;
        await sleep(2000 * attempt);
      }
    }
  }
  throw lastErr || new Error('No AI provider configured.');
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
    throw orError('OpenRouter', res.status, body);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (content || "I didn't get a reply from the AI. Try again.").trim();
}

async function completeWithHuggingFace(model, history) {
  let res;
  try {
    res = await fetchWithTimeout(
      HF_ROUTER_URL,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + HF_API_KEY,
          'Content-Type': 'application/json',
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
    throw orError('HuggingFace', res.status, body);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (content || "I didn't get a reply from the AI. Try again.").trim();
}

function historyHasImages(history) {
  return history.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  );
}

async function completeWithAnthropic(history) {
  let res;
  try {
    res = await fetchWithTimeout(
      ANTHROPIC_URL,
      {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: toAnthropicMessages(history),
        }),
      },
      REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    throw transientError('network/timeout: ' + err.message);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw orError('Anthropic', res.status, body);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return (text || "I didn't get a reply from the AI. Try again.").trim();
}

// Converts the bot's OpenAI-style history into Anthropic Messages format:
// image_url parts become image blocks, and consecutive same-role turns are
// merged because Anthropic expects alternating user/assistant messages.
function toAnthropicMessages(history) {
  const out = [];
  for (const m of history.slice(-MAX_HISTORY)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let blocks;
    if (typeof m.content === 'string') {
      blocks = [{ type: 'text', text: m.content }];
    } else if (Array.isArray(m.content)) {
      blocks = m.content
        .map((p) => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          if (p.type === 'image_url' && p.image_url && p.image_url.url) {
            return { type: 'image', source: { type: 'url', url: p.image_url.url } };
          }
          return null;
        })
        .filter(Boolean);
    }
    if (!blocks || !blocks.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = prev.content.concat(blocks);
    } else {
      out.push({ role: m.role, content: blocks });
    }
  }
  return out;
}

function orError(provider, status, body) {
  const err = new Error(provider + ' ' + status + ': ' + body.slice(0, 200));
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
  } else {
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
  if (!HF_API_KEY) {
    console.log('HF_API_KEY not set — Hugging Face fallback disabled.');
  } else {
    try {
      const res = await fetchWithTimeout(
        'https://huggingface.co/api/whoami',
        { headers: { Authorization: 'Bearer ' + HF_API_KEY } },
        15000
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('HF_API_KEY check failed: HTTP ' + res.status + ' ' + body.slice(0, 200));
      } else {
        console.log('Hugging Face API key OK.');
      }
    } catch (err) {
      console.error('HF_API_KEY check error:', err.message);
    }
  }
  if (!ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not set — Claude provider disabled.');
    return;
  }
  try {
    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/models',
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      },
      15000
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('ANTHROPIC_API_KEY check failed: HTTP ' + res.status + ' ' + body.slice(0, 200));
    } else {
      console.log('Anthropic API key OK (Claude model: ' + ANTHROPIC_MODEL + ').');
    }
  } catch (err) {
    console.error('ANTHROPIC_API_KEY check error:', err.message);
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
