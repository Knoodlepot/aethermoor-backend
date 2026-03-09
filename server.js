// ============================================================
// AETHERMOOR BACKEND  v3.0  (clean rebuild — no origin checks)
// ============================================================
'use strict';

const express  = require('express');
const crypto   = require('crypto');
const fetch    = require('node-fetch');
const { Pool } = require('pg');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app  = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY         = process.env.ANTHROPIC_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const GAME_URL              = process.env.GAME_URL || 'https://knoodlepot.github.io/aethermoor-game';

if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

// ── Database ──────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      player_id    TEXT PRIMARY KEY,
      tokens       INTEGER NOT NULL DEFAULT 0,
      total_spent  INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS token_log (
      id          SERIAL PRIMARY KEY,
      player_id   TEXT NOT NULL,
      change      INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
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
  console.log('DB ready');
}

// ── CORS — fully open, no blocking ───────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Game-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Stripe webhook needs raw body — must be before express.json()
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;
    const playerId  = session.metadata?.playerId;
    const packageId = session.metadata?.packageId;
    const pkg       = TOKEN_PACKAGES[packageId];
    if (playerId && pkg) {
      try {
        await db.query(
          `INSERT INTO purchases (id, player_id, stripe_session_id, tokens_awarded, amount_pence, status)
           VALUES ($1, $2, $3, $4, $5, 'completed')
           ON CONFLICT (id) DO NOTHING`,
          [session.id, playerId, session.id, pkg.tokens, pkg.pence]
        );
        await addTokens(playerId, pkg.tokens, `purchase_${packageId}`);
        console.log(`[PURCHASE] ${playerId} bought ${pkg.tokens} tokens (${packageId})`);
      } catch (err) {
        console.error('DB error on webhook:', err.message);
        return res.status(500).send('DB error');
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json());

// ── Token packages ────────────────────────────────────────────
const TOKEN_PACKAGES = {
  starter:    { tokens: 100,   pence: 100,  label: '100 Tokens',    priceId: 'price_1T8kmJKvhVLecCSvf593COyi' },
  adventurer: { tokens: 300,   pence: 250,  label: '300 Tokens',    priceId: 'price_1T8kmlKvhVLecCSvV6GQdjMh' },
  hero:       { tokens: 750,   pence: 500,  label: '750 Tokens',    priceId: 'price_1T8kn5KvhVLecCSvmCtEMlx3' },
  legend:     { tokens: 1500,  pence: 999,  label: '1500 Tokens',   priceId: 'price_1T8kntKvhVLecCSv8kd4Pkzu' },
  champion:   { tokens: 3500,  pence: 1999, label: '3500 Tokens',   priceId: 'price_1T92wKKvhVLecCSvnhNCNVHc' },
  immortal:   { tokens: 10000, pence: 4999, label: '10000 Tokens',  priceId: 'price_1T92yTKvhVLecCSvRqpaI9j2' },
};

// ── Rate limiter ──────────────────────────────────────────────
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now    = Date.now();
  const window = 60_000;
  const max    = 30;
  const entry  = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > window) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > max) return { limited: true,  reason: `Too many requests — slow down!` };
  return { limited: false };
}
function recordCall(ip) { /* already recorded in isRateLimited */ }

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

// ── Token helpers ─────────────────────────────────────────────
async function getBalance(playerId) {
  const r = await db.query('SELECT tokens FROM players WHERE player_id = $1', [playerId]);
  if (r.rows.length === 0) {
    await db.query('INSERT INTO players (player_id, tokens) VALUES ($1, 100) ON CONFLICT DO NOTHING', [playerId]);
    await db.query('INSERT INTO token_log (player_id, change, reason) VALUES ($1, 100, $2)', [playerId, 'new_player_bonus']);
    return 100;
  }
  return r.rows[0].tokens;
}

async function spendToken(playerId) {
  const r = await db.query(
    'UPDATE players SET tokens = tokens - 1 WHERE player_id = $1 AND tokens > 0 RETURNING tokens',
    [playerId]
  );
  if (r.rows.length === 0) return { success: false, remaining: await getBalance(playerId) };
  await db.query('INSERT INTO token_log (player_id, change, reason) VALUES ($1, -1, $2)', [playerId, 'ai_turn']);
  return { success: true, remaining: r.rows[0].tokens };
}

