// ============================================================
// AETHERMOOR BACKEND SERVER
// ============================================================
// Handles three things:
//   1. Anthropic API proxy (keeps your key secret)
//   2. Rate limiting (stops runaway API costs)
//   3. Patreon OAuth (automatically unlocks full game for subscribers)
//
// ENVIRONMENT VARIABLES — set all of these in Railway:
//
//   ANTHROPIC_API_KEY       Your Anthropic key (sk-ant-...)
//   PATREON_CLIENT_ID       From patreon.com/portal → My Clients
//   PATREON_CLIENT_SECRET   From patreon.com/portal → My Clients
//   PATREON_CAMPAIGN_ID     Your campaign ID — see note below
//   PATREON_REDIRECT_URI    https://YOUR-RAILWAY-URL/auth/patreon/callback
//   GAME_URL                Where your game HTML is hosted
//   SESSION_SECRET          Any long random string (e.g. 64 random characters)
//
// HOW TO FIND YOUR CAMPAIGN ID:
//   1. Log into Patreon as creator
//   2. Go to: https://www.patreon.com/api/oauth2/v2/campaigns
//      (paste this in your browser while logged in)
//   3. Copy the "id" value from the response — that's your campaign ID
// ============================================================

const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Environment variables ────────────────────────────────────
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const PATREON_CLIENT_ID    = process.env.PATREON_CLIENT_ID;
const PATREON_CLIENT_SECRET = process.env.PATREON_CLIENT_SECRET;
const PATREON_REDIRECT_URI = process.env.PATREON_REDIRECT_URI;
const GAME_URL             = process.env.GAME_URL || 'http://localhost';
const SESSION_SECRET       = process.env.SESSION_SECRET || 'change-this-in-production';

if (!ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY not set. Add it in Railway Variables.');
  process.exit(1);
}

if (!PATREON_CLIENT_ID || !PATREON_CLIENT_SECRET) {
  console.warn('Patreon OAuth not configured — players will only get demo access.');
}

// ── Session store ─────────────────────────────────────────────
// In-memory — survives as long as the server process runs.
// Sessions expire after 30 days.
const sessions   = new Map();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(patreonUserId, isSubscriber, tier) {
  const token = generateToken();
  sessions.set(token, { patreonUserId, isSubscriber, tier, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}

// Purge expired sessions hourly
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions.entries()) {
    if (now > s.expiresAt) sessions.delete(t);
  }
}, 60 * 60 * 1000);

// ── Rate limiting ─────────────────────────────────────────────
const LIMITS = {
  narrator: { perHour: 60,  perMinute: 5  },
  screen:   { perHour: 120, perMinute: 10 },
};
const rateLimitStore = new Map();

function getRateLimitEntry(ip) {
  if (!rateLimitStore.has(ip)) rateLimitStore.set(ip, { narrator: [], screen: [] });
  return rateLimitStore.get(ip);
}

function isRateLimited(ip, type) {
  const entry  = getRateLimitEntry(ip);
  const now    = Date.now();
  const oneMin = 60 * 1000;
  const oneHr  = 60 * 60 * 1000;
  const limit  = LIMITS[type];
  entry[type]  = entry[type].filter(t => now - t < oneHr);
  const inLastMinute = entry[type].filter(t => now - t < oneMin).length;
  if (inLastMinute >= limit.perMinute) return { limited: true, reason: 'Too many requests — please slow down a little.' };
  if (entry[type].length >= limit.perHour) {
    const resetIn = Math.ceil((entry[type][0] + oneHr - now) / 60000);
    return { limited: true, reason: `Hourly limit reached. Resets in about ${resetIn} minute${resetIn !== 1 ? 's' : ''}.` };
  }
  return { limited: false };
}

function recordCall(ip, type) { getRateLimitEntry(ip)[type].push(Date.now()); }

setInterval(() => {
  const now = Date.now(); const oneHr = 60 * 60 * 1000;
  for (const [ip, entry] of rateLimitStore.entries()) {
    entry.narrator = entry.narrator.filter(t => now - t < oneHr);
    entry.screen   = entry.screen.filter(t => now - t < oneHr);
    if (!entry.narrator.length && !entry.screen.length) rateLimitStore.delete(ip);
  }
}, 60 * 60 * 1000);

// ── Middleware ─────────────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));

const ALLOWED_ORIGINS = [
  'http://localhost', 
  'http://127.0.0.1', 
  'null',
  'https://knoodlepot.github.io/aethermoor-game/',
  GAME_URL.replace(/\/$/, ''),
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

// ── Health check ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Aethermoor API Proxy', patreonConfigured: !!(PATREON_CLIENT_ID && PATREON_CLIENT_SECRET) });
});

// ════════════════════════════════════════════════════════════
// PATREON OAUTH
// ════════════════════════════════════════════════════════════

