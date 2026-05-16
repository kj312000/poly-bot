/**
 * Generates Polymarket L1 API credentials then initialises the full L2 client.
 *
 * Signature type 3 = POLY_1271 (deposit wallet flow for new API users).
 * The funder is the deposit wallet address that Polymarket assigns when you
 * connect your wallet at polymarket.com.
 *
 * Usage:
 *   node scripts/getApiKey.mjs
 *
 * Required in .env:
 *   PRIVATE_KEY              — your signing wallet private key (0x...)
 *   DEPOSIT_WALLET_ADDRESS   — your Polymarket deposit wallet address
 *                              (find it at polymarket.com → Profile → Settings)
 */

import { ClobClient, Side } from '@polymarket/clob-client-v2';
import { createWalletClient, createPublicClient, http, fallback, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, '..', '.env') });

// ── Validate env ──────────────────────────────────────────────────────────────

const PRIVATE_KEY             = process.env.PRIVATE_KEY;
const DEPOSIT_WALLET_ADDRESS  = process.env.DEPOSIT_WALLET_ADDRESS;

if (!PRIVATE_KEY) {
  console.error('[error] PRIVATE_KEY is not set in .env');
  process.exit(1);
}
if (!DEPOSIT_WALLET_ADDRESS || DEPOSIT_WALLET_ADDRESS.startsWith('0xYOUR')) {
  console.error('[error] DEPOSIT_WALLET_ADDRESS is not set in .env');
  console.error('        Find it at: polymarket.com → Profile → Settings → Deposit Wallet');
  console.error('        It is a different address from your signing wallet.');
  process.exit(1);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const USDC_E      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const ERC20_ABI = [{
  name: 'balanceOf', type: 'function',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
}];

const transport = fallback([
  http('https://rpc.ankr.com/polygon'),
  http('https://polygon.llamarpc.com'),
  http('https://polygon-bor-rpc.publicnode.com'),
]);

// ── Wallet setup ──────────────────────────────────────────────────────────────

const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`
);

// Node.js equivalent of:  createWalletClient({ transport: custom(window.ethereum) })
// Must supply an explicit RPC URL — http() with no args requires a chain to derive one
const signer = createWalletClient({
  account,
  chain: polygon,
  transport,           // uses the same fallback RPC list defined above
});

const publicClient = createPublicClient({ chain: polygon, transport });

// ── Balance checker ───────────────────────────────────────────────────────────

async function checkBalances() {
  console.log('\n─── Wallet Balances (Polygon Mainnet) ───────────────────────');
  console.log(`    Signer   : ${account.address}`);
  console.log(`    Deposit  : ${DEPOSIT_WALLET_ADDRESS}`);

  const [maticR, usdcER, usdcNR] = await Promise.allSettled([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: USDC_E,      abi: ERC20_ABI, functionName: 'balanceOf', args: [DEPOSIT_WALLET_ADDRESS] }),
    publicClient.readContract({ address: USDC_NATIVE, abi: ERC20_ABI, functionName: 'balanceOf', args: [DEPOSIT_WALLET_ADDRESS] }),
  ]);

  if (maticR.status === 'fulfilled') {
    const v = parseFloat(formatUnits(maticR.value, 18));
    console.log(`    MATIC    : ${v.toFixed(6)}${v < 0.01 ? '  ⚠  LOW — signer needs MATIC for gas' : ''}`);
  } else {
    console.log(`    MATIC    : unavailable`);
  }

  // USDC balance is checked on the deposit wallet (that's what holds trading funds)
  if (usdcER.status === 'fulfilled') {
    const v = parseFloat(formatUnits(usdcER.value, 6));
    console.log(`    USDC.e   : $${v.toFixed(2)} (deposit wallet)${v === 0 ? '  ⚠  fund this to trade' : ''}`);
  }
  if (usdcNR.status === 'fulfilled') {
    const v = parseFloat(formatUnits(usdcNR.value, 6));
    console.log(`    USDC     : $${v.toFixed(2)} (deposit wallet)`);
  }
  console.log('─────────────────────────────────────────────────────────────\n');
}

// ── .env writer ───────────────────────────────────────────────────────────────

function writeEnv(values) {
  const envPath = join(__dirname, '..', '.env');
  let src = '';
  try { src = readFileSync(envPath, 'utf8'); } catch { /* ok */ }

  const upsert = (text, key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    return re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.trimEnd()}\n${key}=${val}`;
  };

  let updated = src;
  for (const [key, val] of Object.entries(values)) updated = upsert(updated, key, val);
  writeFileSync(envPath, updated.trimStart() + '\n', 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Polymarket API Key Generator ===\n');
  console.log(`[signer]  ${account.address}`);
  console.log(`[deposit] ${DEPOSIT_WALLET_ADDRESS}`);

  await checkBalances();

  // ── Step 1: L1 auth — derive API credentials from private key ────────────────
  const l1Client = new ClobClient({
    host:         'https://clob.polymarket.com',
    chain:        137,
    signer,
    throwOnError: true,   // surfaces real API error messages instead of returning {}
  });

  console.log('[L1] Calling createOrDeriveApiKey()...');
  let apiCreds;
  try {
    apiCreds = await l1Client.createOrDeriveApiKey();
  } catch (e) {
    // e may be an ApiError from clob-client — log its full detail
    const detail = e?.response?.data ?? e?.data ?? e?.message ?? String(e);
    console.error(`\n[error] L1 auth failed: ${JSON.stringify(detail)}`);
    console.error('\nTroubleshooting:');
    console.error('  1. Visit https://polymarket.com and connect this wallet to create an account');
    console.error('  2. Find your deposit wallet address in Profile → Settings');
    console.error('  3. Set DEPOSIT_WALLET_ADDRESS in .env and retry');
    process.exit(1);
  }

  console.log('[L1] Raw response:', JSON.stringify(apiCreds, null, 2));

  // Normalise field names across clob-client versions
  const key        = apiCreds.key        || apiCreds.apiKey        || '';
  const secret     = apiCreds.secret     || apiCreds.apiSecret     || '';
  const passphrase = apiCreds.passphrase || apiCreds.apiPassphrase || '';

  if (!key) {
    console.error('\n[error] Empty credentials returned — wallet not registered on Polymarket.');
    console.error('        Visit https://polymarket.com, connect wallet, accept terms, then retry.');
    process.exit(1);
  }

  console.log('\n─── API Credentials ──────────────────────────────────────────');
  console.log(`    POLYMARKET_API_KEY        = ${key}`);
  console.log(`    POLYMARKET_API_SECRET     = ${secret}`);
  console.log(`    POLYMARKET_API_PASSPHRASE = ${passphrase}`);
  console.log('──────────────────────────────────────────────────────────────\n');

  writeEnv({
    POLYMARKET_API_KEY:        key,
    POLYMARKET_API_SECRET:     secret,
    POLYMARKET_API_PASSPHRASE: passphrase,
    WALLET_ADDRESS:            account.address,
  });
  console.log('[saved] .env updated\n');

  // ── Step 2: L2 client — full trading client (exact docs pattern) ─────────────
  const client = new ClobClient({
    host:           'https://clob.polymarket.com',
    chain:          137,
    signer,
    creds:          apiCreds,
    signatureType:  3,             // POLY_1271 — deposit wallet flow for new API users
    funderAddress:  DEPOSIT_WALLET_ADDRESS,
    throwOnError:   true,
  });

  // Quick connectivity check — fetch open orders (L2 authenticated call)
  console.log('[L2] Testing authenticated connection...');
  try {
    const orders = await client.getOpenOrders();
    console.log(`[L2] Connected — open orders: ${Array.isArray(orders) ? orders.length : JSON.stringify(orders)}`);
  } catch (e) {
    console.warn(`[L2] Auth check failed: ${e.message}`);
  }

  console.log('\n[done] Run: npm run live:real\n');
}

main().catch(err => {
  console.error(`\n[fatal] ${err.message}`);
  process.exit(1);
});