async function addTokens(playerId, amount, reason) {
  await db.query(
    `INSERT INTO players (player_id, tokens) VALUES ($1, $2)
     ON CONFLICT (player_id) DO UPDATE SET tokens = players.tokens + $2`,
    [playerId, amount]
  );
  await db.query('INSERT INTO token_log (player_id, change, reason) VALUES ($1, $2, $3)', [playerId, amount, reason]);
}

// ── Anthropic proxy ───────────────────────────────────────────
async function callAnthropic(body) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json() };
}

// ── Routes ────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', service: 'aethermoor-backend' }));

app.get('/tokens/balance', async (req, res) => {
  const { playerId } = req.query;
  if (!playerId) return res.status(400).json({ error: 'playerId required' });
  try {
    const balance = await getBalance(playerId);
    return res.json({ playerId, balance });
  } catch (err) {
    console.error('Balance error:', err.message);
    return res.status(500).json({ error: 'db_error' });
  }
});

app.get('/tokens/packages', (req, res) => {
  const out = Object.entries(TOKEN_PACKAGES).map(([id, p]) => ({
    id, label: p.label, tokens: p.tokens, pence: p.pence,
    display: `£${(p.pence / 100).toFixed(2)}`,
  }));
  res.json({ packages: out });
});

app.post('/tokens/buy', async (req, res) => {
  const { playerId, packageId, successUrl, cancelUrl } = req.body;
  const pkg = TOKEN_PACKAGES[packageId];
  if (!playerId || !pkg) return res.status(400).json({ error: 'invalid playerId or packageId' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: pkg.priceId, quantity: 1 }],
      mode: 'payment',
      success_url: successUrl || `${GAME_URL}?payment=success`,
      cancel_url:  cancelUrl  || `${GAME_URL}?payment=cancelled`,
      metadata: { playerId, packageId },
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: 'stripe_error', message: err.message });
  }
});

app.post('/api/claude', async (req, res) => {
  const ip       = getIP(req);
  const playerId = req.body?.playerId;

  if (!playerId || typeof playerId !== 'string' || playerId.length > 64) {
    return res.status(400).json({ error: 'invalid_request', message: 'playerId required' });
  }

  const limitCheck = isRateLimited(ip);
  if (limitCheck.limited) {
    return res.status(429).json({ error: 'rate_limited', message: limitCheck.reason });
  }

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
      model:      'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 900,
      system:     system || '',
      messages,
    });

    if (status !== 200) {
      await addTokens(playerId, 1, 'refund_api_error');
      console.error(`Anthropic error ${status}:`, JSON.stringify(data).slice(0, 200));
    }

    return res.status(status).json({ ...data, tokenBalance: spend.remaining });

  } catch (err) {
    await addTokens(playerId, 1, 'refund_network_error');
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: 'upstream_error', message: 'Could not reach the AI. Please try again.' });
  }
});

app.get('/admin/stats', async (req, res) => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const [players, calls, purchases] = await Promise.all([
      db.query('SELECT COUNT(*) as total, SUM(tokens) as total_tokens FROM players'),
      db.query("SELECT COUNT(*) as total FROM token_log WHERE reason = 'ai_turn'"),
      db.query("SELECT COUNT(*) as total, SUM(tokens_awarded) as tokens, SUM(amount_pence) as pence FROM purchases WHERE status = 'completed'"),
    ]);
    return res.json({
      players:        parseInt(players.rows[0].total),
      total_tokens:   parseInt(players.rows[0].total_tokens),
      ai_calls:       parseInt(calls.rows[0].total),
      paid_purchases: parseInt(purchases.rows[0].total),
      tokens_sold:    parseInt(purchases.rows[0].tokens) || 0,
      revenue_pence:  parseInt(purchases.rows[0].pence)  || 0,
      revenue_pounds: ((parseInt(purchases.rows[0].pence) || 0) / 100).toFixed(2),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`Aethermoor backend listening on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err.message);
  process.exit(1);
});
