// ============================================================
// AETHERMOOR BACKEND SERVER  v2.0
// ============================================================
// What this does:
//   1. Anthropic API proxy (keeps your API key secret & hidden from players)
//   2. Token balance tracking (each player has a balance stored in a database)
//   3. Token deduction (every AI turn costs 1 token)
//   4. Stripe payments (players buy token bundles — money goes to you)
//   5. Rate limiting (stops any single player hammering your API)
//   6. Retry logic (if Anthropic is briefly busy, it retries automatically)
//
// ── RAILWAY SETUP GUIDE ──────────────────────────────────────
//
// STEP 1 — Add a Postgres database
//   In Railway → your project → click "New" → "Database" → "Add PostgreSQL"
//   Railway automatically adds DATABASE_URL to your environment. Done.
//
// STEP 2 — Set these in Railway → your service → Variables:
//
//   ANTHROPIC_API_KEY       Your Anthropic key (starts sk-ant-...)
//   STRIPE_SECRET_KEY       From stripe.com → Developers → API keys
//                           Use sk_test_... while testing, sk_live_... when live
//   STRIPE_WEBHOOK_SECRET   From stripe.com → Developers → Webhooks → your endpoint
//   SESSION_SECRET          Any long random string (just mash your keyboard)
//   GAME_URL                https://knoodlepot.github.io/aethermoor-game
//   DATABASE_URL            Set automatically by Railway — don't touch it
//
// STEP 3 — Set up your Stripe webhook
//   Stripe dashboard → Developers → Webhooks → Add endpoint
//   URL:    https://YOUR-RAILWAY-URL/stripe/webhook
//   Events: checkout.session.completed
//
// STEP 4 — Add your Stripe price IDs below (search for REPLACE_WITH)
//   Stripe dashboard → Products → create one product per bundle below
//   Set a one-time price for each → copy the "Price ID" (price_xxx...)
//
// ── PACKAGE: install these in Railway via package.json ───────
//   npm install express node-fetch pg stripe
// ============================================================

const express  = require('express');
const crypto   = require('crypto');
const fetch    = require('node-fetch');
const { Pool } = require('pg');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Environment variables ────────────────────────────────────
const ANTHROPIC_KEY         = process.env.ANTHROPIC_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const GAME_URL              = process.env.GAME_URL || 'https://knoodlepot.github.io/aethermoor-game';
const GAME_TOKEN            = process.env.GAME_TOKEN || '';  // Secret shared token — set in Railway Variables

if (!ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY not set. Add it in Railway Variables.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Add a PostgreSQL database in Railway (New → Database → PostgreSQL).');
  process.exit(1);
}

// ── Database connection ───────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Runs once on startup — creates tables if they don't already exist.
// Safe to run repeatedly (IF NOT EXISTS means it never overwrites data).
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      player_id    TEXT PRIMARY KEY,
      tokens       INTEGER NOT NULL DEFAULT 0,
      total_spent  INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS token_log (
      id          SERIAL PRIMARY KEY,
      player_id   TEXT NOT NULL,
      change      INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id                TEXT PRIMARY KEY,
      player_id         TEXT NOT NULL,
      stripe_session_id TEXT,
      tokens_awarded    INTEGER NOT NULL,
      amount_pence      INTEGER NOT NULL,
      status            TEXT DEFAULT 'pending',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database tables ready');
}

// ── Token helpers ─────────────────────────────────────────────

async function getBalance(playerId) {
  const result = await db.query('SELECT tokens FROM players WHERE player_id = $1', [playerId]);
  if (result.rows.length === 0) {
    // First time we've seen this player — give them 50 free starter tokens
    await db.query(
      'INSERT INTO players (player_id, tokens) VALUES ($1, 50) ON CONFLICT DO NOTHING',
      [playerId]
    );
    await db.query(
      'INSERT INTO token_log (player_id, change, reason) VALUES ($1, 50, $2)',
      [playerId, 'new_player_bonus']
    );
    return 50;
  }
  return result.rows[0].tokens;
}