// Step 1 — Game navigates to this URL → we redirect to Patreon login
app.get('/auth/patreon', (req, res) => {
  if (!PATREON_CLIENT_ID || !PATREON_REDIRECT_URI) {
    return res.status(503).send('Patreon OAuth is not configured on this server.');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     PATREON_CLIENT_ID,
    redirect_uri:  PATREON_REDIRECT_URI,
    scope:         'identity identity.memberships',
    state:         generateToken().slice(0, 16),
  });
  res.redirect(`https://www.patreon.com/oauth2/authorize?${params}`);
});

// Step 2 — Patreon redirects back here after login
app.get('/auth/patreon/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`${GAME_URL}?auth=cancelled`);

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://www.patreon.com/api/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        grant_type:    'authorization_code',
        client_id:     PATREON_CLIENT_ID,
        client_secret: PATREON_CLIENT_SECRET,
        redirect_uri:  PATREON_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      console.error('Token exchange failed:', await tokenRes.text());
      return res.redirect(`${GAME_URL}?auth=error`);
    }
    const { access_token } = await tokenRes.json();

    // Fetch user identity and memberships
    const identityRes = await fetch(
      'https://www.patreon.com/api/oauth2/v2/identity' +
      '?include=memberships.currently_entitled_tiers' +
      '&fields[user]=full_name' +
      '&fields[member]=patron_status,last_charge_status,currently_entitled_amount_cents' +
      '&fields[tier]=title',
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!identityRes.ok) {
      console.error('Identity fetch failed:', await identityRes.text());
      return res.redirect(`${GAME_URL}?auth=error`);
    }

    const identity = await identityRes.json();
    const patreonUserId = identity.data?.id;
    const included = identity.included || [];

    // Work out if they're an active, paid-up patron and what tier they're on
    let isSubscriber = false;
    let tierTitle    = 'Wanderer';

    const members = included.filter(i => i.type === 'member');
    const tiers   = included.filter(i => i.type === 'tier');

    for (const member of members) {
      const attrs = member.attributes || {};
      if (attrs.patron_status === 'active_patron' && attrs.last_charge_status === 'Paid') {
        isSubscriber = true;

        // Try to find the tier title
        const entitledTiers = member.relationships?.currently_entitled_tiers?.data || [];
        if (entitledTiers.length > 0) {
          const tierObj = tiers.find(t => t.id === entitledTiers[0].id);
          tierTitle = tierObj?.attributes?.title || 'Tavern Regular';
        } else {
          // Paying but no specific tier found — give base access
          tierTitle = 'Tavern Regular';
        }
        break;
      }
    }

    // Create session and redirect back to game with token in URL
    const sessionToken = createSession(patreonUserId, isSubscriber, tierTitle);
    console.log(`Auth OK — user ${patreonUserId} | subscriber: ${isSubscriber} | tier: ${tierTitle}`);

    // Game picks up ?session=TOKEN from the URL on load
    res.redirect(`${GAME_URL}?session=${sessionToken}&tier=${encodeURIComponent(tierTitle)}&subscriber=${isSubscriber}`);

  } catch (err) {
    console.error('Patreon callback error:', err.message);
    res.redirect(`${GAME_URL}?auth=error`);
  }
});

// Step 3 — Game calls this on load to verify a stored session token
app.post('/auth/verify', (req, res) => {
  const { token } = req.body || {};
  const session = getSession(token);
  if (!session) return res.json({ valid: false, isSubscriber: false, tier: 'Wanderer' });
  res.json({ valid: true, isSubscriber: session.isSubscriber, tier: session.tier });
});

// Step 4 — Log out
app.post('/auth/logout', (req, res) => {
  const { token } = req.body || {};
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// ANTHROPIC PROXY
// ════════════════════════════════════════════════════════════

app.post('/api/claude', async (req, res) => {
  const ip   = getIP(req);
  const type = req.body?.type || 'narrator';

  const limitCheck = isRateLimited(ip, type === 'screen' ? 'screen' : 'narrator');
  if (limitCheck.limited) return res.status(429).json({ error: 'rate_limited', message: limitCheck.reason });

  const { model, max_tokens, system, messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'messages array required' });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body:    JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: max_tokens || 900, system: system || '', messages }),
    });
    const data = await anthropicRes.json();
    if (anthropicRes.ok) recordCall(ip, type === 'screen' ? 'screen' : 'narrator');
    return res.status(anthropicRes.status).json(data);
  } catch (err) {
    console.error('Anthropic proxy error:', err.message);
    return res.status(502).json({ error: 'upstream_error', message: 'Could not reach the AI service. Please try again.' });
  }
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Aethermoor server running on port ${PORT}`);
  console.log(`Anthropic: ${ANTHROPIC_KEY ? 'OK' : 'MISSING'} | Patreon: ${PATREON_CLIENT_ID ? 'OK' : 'not configured'} | Game URL: ${GAME_URL}`);
});
