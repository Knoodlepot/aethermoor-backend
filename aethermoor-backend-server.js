// ============================================================
// AETHERMOOR BACKEND SERVER
// ============================================================
// This server sits between your game and the Anthropic API.
// It keeps your API key secret and enforces rate limiting
// so no single player can rack up huge API costs.
//
// HOW IT WORKS:
//   Game (browser) → this server → Anthropic API → back to game
//
// The API key never leaves this server. The browser only ever
// talks to your own server URL.
// ============================================================

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Your Anthropic API key ──────────────────────────────────
// Set this as an environment variable on Railway — never
// paste it directly into this file.
// On Railway: Settings > Variables > Add Variable
//   Name:  ANTHROPIC_API_KEY
//   Value: your key starting with sk-ant-...
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error('❌  ANTHROPIC_API_KEY environment variable is not set.');
  console.error('    Set it in Railway: Settings > Variables > ANTHROPIC_API_KEY');
  process.exit(1);
}

// ── Rate limiting config ────────────────────────────────────
// Each player (identified by IP address) gets:
//   - Max 60 narrator calls per hour   (generous for real play)
//   - Max 5 narrator calls per minute  (stops button-mashing)
// The content screen calls use a separate smaller limit so
// they don't eat into the gameplay limit.
//
// Adjust these numbers freely — lower = cheaper, higher = better experience.
const LIMITS = {
  narrator: {
    perHour:   60,   // max full narrator calls per hour per IP
    perMinute:  5,   // max full narrator calls per minute per IP
  },
  screen: {
    perHour:  120,   // screen calls are cheap (Haiku) so allow more
    perMinute: 10,
  },
};

// In-memory store: { ip -> { narrator: [...timestamps], screen: [...timestamps] } }
const rateLimitStore = new Map();

function getRateLimitEntry(ip) {
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { narrator: [], screen: [] });
  }
  return rateLimitStore.get(ip);
}

function isRateLimited(ip, type) {
  const entry  = getRateLimitEntry(ip);
  const now    = Date.now();
  const oneMin = 60 * 1000;
  const oneHr  = 60 * 60 * 1000;
  const limit  = LIMITS[type];

  // Prune old timestamps
  entry[type] = entry[type].filter(t => now - t < oneHr);

  const inLastMinute = entry[type].filter(t => now - t < oneMin).length;
  const inLastHour   = entry[type].length;

  if (inLastMinute >= limit.perMinute) {
    return { limited: true, reason: `Too many requests — please slow down a little.` };
  }
  if (inLastHour >= limit.perHour) {
    const resetIn = Math.ceil((entry[type][0] + oneHr - now) / 60000);
    return { limited: true, reason: `Hourly limit reached. Resets in about ${resetIn} minute${resetIn !== 1 ? 's' : ''}.` };
  }

  return { limited: false };
}

function recordCall(ip, type) {
  const entry = getRateLimitEntry(ip);
  entry[type].push(Date.now());
}

// Clean up old entries every hour to prevent memory creep
setInterval(() => {
  const oneHr = 60 * 60 * 1000;
  const now   = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    entry.narrator = entry.narrator.filter(t => now - t < oneHr);
    entry.screen   = entry.screen.filter(t => now - t < oneHr);
    if (entry.narrator.length === 0 && entry.screen.length === 0) {
      rateLimitStore.delete(ip);
    }
  }
}, 60 * 60 * 1000);

// ── Middleware ──────────────────────────────────────────────
app.use(express.json({ limit: '50kb' })); // prevent huge payloads

// CORS — only allow requests from your game's domain.
// During development, localhost is allowed too.
// Replace 'https://yourgame.com' with wherever you host your HTML.
const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  // Add your real domain here once you know it, e.g.:
  // 'https://aethermoor.yourdomain.com',
  // 'https://yourdomain.github.io',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. when opening HTML as a local file)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }
    callback(new Error(`Origin ${origin} not allowed`));
  },
  methods: ['POST', 'OPTIONS'],
}));

// ── Helper: get real IP behind proxies (Railway uses proxies) ──
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── Health check ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Aethermoor API Proxy' });
});

// ── Main proxy endpoint ─────────────────────────────────────
// The game sends its requests here instead of directly to Anthropic.
// Expects JSON body: { type: 'narrator'|'screen', model, max_tokens, system, messages }
app.post('/api/claude', async (req, res) => {
  const ip   = getIP(req);
  const type = req.body?.type || 'narrator'; // 'narrator' or 'screen'

  // ── Rate limit check ──────────────────────────────────────
  const limitCheck = isRateLimited(ip, type === 'screen' ? 'screen' : 'narrator');
  if (limitCheck.limited) {
    return res.status(429).json({
      error:   'rate_limited',
      message: limitCheck.reason,
    });
  }

  // ── Validate request ──────────────────────────────────────
  const { model, max_tokens, system, messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'messages array required' });
  }

  // ── Forward to Anthropic ──────────────────────────────────
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model      || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 900,
        system:     system     || '',
        messages,
      }),
    });

    const data = await anthropicRes.json();

    // Record the call only after a successful (or valid) Anthropic response
    if (anthropicRes.ok) {
      recordCall(ip, type === 'screen' ? 'screen' : 'narrator');
    }

    return res.status(anthropicRes.status).json(data);

  } catch (err) {
    console.error('Anthropic proxy error:', err.message);
    return res.status(502).json({
      error:   'upstream_error',
      message: 'Could not reach the AI service. Please try again.',
    });
  }
});

// ── Start server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Aethermoor server running on port ${PORT}`);
  console.log(`    API key loaded: ${ANTHROPIC_KEY ? 'YES ✓' : 'NO ✗ — set ANTHROPIC_API_KEY'}`);
});
