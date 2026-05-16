/**
 * Close an open Polymarket position by selling shares back to the market.
 *
 * Usage:
 *   node scripts/closePosition.mjs                   ← auto-detects open positions
 *   node scripts/closePosition.mjs <tokenId> <size>  ← manual
 *
 * Example (close the test order):
 *   node scripts/closePosition.mjs 105267568073659068217311993901927962476298440625043565106676088842803600775810 5
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

const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const API_KEY        = process.env.POLYMARKET_API_KEY;
const API_SECRET     = process.env.POLYMARKET_API_SECRET;
const API_PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE;
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET_ADDRESS;

const account   = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
const transport = fallback([
  http('https://rpc.ankr.com/polygon'),
  http('https://polygon.llamarpc.com'),
  http('https://polygon-bor-rpc.publicnode.com'),
]);
const signer = createWalletClient({ account, chain: polygon, transport });

const client = new ClobClient({
  host:          'https://clob.polymarket.com',
  chain:         137,
  signer,
  creds:         { key: API_KEY, secret: API_SECRET, passphrase: API_PASSPHRASE },
  signatureType:  3,
  funderAddress:  DEPOSIT_WALLET,
  throwOnError:   true,
});

console.log('\n=== Close Position ===\n');
console.log('Signer:', account.address);

// ── Resolve tokenId and size from args or auto-detect ─────────────────────────

let tokenIdArg = process.argv[2];
let sizeArg    = parseInt(process.argv[3] || '0', 10);

if (!tokenIdArg) {
  console.log('Fetching open positions from Polymarket…');
  try {
    // getBalanceAllowance returns USDC balance — positions are on-chain
    // We check open orders instead
    const orders = await client.getOpenOrders();
    console.log('Open orders:', JSON.stringify(orders, null, 2).slice(0, 600));
  } catch (e) {
    console.warn('Could not fetch orders:', e.message);
  }
  console.log('\nNo tokenId provided. Run with:');
  console.log('  node scripts/closePosition.mjs <tokenId> <size>');
  console.log('\nYour test trade token ID:');
  console.log('  105267568073659068217311993901927962476298440625043565106676088842803600775810');
  console.log('  Size: 5 shares');
  process.exit(0);
}

const tokenID = tokenIdArg;
const size    = sizeArg || 5;

// ── Fetch current mid price ───────────────────────────────────────────────────

console.log(`\nFetching current price for token ${tokenID.slice(0, 20)}…`);
let sellPrice = 0.50;
try {
  // getMidpoint returns the mid price for a token
  const mid = await client.getMidpoint(tokenID);
  console.log('Midpoint response:', JSON.stringify(mid));
  const p = parseFloat(mid?.mid || mid?.price || mid || 0);
  if (p > 0 && p < 1) sellPrice = p;
} catch (e) {
  console.warn('Midpoint failed, trying spread:', e.message);
  try {
    const spread = await client.getSpread(tokenID);
    console.log('Spread response:', JSON.stringify(spread));
    const bid = parseFloat(spread?.bid || 0);
    if (bid > 0) sellPrice = bid - 0.001;  // slightly below bid to get filled
  } catch (e2) {
    console.warn('Spread also failed, using 0.50:', e2.message);
  }
}

// Round to tick
const tickSize   = '0.001';
const tickNum    = parseFloat(tickSize);
const rounded    = Math.floor(sellPrice / tickNum) * tickNum;   // round DOWN to ensure fill
const finalPrice = parseFloat(rounded.toFixed(3));
const notional   = (finalPrice * size).toFixed(3);

console.log(`\nClosing position:`);
console.log(`  Token ID : ${tokenID.slice(0, 30)}…`);
console.log(`  Side     : SELL YES`);
console.log(`  Price    : ${finalPrice} (tick ${tickSize})`);
console.log(`  Size     : ${size} shares`);
console.log(`  Expected : ~$${notional} received\n`);

// ── Place SELL order ──────────────────────────────────────────────────────────

try {
  const result = await client.createAndPostOrder(
    { tokenID, price: finalPrice, size, side: Side.SELL },
    { tickSize, negRisk: false }
  );

  console.log('✅ SELL ORDER RESULT:');
  console.log(JSON.stringify(result, null, 2));

  const status = result?.status;
  if (status === 'matched' || status === 'filled') {
    const received = result?.makingAmount || result?.takingAmount || notional;
    console.log(`\n✅ Position closed — received ~$${received} USDC`);
  } else {
    console.log(`\nOrder placed with status: ${status}`);
    console.log('Order ID:', result?.orderID || result?.id);
  }

} catch (e) {
  console.error('\n❌ SELL ORDER FAILED:', e.message);
  if (e.data)   console.error('API data:', JSON.stringify(e.data, null, 2));
  if (e.status) console.error('HTTP status:', e.status);

  const msg = e.message?.toLowerCase() || '';
  if (msg.includes('size') || msg.includes('minimum')) {
    console.error('→ Size might be below minimum or you already closed this position');
  } else if (msg.includes('token') || msg.includes('balance')) {
    console.error('→ You may not actually hold these shares (check deposit wallet balance)');
  }
}

console.log('\n=== Done ===\n');
