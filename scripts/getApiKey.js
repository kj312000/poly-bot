'use strict';

/**
 * Generates Polymarket CLOB API credentials from an Ethereum private key.
 *
 * Usage:
 *   1. PRIVATE_KEY=0x... must be set in .env
 *   2. node scripts/getApiKey.js
 *
 * On success prints credentials and writes them to .env.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Validate env ──────────────────────────────────────────────────────────────

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('[error] PRIVATE_KEY is not set in .env');
  process.exit(1);
}

let ethers;
try {
  ethers = require('ethers');
} catch {
  console.error('[error] ethers is not installed. Run: npm install ethers');
  process.exit(1);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CLOB_BASE  = 'https://clob.polymarket.com';
const CHAIN_ID   = 137;

// Free public Polygon RPCs — tried in order until one works
const POLYGON_RPCS = [
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon-mainnet.public.blastapi.io',
  'https://1rpc.io/matic',
];

const USDC_E      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // bridged USDC.e
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // native USDC

// EIP-712 — matches Polymarket's official clob-client spec exactly
// Domain name is "ClobAuthDomain" (not "ClobAuth") per official ts-clob-client source
const EIP712_DOMAIN = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
const EIP712_TYPES  = {
  ClobAuth: [
    { name: 'address',   type: 'address' },
    { name: 'timestamp', type: 'string'  },
    { name: 'nonce',     type: 'uint256' },
    { name: 'message',   type: 'string'  },
  ],
};
const CLOB_MESSAGE = 'This message attests that I control the given wallet';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(method, url, body = null, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const bodyBuf = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8') : null;

    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
        'User-Agent':   'polymarket-keygen/1.0',
        ...headers,
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`JSON parse: ${text.slice(0, 200)}`)); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Try each RPC in POLYGON_RPCS, return first that responds
async function rpcCall(payload) {
  let lastErr;
  for (const rpc of POLYGON_RPCS) {
    try {
      const res = await request('POST', rpc, payload, {}, 10000);
      if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
      return res.result;
    } catch (e) {
      lastErr = `${rpc}: ${e.message}`;
    }
  }
  throw new Error(`All RPCs failed. Last: ${lastErr}`);
}

// ── Balance helpers ───────────────────────────────────────────────────────────

async function getMaticBalance(address) {
  const hex = await rpcCall({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] });
  return Number(BigInt(hex)) / 1e18;
}

async function getErc20Balance(token, address) {
  const padded = address.toLowerCase().replace('0x', '').padStart(64, '0');
  const hex    = await rpcCall({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data: `0x70a08231${padded}` }, 'latest'] });
  const raw    = hex === '0x' || !hex ? '0x0' : hex;
  return Number(BigInt(raw)) / 1e6; // USDC has 6 decimals
}

async function checkBalances(address) {
  console.log('\n─── Wallet Balances (Polygon Mainnet) ───────────────────────');
  console.log(`    Address : ${address}`);

  const results = await Promise.allSettled([
    getMaticBalance(address),
    getErc20Balance(USDC_E, address),
    getErc20Balance(USDC_NATIVE, address),
  ]);

  const [maticR, usdcER, usdcNR] = results;

  if (maticR.status === 'fulfilled') {
    const v = maticR.value;
    console.log(`    MATIC   : ${v.toFixed(6)}${v < 0.01 ? '  ⚠  LOW — needed for gas' : ''}`);
  } else {
    console.log(`    MATIC   : unavailable (${maticR.reason.message})`);
  }

  if (usdcER.status === 'fulfilled') {
    console.log(`    USDC.e  : $${usdcER.value.toFixed(2)}`);
  } else {
    console.log(`    USDC.e  : unavailable`);
  }

  if (usdcNR.status === 'fulfilled') {
    console.log(`    USDC    : $${usdcNR.value.toFixed(2)}`);
  } else {
    console.log(`    USDC    : unavailable`);
  }

  console.log('─────────────────────────────────────────────────────────────\n');
}

// ── CLOB auth ─────────────────────────────────────────────────────────────────

async function buildL1Headers(wallet, nonce) {
  const timestamp = String(Math.floor(Date.now() / 1000));

  let signature;
  if (typeof wallet.signTypedData === 'function') {
    // ethers v6
    signature = await wallet.signTypedData(EIP712_DOMAIN, EIP712_TYPES, {
      address: wallet.address, timestamp, nonce, message: CLOB_MESSAGE,
    });
  } else {
    // ethers v5
    signature = await wallet._signTypedData(EIP712_DOMAIN, EIP712_TYPES, {
      address: wallet.address, timestamp, nonce, message: CLOB_MESSAGE,
    });
  }

  return {
    'POLY_ADDRESS':   wallet.address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE':     String(nonce),
  };
}

async function fetchNonce(walletAddress) {
  try {
    // Nonce endpoint requires POLY_ADDRESS header
    const res = await request('GET', `${CLOB_BASE}/auth/nonce`, null, { 'POLY_ADDRESS': walletAddress }, 20000);
    const n = parseInt(res.nonce ?? res, 10);
    return isNaN(n) ? 0 : n;
  } catch (e) {
    console.warn(`    [nonce] Fetch failed (${e.message}), defaulting to 0`);
    return 0;
  }
}

async function generateApiKey(wallet) {
  console.log('[1/3] Fetching nonce...');
  const nonce = await fetchNonce(wallet.address);
  console.log(`      nonce=${nonce}`);

  console.log('[2/3] Signing EIP-712 ClobAuth...');
  const headers = await buildL1Headers(wallet, nonce);
  console.log(`      signature=${headers.POLY_SIGNATURE.slice(0, 22)}...`);

  console.log('[3/3] Calling POST /auth/api-key (timeout=45s)...');
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const creds = await request('POST', `${CLOB_BASE}/auth/api-key`, {}, headers, 45000);
      return creds;
    } catch (e) {
      lastErr = e.message;
      if (attempt < 3) {
        const wait = attempt * 3000;
        console.log(`      attempt ${attempt} failed: ${e.message}`);
        console.log(`      retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        // Refresh timestamp + signature for each retry (timestamp-sensitive)
        const fresh = await buildL1Headers(wallet, nonce);
        Object.assign(headers, fresh);
      }
    }
  }
  throw new Error(`POST /auth/api-key failed after 3 attempts. Last: ${lastErr}`);
}

// ── .env writer ───────────────────────────────────────────────────────────────

function writeEnv(creds) {
  const envPath = path.join(__dirname, '..', '.env');
  let src = '';
  try { src = fs.readFileSync(envPath, 'utf8'); } catch { /* ok */ }

  const upsert = (text, key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    return re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.trimEnd()}\n${key}=${val}`;
  };

  const apiKey     = creds.apiKey       || creds.api_key        || '';
  const secret     = creds.secret       || creds.api_secret     || '';
  const passphrase = creds.passphrase   || creds.api_passphrase || '';

  let updated = src;
  updated = upsert(updated, 'POLYMARKET_API_KEY',        apiKey);
  updated = upsert(updated, 'POLYMARKET_API_SECRET',     secret);
  updated = upsert(updated, 'POLYMARKET_API_PASSPHRASE', passphrase);

  fs.writeFileSync(envPath, updated.trimStart() + '\n', 'utf8');
  return { apiKey, secret, passphrase };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Polymarket API Key Generator ===\n');

  let wallet;
  try {
    wallet = new ethers.Wallet(PRIVATE_KEY);
  } catch (e) {
    console.error(`[error] Invalid PRIVATE_KEY: ${e.message}`);
    process.exit(1);
  }

  console.log(`[wallet] ${wallet.address}`);
  await checkBalances(wallet.address);

  let creds;
  try {
    creds = await generateApiKey(wallet);
  } catch (e) {
    console.error(`\n[error] ${e.message}`);
    console.error('\nTroubleshooting:');
    console.error('  • Your wallet must have previously interacted with polymarket.com');
    console.error('  • Try logging in at https://polymarket.com with this wallet first');
    console.error('  • Then re-run this script');
    process.exit(1);
  }

  const { apiKey, secret, passphrase } = writeEnv(creds);

  console.log('\n─── Credentials ──────────────────────────────────────────────');
  console.log(`    POLYMARKET_API_KEY        = ${apiKey}`);
  console.log(`    POLYMARKET_API_SECRET     = ${secret}`);
  console.log(`    POLYMARKET_API_PASSPHRASE = ${passphrase}`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log('\n[saved] Written to .env');
  console.log('[done]  Run: npm run live:real\n');
}

main().catch(err => {
  console.error(`\n[fatal] ${err.message}`);
  process.exit(1);
});