async function spendToken(playerId) {
  // Deduct 1 token atomically. Only succeeds if they have tokens > 0.
  const result = await db.query(
    'UPDATE players SET tokens = tokens - 1 WHERE player_id = $1 AND tokens > 0 RETURNING tokens',
    [playerId]
  );
  if (result.rows.length === 0) {
    const bal = await getBalance(playerId);
    return { success: false, remaining: bal };
  }
  const remaining = result.rows[0].tokens;
  await db.query(
    'INSERT INTO token_log (player_id, change, reason) VALUES ($1, -1, $2)',
    [playerId, 'ai_turn']
  );
  return { success: true, remaining };
}

async function addTokens(playerId, amount, reason) {
  await db.query(
    `INSERT INTO players (player_id, tokens)
     VALUES ($1, $2)
     ON CONFLICT (player_id)
     DO UPDATE SET tokens = players.tokens + $2`,
    [playerId, amount]
  );
  await db.query(
    'INSERT INTO token_log (player_id, change, reason) VALUES ($1, $2, $3)',
    [playerId, amount, reason]
  );
}

// ── Token packages ────────────────────────────────────────────
// Edit prices freely. Once you create a product in Stripe, paste the
// price_id in here. The price_id always starts with "price_".
const TOKEN_PACKAGES = {
  starter: {
    name:         'Starter Pack',
    tokens:       100,
    amount_pence: 100,   // £1.00
    price_id:     'price_1T8kmJKvhVLecCSvf593COyi',
    description:  '100 tokens — good for a solid session',
  },
  adventurer: {
    name:         'Adventurer Pack',
    tokens:       300,
    amount_pence: 250,   // £2.50
    price_id:     'price_1T8kmlKvhVLecCSvV6GQdjMh',
    description:  '300 tokens — best value',
  },
  hero: {
    name:         'Hero Pack',
    tokens:       750,
    amount_pence: 500,   // £5.00
    price_id:     'price_1T8kn5KvhVLecCSvmCtEMlx3',
    description:  '750 tokens — for serious adventurers',
  },
  legend: {
    name:         'Legend Pack',
    tokens:       1500,
    amount_pence: 999,   // £9.99
    price_id:     'price_1T8kntKvhVLecCSv8kd4Pkzu',
    description:  '1,500 tokens — the full Aethermoor experience',
  },
};

// ── Rate limiting (per IP, secondary safety net) ──────────────
const RATE_LIMIT    = { perMinute: 8, perHour: 80 };
const rateStore     = new Map();

function isRateLimited(ip) {
  if (!rateStore.has(ip)) rateStore.set(ip, []);
  const now   = Date.now();
  let calls   = rateStore.get(ip).filter(t => now - t < 3600000);
  rateStore.set(ip, calls);
  const recent = calls.filter(t => now - t < 60000).length;
  if (recent  >= RATE_LIMIT.perMinute) return { limited: true, reason: 'Too many requests — please slow down.' };
  if (calls.length >= RATE_LIMIT.perHour)  return { limited: true, reason: 'Hourly limit reached. Try again shortly.' };
  return { limited: false };
}
function recordCall(ip) {
  const calls = rateStore.get(ip) || [];
  rateStore.set(ip, [...calls, Date.now()]);
}
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [ip, calls] of rateStore) {
    const fresh = calls.filter(t => t > cutoff);
    if (!fresh.length) rateStore.delete(ip); else rateStore.set(ip, fresh);
  }
}, 3600000);

// ── Anthropic API with auto-retry ────────────────────────────
// If Anthropic returns 429 (their servers are busy), we wait and retry
// automatically — up to 3 times. The player won't usually notice.
async function callAnthropic(body, attempt = 1) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt <= 3) {
    const wait = attempt * 3000; // 3s → 6s → 9s
    console.log(`Anthropic busy (429) — retrying in ${attempt * 3}s (attempt ${attempt}/3)`);
    await new Promise(r => setTimeout(r, wait));
    return callAnthropic(body, attempt + 1);
  }
  const data = await res.json();
  return { status: res.status, data };
}

// ── Middleware ─────────────────────────────────────────────────
// Stripe webhooks need the raw body (before JSON parsing), so this goes first
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' }));

