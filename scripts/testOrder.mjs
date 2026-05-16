/**
 * Real order execution test — places the smallest possible order on a live
 * Polymarket BTC market to verify the full signing + submission pipeline.
 *
 * Run:  node scripts/testOrder.mjs
 *
 * What it does:
 *   1. Connects ClobClient v2 with your credentials
 *   2. Fetches real BTC markets and picks the most liquid
 *   3. Fetches tick size + min order size for that market
 *   4. Places a LIMIT BUY YES order (size = minimum, ~$0.01–$1)
 *   5. Logs the full API response or error
 *   6. Immediately cancels the order if it was accepted
 */

import { ClobClient, Side } from '@polymarket/clob-client-v2';
import { createWalletClient, http, fallback } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, '..', '.env') });

// ── Credentials check ─────────────────────────────────────────────────────────

const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const API_KEY        = process.env.POLYMARKET_API_KEY;
const API_SECRET     = process.env.POLYMARKET_API_SECRET;
const API_PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE;
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET_ADDRESS;

console.log('\n=== Polymarket Order Execution Test ===\n');
console.log('Credentials:');
console.log('  PRIVATE_KEY:         ', PRIVATE_KEY  ? PRIVATE_KEY.slice(0,10)  + '…' : '❌ MISSING');
console.log('  POLYMARKET_API_KEY:  ', API_KEY       ? API_KEY.slice(0,10)       + '…' : '❌ MISSING');
console.log('  POLYMARKET_API_SECRET:', API_SECRET   ? API_SECRET.slice(0,8)    + '…' : '❌ MISSING');
console.log('  API_PASSPHRASE:      ', API_PASSPHRASE? API_PASSPHRASE.slice(0,8)+ '…' : '❌ MISSING');
console.log('  DEPOSIT_WALLET:      ', DEPOSIT_WALLET|| '❌ MISSING');

const missing = [
  !PRIVATE_KEY    && 'PRIVATE_KEY',
  !API_KEY        && 'POLYMARKET_API_KEY',
  !API_SECRET     && 'POLYMARKET_API_SECRET',
  !API_PASSPHRASE && 'POLYMARKET_API_PASSPHRASE',
  !DEPOSIT_WALLET && 'DEPOSIT_WALLET_ADDRESS',
].filter(Boolean);

if (missing.length) {
  console.error('\n❌ Missing:', missing.join(', '));
  process.exit(1);
}

// ── Build ClobClient ──────────────────────────────────────────────────────────

const account   = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
const transport = fallback([
  http('https://rpc.ankr.com/polygon'),
  http('https://polygon.llamarpc.com'),
  http('https://polygon-bor-rpc.publicnode.com'),
]);
const signer = createWalletClient({ account, chain: polygon, transport });

console.log('\nSigner address:', account.address);

const client = new ClobClient({
  host:          'https://clob.polymarket.com',
  chain:         137,
  signer,
  creds:         { key: API_KEY, secret: API_SECRET, passphrase: API_PASSPHRASE },
  signatureType: 3,          // POLY_1271 — deposit wallet
  funderAddress: DEPOSIT_WALLET,
  throwOnError:  true,
});

// ── Step 1: Verify API connectivity ──────────────────────────────────────────

console.log('\n[1/5] Checking API connectivity…');
try {
  const t = await client.getServerTime();
  console.log('  ✓ Server time:', t);
} catch (e) {
  console.error('  ❌ API connection failed:', e.message);
  process.exit(1);
}

// ── Step 2: Fetch BTC markets ─────────────────────────────────────────────────

console.log('\n[2/5] Fetching BTC markets…');
let btcMarket = null;
try {
  // Use Gamma API to find BTC markets
  const resp = await fetch('https://gamma-api.polymarket.com/markets?limit=50&active=true');
  const raw  = await resp.json();
  const all  = Array.isArray(raw) ? raw : (raw.markets || raw.data || []);

  const btcMarkets = all.filter(m => {
    const text = (m.question || m.title || m.slug || '').toLowerCase();
    return (text.includes('btc') || text.includes('bitcoin')) &&
           m.conditionId?.startsWith('0x');
  }).sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0));

  if (!btcMarkets.length) {
    console.error('  ❌ No active BTC markets found');
    process.exit(1);
  }

  btcMarket = btcMarkets[0];
  console.log('  ✓ Selected market:', btcMarket.question || btcMarket.title);
  console.log('  Condition ID:     ', btcMarket.conditionId);
  console.log('  Volume:           ', btcMarket.volume || '—');

  // Log all candidates
  console.log('\n  All BTC markets found:');
  btcMarkets.slice(0, 5).forEach((m, i) => {
    console.log(`    [${i+1}] ${(m.question || m.title || '').slice(0, 60)}`);
    console.log(`        conditionId=${m.conditionId} vol=${m.volume||'—'}`);
  });
} catch (e) {
  console.error('  ❌ Market fetch failed:', e.message);
  process.exit(1);
}

// ── Step 3: Fetch market details from CLOB ────────────────────────────────────

