'use strict';

const https = require('https');

function get(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'polymarket-test/1.0', Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
  });
}

async function test(label, url) {
  console.log(`\n── ${label}`);
  console.log(`   URL: ${url}`);
  const t0 = Date.now();
  try {
    const { status, body } = await get(url);
    const ms = Date.now() - t0;
    console.log(`   Status : ${status}  (${ms}ms)`);
    try {
      const json = JSON.parse(body);
      const isArray = Array.isArray(json);
      const data = isArray ? json : (json.data || json.markets || json);
      const count = Array.isArray(data) ? data.length : '(not an array)';
      console.log(`   Records: ${count}`);
      if (Array.isArray(data) && data.length > 0) {
        console.log(`   Sample keys: ${Object.keys(data[0]).join(', ')}`);
        if (data[0].question || data[0].title) {
          console.log(`   Sample title: ${(data[0].question || data[0].title || '').slice(0, 80)}`);
        }
        if (data[0].condition_id || data[0].conditionId) {
          const id = data[0].condition_id || data[0].conditionId;
          console.log(`   Sample id: ${id}  (starts with 0x: ${String(id).startsWith('0x')})`);
        }
        // Check for BTC markets
        const btc = data.filter(m =>
          /btc|bitcoin/i.test((m.question || m.title || '') + (m.condition_id || m.conditionId || m.id || ''))
        );
        console.log(`   BTC markets: ${btc.length}`);
        if (btc.length > 0) {
          console.log(`   BTC sample: ${(btc[0].question || btc[0].title || '').slice(0, 80)}`);
        }
      }
    } catch {
      console.log(`   Body (first 300): ${body.slice(0, 300)}`);
    }
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`   ERROR (${ms}ms): ${e.message}`);
  }
}

function rawGet(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'polymarket-test/1.0', Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
  });
}

// Compute current and next 5-min BTC market slugs
function btc5mSlugs() {
  const nowSec   = Math.floor(Date.now() / 1000);
  const current  = nowSec - (nowSec % 300);       // round down to 5-min boundary
  const next     = current + 300;
  const prev     = current - 300;
  return [prev, current, next].map(t => ({ ts: t, slug: `btc-updown-5m-${t}` }));
}

(async () => {
  console.log('=== Polymarket API Connectivity Test ===');

  await test('CLOB — /time (health check)',
    'https://clob.polymarket.com/time');

  await test('Gamma — markets (active, limit 5)',
    'https://gamma-api.polymarket.com/markets?limit=5&active=true');

  // ── BTC 5-minute markets ──────────────────────────────────────────────────
  console.log('\n── BTC 5m slug candidates:');
  const slugs = btc5mSlugs();
  for (const { ts, slug } of slugs) {
    const t = new Date(ts * 1000).toISOString();
    console.log(`   ${slug}  (${t})`);
  }

  for (const { slug } of slugs) {
    await test(`Gamma — ${slug}`,
      `https://gamma-api.polymarket.com/markets?slug=${slug}`);
  }

  // ── Also try the user's specific market ──────────────────────────────────
  await test('Gamma — known live market (user URL)',
    'https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-1778641800');

  // ── Inspect outcomePrices field from a real Gamma market ─────────────────
  console.log('\n── Raw Gamma market field inspection (first result):');
  try {
    const { body } = await rawGet('https://gamma-api.polymarket.com/markets?limit=1&active=true');
    const arr = JSON.parse(body);
    const m   = Array.isArray(arr) ? arr[0] : (arr.markets || arr.data || [])[0];
    if (m) {
      console.log(`   bestBid       : ${JSON.stringify(m.bestBid)}`);
      console.log(`   bestAsk       : ${JSON.stringify(m.bestAsk)}`);
      console.log(`   outcomePrices : ${JSON.stringify(m.outcomePrices)}`);
      console.log(`   lastTradePrice: ${JSON.stringify(m.lastTradePrice)}`);
      console.log(`   liquidity     : ${JSON.stringify(m.liquidity)}`);
      console.log(`   liquidityNum  : ${JSON.stringify(m.liquidityNum)}`);
      console.log(`   clobTokenIds  : ${JSON.stringify(m.clobTokenIds)}`);
      console.log(`   conditionId   : ${JSON.stringify(m.conditionId)}`);
    }
  } catch (e) {
    console.log(`   ERROR: ${e.message}`);
  }

  console.log('\n=== Done ===\n');
})();