const ALLOWED_ORIGINS = [
  'http://localhost', 'http://127.0.0.1', 'null',
  'https://knoodlepot.github.io',
  GAME_URL.replace(/\/$/, ''),
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Game-Token');
  } else {
    // Block requests from unknown origins entirely
    return res.status(403).json({ error: 'forbidden', message: 'Unauthorised origin.' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Domain + token guard — applies to all gameplay routes ─────
function requireGameOrigin(req, res, next) {
  const origin  = req.headers.origin  || '';
  const referer = req.headers.referer || '';
  const token   = req.headers['x-game-token'] || req.body?.['_gt'] || '';

  const originOk  = !origin  || ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  const refererOk = !referer || referer.startsWith('https://knoodlepot.github.io');
  const tokenOk   = !GAME_TOKEN || token === GAME_TOKEN;

  if (!originOk || !refererOk || !tokenOk) {
    const why = !originOk ? 'origin' : !refererOk ? 'referer' : 'token';
    console.warn('[BLOCKED] why=' + why + ' origin=' + origin + ' referer=' + referer + ' tokenOk=' + tokenOk + ' ip=' + getIP(req));
    return res.status(403).json({ error: 'forbidden', message: 'Unauthorised request: ' + why + ' check failed.' });
  }
  next();
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

// ════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════

// ── Health check ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:   'ok',
    service:  'Aethermoor API Server v2.0',
    features: ['token-tracking', 'stripe-payments', 'anthropic-proxy'],
  });
});

// ── Check token balance ────────────────────────────────────────
// Game calls this on load to sync with the server balance.
// GET /tokens/balance?playerId=abc123
app.get('/tokens/balance', async (req, res) => {
  const { playerId } = req.query;
  if (!playerId || playerId.length > 64) {
    return res.status(400).json({ error: 'playerId required' });
  }
  try {
    const balance = await getBalance(playerId);
    res.json({ playerId, balance });
  } catch (err) {
    console.error('Balance error:', err.message);
    res.status(500).json({ error: 'Could not fetch balance' });
  }
});

// ── List token packages ────────────────────────────────────────
// Game calls this to show the shop to the player.
app.get('/tokens/packages', (req, res) => {
  const packages = Object.entries(TOKEN_PACKAGES).map(([id, p]) => ({
    id,
    name:         p.name,
    tokens:       p.tokens,
    amount_pence: p.amount_pence,
    price_gbp:    '£' + (p.amount_pence / 100).toFixed(2),
    description:  p.description,
  }));
  res.json({ packages });
});

// ── Create Stripe checkout ────────────────────────────────────
// Game calls this when player clicks "Buy tokens".
// Returns a URL — game redirects the player to it.
// After payment, Stripe sends us a webhook (below) and we add the tokens.
// POST /tokens/buy  { playerId, packageId }
app.post('/tokens/buy', requireGameOrigin, async (req, res) => {
  const { playerId, packageId } = req.body || {};
  if (!playerId || !packageId) {
    return res.status(400).json({ error: 'playerId and packageId required' });
  }
  const pkg = TOKEN_PACKAGES[packageId];
  if (!pkg) {
    return res.status(400).json({ error: 'Unknown package. Options: ' + Object.keys(TOKEN_PACKAGES).join(', ') });
  }
  if (pkg.price_id.includes('REPLACE_WITH')) {
    return res.status(503).json({ error: 'Stripe price IDs not set up yet. See setup comments at top of server.js.' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: pkg.price_id, quantity: 1 }],
      mode:        'payment',
      success_url: `${GAME_URL}?payment=success&tokens=${pkg.tokens}`,
      cancel_url:  `${GAME_URL}?payment=cancelled`,
      metadata: {
        player_id:    playerId,
        package_id:   packageId,
        tokens:       String(pkg.tokens),
        amount_pence: String(pkg.amount_pence),
      },
    });
    await db.query(
      'INSERT INTO purchases (id, player_id, stripe_session_id, tokens_awarded, amount_pence) VALUES ($1, $2, $3, $4, $5)',
      [session.id, playerId, session.id, pkg.tokens, pkg.amount_pence]
    );
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Could not create payment. Please try again.' });
  }
});