console.log('\n[3/5] Fetching CLOB market details…');
let clobInfo, tokenID, tickSize, minSize;
try {
  clobInfo  = await client.getClobMarketInfo(btcMarket.conditionId);
  console.log('  Raw CLOB info:', JSON.stringify(clobInfo, null, 2).slice(0, 800));

  // CLOB API returns abbreviated fields:
  //   t[]        = tokens array (not "tokens")
  //   t[n].t     = token ID    (not "token_id")
  //   t[n].o     = outcome     (not "outcome")
  //   mts        = minimum tick size
  //   mos        = minimum order size (shares)
  const tokens = clobInfo?.t || clobInfo?.tokens || btcMarket?.tokens || [];
  const yesToken = tokens.find(t => /yes/i.test(t.o || t.outcome)) || tokens[0];
  tokenID = yesToken?.t || yesToken?.token_id || yesToken?.tokenId;

  if (!tokenID) {
    console.error('  ❌ Could not find YES token ID');
    console.log('  Tokens field (t):', JSON.stringify(clobInfo?.t));
    process.exit(1);
  }

  tickSize = String(clobInfo?.mts || clobInfo?.minimum_tick_size || '0.01');
  minSize  = clobInfo?.mos || clobInfo?.minimum_order_size || 1;

  console.log('  ✓ YES token ID:  ', tokenID.slice(0, 20) + '…');
  console.log('  Tick size:       ', tickSize);
  console.log('  Min order size:  ', minSize, 'shares');
  if (minSize > 1) console.log(`  ⚠  Min notional will be ~$${(minSize * 0.5).toFixed(2)} (${minSize} shares × ~$0.50)`);
} catch (e) {
  console.error('  ❌ CLOB market info failed:', e.message);
  // Try with tokens from Gamma API
  const tokens = btcMarket.tokens || [];
  const yesToken = tokens.find(t => /yes/i.test(t.outcome)) || tokens[0];
  tokenID  = yesToken?.token_id || yesToken?.tokenId;
  tickSize = '0.01';
  minSize  = 1;
  if (!tokenID) {
    console.error('  ❌ No token ID available from Gamma API either');
    console.log('  Gamma tokens:', JSON.stringify(tokens));
    process.exit(1);
  }
  console.log('  Using Gamma API token ID:', tokenID);
}

// ── Step 4: Fetch current price ───────────────────────────────────────────────

console.log('\n[4/5] Fetching current price…');
let currentPrice = 0.50;
try {
  const mid = await client.getMidpoint(tokenID);
  console.log('  Midpoint response:', JSON.stringify(mid));
  const p = parseFloat(mid?.mid || mid?.price || mid || 0);
  if (p > 0 && p < 1) { currentPrice = p; console.log('  ✓ Midpoint price:', currentPrice); }
  else {
    const spread = await client.getSpread(tokenID);
    const bid    = parseFloat(spread?.bid || spread?.ask || 0.50);
    if (bid > 0 && bid < 1) currentPrice = bid;
    console.log('  ✓ Price from spread:', currentPrice);
  }
} catch (e) {
  console.warn('  ⚠ Price fetch failed, using 0.50:', e.message);
}

// Round price to tick size
const tickNum   = parseFloat(tickSize);
const roundedPrice = Math.round(currentPrice / tickNum) * tickNum;
const finalPrice   = parseFloat(roundedPrice.toFixed(4));
const finalSize    = Math.max(1, minSize);   // minimum 1 share
const notional     = (finalPrice * finalSize).toFixed(4);

console.log('\n  Order params:');
console.log('  tokenID: ', tokenID);
console.log('  side:     BUY YES');
console.log('  price:   ', finalPrice, '(rounded to tick', tickSize, ')');
console.log('  size:    ', finalSize, 'share(s)');
console.log('  notional: $' + notional);

// ── Step 5: Place the order ───────────────────────────────────────────────────

console.log('\n[5/5] Placing order…');
let orderResult = null;
try {
  orderResult = await client.createAndPostOrder(
    { tokenID, price: finalPrice, size: finalSize, side: Side.BUY },
    { tickSize, negRisk: clobInfo?.neg_risk ?? false }
  );

  console.log('\n✅ ORDER ACCEPTED');
  console.log('Full response:', JSON.stringify(orderResult, null, 2));

  const orderId = orderResult?.orderID || orderResult?.id || orderResult?.order_id;
  const status  = orderResult?.status;
  console.log('\nOrder ID:', orderId);
  console.log('Status:  ', status);

  // Immediately cancel to avoid holding position
  if (orderId && status !== 'matched' && status !== 'filled') {
    console.log('\n[cancel] Cancelling test order immediately…');
    try {
      const cancelResult = await client.cancelOrder(orderId);
      console.log('✅ Cancelled:', JSON.stringify(cancelResult));
    } catch (ce) {
      console.warn('⚠ Cancel failed (order may have already filled):', ce.message);
    }
  } else if (status === 'matched' || status === 'filled') {
    console.log('\n⚠ Order already filled — cannot cancel. You now hold', finalSize, 'YES share(s).');
    console.log('  To close: place a SELL YES order for size', finalSize, 'at current market price.');
  }

} catch (e) {
  console.error('\n❌ ORDER FAILED');
  console.error('Error type:   ', e.constructor.name);
  console.error('Error message:', e.message);
  if (e.data)    console.error('API data:     ', JSON.stringify(e.data,    null, 2));
  if (e.status)  console.error('HTTP status:  ', e.status);
  if (e.response) console.error('Response:    ', JSON.stringify(e.response, null, 2));

  // Common error diagnoses
  const msg = e.message?.toLowerCase() || '';
  if (msg.includes('insufficient') || msg.includes('balance')) {
    console.error('\n→ Diagnosis: Insufficient USDC in deposit wallet');
    console.error('  Fund', DEPOSIT_WALLET, 'with USDC on Polygon');
  } else if (msg.includes('signature') || msg.includes('auth')) {
    console.error('\n→ Diagnosis: Auth/signature error — regenerate API keys: npm run get-api-key');
  } else if (msg.includes('tick') || msg.includes('price')) {
    console.error('\n→ Diagnosis: Price not aligned to tick size', tickSize);
  } else if (msg.includes('minimum') || msg.includes('size')) {
    console.error('\n→ Diagnosis: Order size below minimum. Try size =', minSize * 2);
  }
  process.exit(1);
}

console.log('\n=== Test complete ===\n');