// ── Stripe webhook ─────────────────────────────────────────────
// Stripe calls this automatically after payment succeeds.
// This is where tokens actually land in the player's account.
app.post('/stripe/webhook', async (req, res) => {
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body.toString());
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const playerId = session.metadata?.player_id;
    const tokens   = parseInt(session.metadata?.tokens || '0', 10);
    const amount   = parseInt(session.metadata?.amount_pence || '0', 10);
    const pkg      = session.metadata?.package_id || 'unknown';

    if (playerId && tokens > 0) {
      try {
        await addTokens(playerId, tokens, `purchase_${pkg}`);
        await db.query(
          'UPDATE purchases SET status = $1 WHERE stripe_session_id = $2',
          ['completed', session.id]
        );
        await db.query(
          'UPDATE players SET total_spent = total_spent + $1 WHERE player_id = $2',
          [amount, playerId]
        );
        const balance = await getBalance(playerId);
        console.log(`Payment complete: player ${playerId} bought ${tokens} tokens (£${(amount/100).toFixed(2)}) | balance now ${balance}`);
      } catch (err) {
        console.error('Webhook DB error:', err.message);
      }
    }
  }
  res.json({ received: true });
});

// ── Anthropic proxy with token deduction ─────────────────────
// Every AI turn goes through here.
// POST /api/claude  { playerId, model?, max_tokens?, system, messages }
app.post('/api/claude', requireGameOrigin, async (req, res) => {
  const ip       = getIP(req);
  const playerId = req.body?.playerId;

  if (!playerId || typeof playerId !== 'string' || playerId.length > 64) {
    return res.status(400).json({ error: 'invalid_request', message: 'playerId required' });
  }

  const limitCheck = isRateLimited(ip);
  if (limitCheck.limited) {
    return res.status(429).json({ error: 'rate_limited', message: limitCheck.reason });
  }

  // Check token balance and deduct 1
  const spend = await spendToken(playerId);
  if (!spend.success) {
    return res.status(402).json({
      error:     'no_tokens',
      message:   'No tokens remaining. Buy more to keep adventuring!',
      remaining: spend.remaining,
    });
  }

  const { messages, system, max_tokens } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    await addTokens(playerId, 1, 'refund_bad_request');
    return res.status(400).json({ error: 'invalid_request', message: 'messages array required' });
  }

  try {
    const { status, data } = await callAnthropic({
      model:      'claude-haiku-4-5-20251001',  // Haiku: 0.37p/turn vs 1.1p for Sonnet — same quality for RPG narration
      max_tokens: max_tokens || 900,
      system:     system || '',
      messages,
    });

    if (status !== 200) {
      // Anthropic error — refund the token so the player isn't penalised
      await addTokens(playerId, 1, 'refund_api_error');
      console.error(`Anthropic error ${status}:`, JSON.stringify(data).slice(0, 200));
    } else {
      recordCall(ip);
    }

    // Attach remaining balance to the response so the game can update its display
    return res.status(status).json({ ...data, tokenBalance: spend.remaining });

  } catch (err) {
    await addTokens(playerId, 1, 'refund_network_error');
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: 'upstream_error', message: 'Could not reach the AI. Please try again.' });
  }
});

// ── Admin stats (password protected) ─────────────────────────
// Visit /admin/stats?secret=YOUR_SESSION_SECRET to see your numbers.
app.get('/admin/stats', async (req, res) => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const [players, calls24h, revenue, purchases] = await Promise.all([
      db.query('SELECT COUNT(*) FROM players'),
      db.query("SELECT COUNT(*) FROM token_log WHERE reason = 'ai_turn' AND created_at > NOW() - INTERVAL '24 hours'"),
      db.query('SELECT SUM(total_spent) FROM players'),
      db.query("SELECT COUNT(*), SUM(amount_pence) FROM purchases WHERE status = 'completed'"),
    ]);
    res.json({
      total_players:       parseInt(players.rows[0].count),
      ai_turns_last_24h:   parseInt(calls24h.rows[0].count),
      total_revenue_pence: parseInt(revenue.rows[0].sum || 0),
      total_revenue_gbp:   '£' + ((revenue.rows[0].sum || 0) / 100).toFixed(2),
      completed_purchases: parseInt(purchases.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Aethermoor server on port ${PORT}`);
    console.log(`  Anthropic: ${ANTHROPIC_KEY ? 'OK' : 'MISSING'}`);
    console.log(`  Stripe:    ${process.env.STRIPE_SECRET_KEY ? 'OK' : 'not configured'}`);
    console.log(`  Database:  ${process.env.DATABASE_URL ? 'OK' : 'MISSING'}`);
    console.log(`  Game URL:  ${GAME_URL}`);
  });
}).catch(err => {
  console.error('Database init failed:', err.message);
  process.exit(1);
});
