'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const baseConfig       = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/config.json'), 'utf8'));
const DataBus          = require('../core/dataBus');
const RiskManager      = require('../core/riskManager');
const CapitalAllocator = require('../core/capitalAllocator');
const ExecutionEngine  = require('../core/executionEngine');
const Coordinator      = require('../core/coordinator');
const LearningEngine   = require('../core/learningEngine');
const { PositionBook } = require('../db/positionBook');
const { OrderStore }   = require('../db/orderStore');
const { ensureDir }    = require('../shared/dataStore');
const { fetchNews, MockPolymarketApi } = require('../shared/mockApis');
const { PolymarketRestAdapter }        = require('../adapters/polymarketRest');
const { PolymarketWsAdapter }          = require('../adapters/polymarketWs');
const { getInstance: getBtcFeed }      = require('../core/btcDataFeed');
const { FastExecutor }                 = require('../core/fastExecutor');
const { CapitalStore }                 = require('../db/capitalStore');
const { TelegramCommander }            = require('../core/telegramCommander');

// Coordinator runs with no agents — BTC scalp is handled exclusively by
// FastExecutor via WebSocket events. Empty AGENTS prevents double-execution.
const AGENTS = [];

// Start BTC WebSocket feed immediately so it's warm by the time trading starts
const btcFeed = getBtcFeed();
btcFeed.on('connected',    () => console.log('[btcFeed] WebSocket connected — live BTC data flowing'));
btcFeed.on('disconnected', () => console.log('[btcFeed] WebSocket disconnected — reconnecting…'));
btcFeed.start();
// DATA_DIR: set to Railway volume mount path (e.g. /data) for persistence across deploys
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_DIR    = path.join(DATA_DIR, 'db');
const LOG_DIR   = path.join(DATA_DIR, 'logs');
const DASH_DIR  = path.join(__dirname);

ensureDir(DB_DIR);
ensureDir(LOG_DIR);

// ── Live config (editable at runtime) ────────────────────────────────────────
let liveConfig = JSON.parse(JSON.stringify(baseConfig));
// dryRun defaults to true (safer) — toggle from UI to send real orders.
if (typeof liveConfig.dryRun !== 'boolean') liveConfig.dryRun = true;
btcFeed.setSignalThreshold(Math.round(liveConfig.confidence_threshold * 100));

const positionBook  = new PositionBook(path.join(DB_DIR, 'positions.json'));
const orderStore    = new OrderStore(path.join(DB_DIR, 'orders.json'));
const capitalStore  = new CapitalStore(path.join(DB_DIR, 'capital.json'));

// ── Shared state ──────────────────────────────────────────────────────────────
// Sync capital from persistent store — derive stop/trade limits from config ratios
liveConfig.total_capital = capitalStore.current;
liveConfig.max_trade_usd = +(capitalStore.current * (liveConfig.risk_per_trade || 0.2)).toFixed(2);
liveConfig.stop_loss_usd = +(capitalStore.current * (1 - (liveConfig.max_drawdown || 0.3))).toFixed(2);

const dash = {
  status:        'idle',
  mode:          'live',
  dryRun:        !!liveConfig.dryRun,
  equity:        liveConfig.total_capital,
  initialCap:    liveConfig.total_capital,
  pnl:           0,
  winRate:       0,
  drawdown:      0,
  totalTrades:   0,
  wins:          0,
  openPositions: 0,
  equityCurve:   [{ t: Date.now(), v: liveConfig.total_capital }],
  trades:        [],   // full trade history this session
  taskLog:       [],
  stopFlag:      false,
};

// ── SSE ───────────────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(type, payload) {
  const msg = `event:${type}\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch {} }
}

function pushState() { broadcast('state', dash); }

function taskLog(msg) {
  const entry = { t: Date.now(), msg };
  dash.taskLog.push(entry);
  if (dash.taskLog.length > 500) dash.taskLog.shift();
  broadcast('log', entry);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(DASH_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(DASH_DIR, 'app.html')));
app.get('/health', (_req, res) => res.json({ ok: true, status: dash.status, uptime: Math.round(process.uptime()) }));

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  clients.add(res);
  res.write(`event:state\ndata:${JSON.stringify(dash)}\n\n`);
  const hb = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 15000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
});

// ── State & trades ────────────────────────────────────────────────────────────
app.get('/api/state',  (_req, res) => res.json(dash));
app.get('/api/trades', (_req, res) => res.json(dash.trades));

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => res.json(liveConfig));

app.post('/api/config', (req, res) => {
  const allowed = ['ev_threshold','confidence_threshold','fractional_kelly',
                   'total_capital','max_drawdown','poll_interval_ms',
                   'cooldown_cycles_after_loss','max_trade_usd','stop_loss_usd',
                   'max_concurrent_trades'];
  for (const k of allowed) {
    if (req.body[k] != null) liveConfig[k] = Number(req.body[k]);
  }
  if (req.body.confidence_threshold != null) {
    btcFeed.setSignalThreshold(Math.round(liveConfig.confidence_threshold * 100));
  }
  try {
    fs.writeFileSync(
      path.join(__dirname, '../config/config.json'),
      JSON.stringify(liveConfig, null, 2), 'utf8'
    );
  } catch {}
  taskLog('Config saved');
  res.json({ ok: true, config: liveConfig });
});

// ── Start / Stop ──────────────────────────────────────────────────────────────
app.post('/api/start', (req, res) => {
  if (dash.status !== 'idle') return res.status(409).json({ error: `Already ${dash.status}` });

  const hasApiKey = !!(process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET);
  const mode      = hasApiKey ? 'live' : 'paper';

  for (const agent of AGENTS) {
    if (typeof agent.resetSession === 'function') agent.resetSession();
  }

  dash.mode        = mode;
  dash.stopFlag    = false;
  dash.equity      = liveConfig.total_capital;
  dash.initialCap  = liveConfig.total_capital;
  dash.pnl         = 0;
  dash.winRate     = 0;
  dash.drawdown    = 0;
  dash.totalTrades = 0;
  dash.wins        = 0;
  dash.equityCurve = [{ t: Date.now(), v: liveConfig.total_capital }];
  dash.trades      = [];

  res.json({ ok: true, mode });
  _runTradingLoop(mode).catch(e => taskLog(`Fatal: ${e.message}`));
});

app.post('/api/stop', (_req, res) => {
  dash.stopFlag = true;
  taskLog('Stop requested');
  res.json({ ok: true });
});

app.post('/api/reset', (_req, res) => {
  if (dash.status !== 'idle') return res.status(409).json({ error: 'Cannot reset while running' });
  positionBook.reset();
  dash.equity = liveConfig.total_capital;
  dash.pnl = dash.winRate = dash.drawdown = dash.totalTrades = dash.wins = 0;
  dash.equityCurve = [{ t: Date.now(), v: liveConfig.total_capital }];
  dash.trades = [];
  dash.taskLog = [];
  pushState();
  res.json({ ok: true });
});

// ── Claude advisory ────────────────────────────────────────────────────────────

// Persist advisor toggle across restarts
const _advisorSettingsPath = path.join(__dirname, '../db/advisor-settings.json');
let _advisorEnabled = true;
try { _advisorEnabled = JSON.parse(fs.readFileSync(_advisorSettingsPath, 'utf8')).enabled !== false; } catch {}

app.get('/api/advisory', (_req, res) => {
  const fe = _getActiveFastExec();
  res.json({
    ...(fe ? (fe.getLatestAdvisory() || { none: true }) : { none: true, reason: 'not trading' }),
    enabled: _advisorEnabled,
  });
});

app.post('/api/advisory/toggle', (_req, res) => {
  _advisorEnabled = !_advisorEnabled;
  try { fs.writeFileSync(_advisorSettingsPath, JSON.stringify({ enabled: _advisorEnabled }), 'utf8'); } catch {}
  const fe = _getActiveFastExec();
  if (fe) fe.setAdvisorEnabled(_advisorEnabled);
  taskLog(`[advisor] ${_advisorEnabled ? 'Enabled' : 'Disabled'}`);
  res.json({ ok: true, enabled: _advisorEnabled });
});

// ── Dry-run (test mode) toggle ───────────────────────────────────────────────
// Real data + real signals + real Polymarket prices for TP/SL, no order sent.
app.get('/api/dryrun', (_req, res) => {
  const fe = _getActiveFastExec();
  res.json({ dryRun: fe ? fe.isDryRun() : !!liveConfig.dryRun });
});

app.post('/api/dryrun/toggle', (req, res) => {
  const next = (req.body && typeof req.body.dryRun === 'boolean')
    ? req.body.dryRun
    : !liveConfig.dryRun;
  liveConfig.dryRun = next;
  const fe = _getActiveFastExec();
  if (fe) fe.setDryRun(next);
  try {
    fs.writeFileSync(
      path.join(__dirname, '../config/config.json'),
      JSON.stringify(liveConfig, null, 2), 'utf8'
    );
  } catch {}
  taskLog(`[mode] ${next ? 'TEST (dry-run) — no orders sent' : 'REAL — orders will execute'}`);
  dash.dryRun = next;
  pushState();
  res.json({ ok: true, dryRun: next });
});

app.get('/api/advisory/counterfactual', (_req, res) => {
  const fe = _getActiveFastExec();
  res.json({
    result:    fe ? (fe.getLatestCf() || null) : null,
    progress:  fe ? fe.getBufferProgress() : { filled: 0, target: 100 },
  });
});

app.post('/api/advisory/analyze', async (_req, res) => {
  const fe = _getActiveFastExec();
  if (!fe) return res.json({ ok: false, error: 'Not currently trading' });
  taskLog('[advisor] Manual perf analysis triggered');
  const result = await fe.triggerAnalysis();
  res.json(result ? { ok: true, result } : { ok: false, error: 'Analysis failed — check logs' });
});

app.post('/api/advisory/counterfactual', async (_req, res) => {
  const fe = _getActiveFastExec();
  if (!fe) return res.json({ ok: false, error: 'Not currently trading' });
  taskLog('[cf] Manual counterfactual triggered from dashboard');
  const r = await fe.triggerCounterfactual();
  res.json(r);
});

// Apply one or all parameter recommendations
app.post('/api/advisory/apply', (req, res) => {
  const { recommendations } = req.body || {};
  if (!Array.isArray(recommendations)) return res.json({ ok: false, error: 'No recommendations provided' });

  const ALLOWED = [
    'confidence_threshold', 'take_profit_pct', 'stop_loss_pct',
    'max_hold_ms', 'min_velocity_pct', 'cooldown_ms',
    'vol_ratio_min', 'ob_imbalance_min',
    'ev_threshold', 'fractional_kelly', 'cooldown_cycles_after_loss',
  ];

  const applied = [];
  for (const rec of recommendations) {
    if (!ALLOWED.includes(rec.parameter)) continue;
    const v = parseFloat(rec.suggested);
    if (isNaN(v)) continue;
    liveConfig[rec.parameter] = v;
    applied.push(`${rec.parameter}: ${rec.current} → ${v}`);
  }

  if (applied.length) {
    try {
      fs.writeFileSync(
        path.join(__dirname, '../config/config.json'),
        JSON.stringify(liveConfig, null, 2), 'utf8'
      );
    } catch {}
    taskLog(`[advisor] Applied: ${applied.join(' | ')}`);
  }

  res.json({ ok: true, applied });
});

// Internal helper — returns active fastExec if trading
let _activeFastExec = null;
function _getActiveFastExec() { return _activeFastExec; }

// ── Capital management ────────────────────────────────────────────────────────

app.get('/api/capital', (_req, res) => res.json({
  current:    capitalStore.current,
  allTimePnl: capitalStore.allTimePnl,
  sessions:   capitalStore.getSessions(20),
  changes:    capitalStore.getChanges().slice(-10),
}));

app.post('/api/capital/set', (req, res) => {
  if (dash.status !== 'idle') return res.status(409).json({ error: 'Stop trading before changing capital' });
  const amount = parseFloat(req.body?.amount);
  if (!amount || amount <= 0) return res.json({ ok: false, error: 'Invalid amount' });

  const newCap = capitalStore.setCapital(amount, req.body?.note || 'manual');
  liveConfig.total_capital  = newCap;
  liveConfig.max_trade_usd  = +(newCap * (liveConfig.risk_per_trade || 0.2)).toFixed(2);
  liveConfig.stop_loss_usd  = +(newCap * (1 - (liveConfig.max_drawdown || 0.3))).toFixed(2);
  dash.equity   = newCap;
  dash.initialCap = newCap;
  taskLog(`Capital set to $${newCap}`);
  pushState();
  res.json({ ok: true, capital: newCap });
});

app.post('/api/capital/add', (req, res) => {
  if (dash.status !== 'idle') return res.status(409).json({ error: 'Stop trading before changing capital' });
  const delta = parseFloat(req.body?.amount);
  if (!delta || delta === 0) return res.json({ ok: false, error: 'Invalid delta' });

  const newCap = capitalStore.addCapital(delta, req.body?.note || (delta > 0 ? 'deposit' : 'withdraw'));
  liveConfig.total_capital  = newCap;
  liveConfig.max_trade_usd  = +(newCap * (liveConfig.risk_per_trade || 0.2)).toFixed(2);
  liveConfig.stop_loss_usd  = +(newCap * (1 - (liveConfig.max_drawdown || 0.3))).toFixed(2);
  dash.equity   = newCap;
  dash.initialCap = newCap;
  taskLog(`Capital ${delta > 0 ? 'added' : 'reduced'}: $${newCap}`);
  pushState();
  res.json({ ok: true, capital: newCap });
});

// ── BTC feed metrics (live, no auth) ─────────────────────────────────────────
app.get('/api/btc', (_req, res) => {
  const m = btcFeed.getMetrics();
  res.json(m ? {
    ok:         true,
    connected:  btcFeed.connected,
    price:      m.price,
    v15:        m.v15,
    v30:        m.v30,
    v60:        m.v60,
    pressure:   m.pressure,
    volRatio:   m.volRatio,
    obImbalance:m.obImbalance,
    spread:     m.spread,
    spreadBps:  m.spreadBps,
    zScore:     m.zScore,
    signal:     m.signal,
    confidence: m.confidence,
    scoreBreakdown: m.scoreBreakdown,
  } : { ok: false, connected: btcFeed.connected });
});

// ── Positions ─────────────────────────────────────────────────────────────────
app.get('/api/positions', (_req, res) => res.json({
  open: positionBook.getOpen(),
  summary: positionBook.summary(),
}));

// ── VPN: test + generate key ──────────────────────────────────────────────────
app.post('/api/proxy/test', async (_req, res) => {
  try {
    const axios = require('axios');
    const t0    = Date.now();
    await axios.get('https://clob.polymarket.com/time', { timeout: 15000 });
    res.json({ ok: true, latencyMs: Date.now() - t0 });
  } catch (e) {
    res.json({ ok: false, error: e.message.slice(0, 200) });
  }
});

app.post('/api/proxy/generate-key', async (_req, res) => {
  const pk      = process.env.PRIVATE_KEY;
  const deposit = process.env.DEPOSIT_WALLET_ADDRESS;
  if (!pk)                                return res.json({ ok: false, error: 'PRIVATE_KEY not set in .env' });
  if (!deposit || deposit.includes('YOUR')) return res.json({ ok: false, error: 'DEPOSIT_WALLET_ADDRESS not set in .env' });

  try {
    const { ClobClient }                         = await import('@polymarket/clob-client-v2');
    const { createWalletClient, http, fallback } = await import('viem');
    const { privateKeyToAccount }                = await import('viem/accounts');
    const { polygon }                            = await import('viem/chains');

    const account   = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
    const transport = fallback([
      http('https://rpc.ankr.com/polygon'),
      http('https://polygon.llamarpc.com'),
      http('https://polygon-bor-rpc.publicnode.com'),
    ]);
    const signer = createWalletClient({ account, chain: polygon, transport });
    const client = new ClobClient({ host: 'https://clob.polymarket.com', chain: 137, signer, throwOnError: true });

    taskLog(`[keygen] Requesting credentials for ${account.address}…`);
    let creds;
    try {
      creds = await client.createOrDeriveApiKey();
    } catch (apiErr) {
      const msg = String(apiErr?.message || apiErr);
      if (/could not create|not found|404/i.test(msg)) {
        return res.json({ ok: false, error: 'WALLET_NOT_REGISTERED', walletAddress: account.address });
      }
      throw apiErr;
    }

    const apiKey     = creds.key        || creds.apiKey        || '';
    const secret     = creds.secret     || creds.apiSecret     || '';
    const passphrase = creds.passphrase || creds.apiPassphrase || '';

    if (!apiKey) return res.json({ ok: false, error: 'WALLET_NOT_REGISTERED', walletAddress: account.address });

    const envPath = path.join(__dirname, '../.env');
    let src = ''; try { src = fs.readFileSync(envPath, 'utf8'); } catch {}
    const upsert = (t, k, v) => { const re = new RegExp(`^${k}=.*$`, 'm'); return re.test(t) ? t.replace(re, `${k}=${v}`) : `${t.trimEnd()}\n${k}=${v}`; };
    let updated = src;
    updated = upsert(updated, 'POLYMARKET_API_KEY',        apiKey);
    updated = upsert(updated, 'POLYMARKET_API_SECRET',     secret);
    updated = upsert(updated, 'POLYMARKET_API_PASSPHRASE', passphrase);
    updated = upsert(updated, 'WALLET_ADDRESS',            account.address);
    fs.writeFileSync(envPath, updated.trimStart() + '\n', 'utf8');

    taskLog(`[keygen] Done — ${apiKey.slice(0, 15)}…`);
    res.json({ ok: true, apiKey, walletAddress: account.address });
  } catch (e) {
    taskLog(`[keygen] Error: ${e.message}`);
    res.json({ ok: false, error: e.message.slice(0, 300) });
  }
});

app.get('/api/wallet', async (_req, res) => {
  try {
    const { createPublicClient, http, fallback, formatUnits } = await import('viem');
    const { polygon } = await import('viem/chains');
    const signerAddr  = process.env.WALLET_ADDRESS;
    const depositAddr = process.env.DEPOSIT_WALLET_ADDRESS;
    if (!signerAddr) return res.json({ ok: false, error: 'WALLET_ADDRESS not set' });

    const transport = fallback([
      http('https://rpc.ankr.com/polygon'),
      http('https://polygon.llamarpc.com'),
      http('https://polygon-bor-rpc.publicnode.com'),
    ]);
    const pub = createPublicClient({ chain: polygon, transport });
    const ERC20_ABI = [{ name:'balanceOf', type:'function', inputs:[{name:'account',type:'address'}], outputs:[{name:'',type:'uint256'}], stateMutability:'view' }];
    const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const USDC_N = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    const check  = depositAddr || signerAddr;

    const [maticR, ueR, unR] = await Promise.allSettled([
      pub.getBalance({ address: signerAddr }),
      pub.readContract({ address: USDC_E, abi: ERC20_ABI, functionName: 'balanceOf', args: [check] }),
      pub.readContract({ address: USDC_N, abi: ERC20_ABI, functionName: 'balanceOf', args: [check] }),
    ]);

    res.json({
      ok: true,
      signer:        signerAddr,
      depositWallet: depositAddr || null,
      matic: maticR.status === 'fulfilled' ? parseFloat(formatUnits(maticR.value, 18)).toFixed(6) : null,
      usdcE: ueR.status    === 'fulfilled' ? parseFloat(formatUnits(ueR.value,    6)).toFixed(2)  : null,
      usdc:  unR.status    === 'fulfilled' ? parseFloat(formatUnits(unR.value,    6)).toFixed(2)  : null,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Trading loop ──────────────────────────────────────────────────────────────
async function _runTradingLoop(mode) {
  dash.status = 'trading';
  taskLog(`[${mode.toUpperCase()}] Trading started — capital=$${liveConfig.total_capital}`);
  pushState();

  const logFile = path.join(LOG_DIR, `trades-${Date.now()}.jsonl`);

  // Market adapter — real for live, mock for paper
  let marketApi;
  let fetchMarketsImpl;
  marketApi = new PolymarketRestAdapter({
    apiKey:        process.env.POLYMARKET_API_KEY,
    apiSecret:     process.env.POLYMARKET_API_SECRET,
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    walletAddress: process.env.WALLET_ADDRESS,
  });
  // Only fetch the BTC 5m rolling market — nothing else is needed
  fetchMarketsImpl = async () => {
    const m = await marketApi.fetchBtc5mMarket();
    if (!m) throw new Error('BTC 5m market not available (closed or not accepting orders)');
    return [m];
  };
  taskLog(`[${mode.toUpperCase()}] BTC 5m market mode — fetching slug-based market only`);

  // Coordinator has no agents — BTC scalp runs through FastExecutor only.
  // Kept for: market-fetch loop, portfolio risk check, equity history.
  const dataBus    = new DataBus();
  const riskMgr    = new RiskManager(liveConfig);
  const allocator  = new CapitalAllocator(liveConfig);
  const execEng    = new ExecutionEngine({ ...liveConfig, mode }, marketApi, positionBook, orderStore);
  const learner    = new LearningEngine();
  const coordinator = new Coordinator({
    config:          { ...liveConfig, mode },
    agents:          AGENTS,
    dataBus,
    riskManager:     riskMgr,
    capitalAllocator: allocator,
    executionEngine: execEng,
    loggerPath:      logFile,
    positionBook,
  });

  // Build ClobClient v2 for EIP-712 signed order execution (live only)
  let clobClient = null;
  if (mode === 'live') {
    try {
      const pk      = process.env.PRIVATE_KEY;
      const deposit = process.env.DEPOSIT_WALLET_ADDRESS;
      if (pk && deposit) {
        const { ClobClient }                         = await import('@polymarket/clob-client-v2');
        const { createWalletClient, http, fallback } = await import('viem');
        const { privateKeyToAccount }                = await import('viem/accounts');
        const { polygon }                            = await import('viem/chains');

        const account   = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
        const transport = fallback([
          http('https://rpc.ankr.com/polygon'),
          http('https://polygon.llamarpc.com'),
        ]);
        const signer = createWalletClient({ account, chain: polygon, transport });

        clobClient = new ClobClient({
          host:          'https://clob.polymarket.com',
          chain:         137,
          signer,
          creds: {
            key:        process.env.POLYMARKET_API_KEY,
            secret:     process.env.POLYMARKET_API_SECRET,
            passphrase: process.env.POLYMARKET_API_PASSPHRASE,
          },
          signatureType:  3,       // POLY_1271 — deposit wallet flow
          funderAddress:  deposit,
          throwOnError:   true,
        });
        taskLog('[live] ClobClient v2 initialized (EIP-712 order signing ready)');
      } else {
        taskLog('[live] PRIVATE_KEY or DEPOSIT_WALLET_ADDRESS missing — orders will fail');
      }
    } catch (e) {
      taskLog(`[live] ClobClient init error: ${e.message}`);
    }
  }

  // Advisory state for this session
  let latestAdvisory = null;

  // Polymarket WS price feed — zero-latency local orderbooks for FAK quote selection
  let wsAdapter = null;
  if (mode === 'live') {
    wsAdapter = new PolymarketWsAdapter({ apiKey: process.env.POLYMARKET_API_KEY });
    wsAdapter.on('connected',    () => taskLog('[ws] Connected to Polymarket price feed'));
    wsAdapter.on('disconnected', () => taskLog('[ws] Disconnected from price feed — reconnecting'));
    wsAdapter.on('error', e => taskLog(`[ws] Error: ${e.message}`));
    try { wsAdapter.connect(); } catch (e) { taskLog(`[ws] Connect failed: ${e.message}`); }
  }

  // Start FastExecutor — event-driven, no poll delay for btcScalp
  const fastExec = new FastExecutor({
    marketApi:    mode === 'live' ? marketApi : null,
    clobClient:   clobClient,
    positionBook,
    orderStore,
    config:       { ...liveConfig, mode },
    logPath:      logFile,
    polymarketWs: wsAdapter,
    onTrade: (trade) => {
      dash.trades.unshift(trade);
      if (dash.trades.length > 500) dash.trades.pop();
      dash.equity      += trade.pnl;
      dash.pnl          = dash.equity - dash.initialCap;
      dash.totalTrades += 1;
      if (trade.pnl > 0) dash.wins++;
      dash.winRate      = dash.totalTrades ? (dash.wins / dash.totalTrades * 100) : 0;
      dash.equityCurve.push({ t: Date.now(), v: +dash.equity.toFixed(4) });
      if (dash.equityCurve.length > 500) dash.equityCurve.shift();
      pushState();
    },
    onLog: taskLog,
  });
  _activeFastExec = fastExec;
  fastExec.setAdvisorEnabled(_advisorEnabled);   // apply current toggle state
  fastExec.setDryRun(!!liveConfig.dryRun);
  dash.dryRun = !!liveConfig.dryRun;
  taskLog(`[mode] Trading in ${liveConfig.dryRun ? 'TEST (dry-run)' : 'REAL'} mode`);
  fastExec.setAdvisoryCallback((rec) => {
    latestAdvisory = rec;
    dash.advisory  = rec;
    taskLog(`[advisor] Grade=${rec.performance_grade} — ${rec.primary_issue}`);
    pushState();
  });
  fastExec.setCounterfactualCallback((cf) => {
    dash.counterfactual = cf;
    taskLog(`[cf] Verdict=${cf.verdict} | blocker=${cf.primary_blocker} | best_conf=${cf.best_tick_confidence} | near_miss=${cf.near_miss_count}`);
    pushState();
  });
  fastExec.start();

  let cycle = 0;
  let consecutiveErrors = 0;
  let lastGoodMarkets = null;

  while (!dash.stopFlag) {
    cycle++;
    let markets, news;
    try {
      markets = await fetchMarketsImpl();
      news = [];
      consecutiveErrors = 0;
      lastGoodMarkets = markets;
    } catch (e) {
      consecutiveErrors++;
      markets = lastGoodMarkets || [];
      news    = [];
      const wait = Math.min(liveConfig.poll_interval_ms * Math.min(consecutiveErrors, 4), 30000);
      taskLog(`[cycle ${cycle}] Fetch error: ${e.message}${markets.length ? ` — using ${markets.length} cached markets` : ' — no cached markets'} — retry in ${wait}ms`);
      await sleep(wait);
      // Fall through — fastExec must get updateMarkets() even if empty so signals aren't permanently blocked
    }

    // Give FastExecutor the latest market data for BTC signal execution
    fastExec.updateMarkets(markets);

    const result = await coordinator.runCycle({ markets, news });
    learner.update(coordinator);

    if (result.stopped) {
      taskLog(`Stopped: ${result.reason}`);
      break;
    }

    // Update dash state
    dash.equity       = coordinator.state.equity;
    dash.pnl          = dash.equity - dash.initialCap;
    dash.drawdown     = coordinator.getPerformance().maxDrawdown * 100;
    const hist        = coordinator.state.tradeHistory;
    dash.totalTrades  = hist.length;
    dash.wins         = hist.filter(t => t.pnl > 0).length;
    dash.winRate      = hist.length ? (dash.wins / hist.length * 100) : 0;
    dash.openPositions = positionBook.getOpen().length;
    dash.equityCurve.push({ t: Date.now(), v: +dash.equity.toFixed(4) });
    if (dash.equityCurve.length > 500) dash.equityCurve.shift();

    // Push new trades to history
    for (const t of result.executed) {
      dash.trades.unshift({ ...t, cycleNum: cycle, sessionId: logFile });
      if (dash.trades.length > 500) dash.trades.pop();
    }

    if (result.executed.length > 0) {
      taskLog(`Cycle ${cycle} — ${result.executed.length} trade(s) executed — equity=$${dash.equity.toFixed(2)}`);
    }

    pushState();
    await sleep(liveConfig.poll_interval_ms);
  }

  fastExec.stop();
  if (wsAdapter) { wsAdapter.close(); wsAdapter = null; }
  _activeFastExec = null;
  dash.status     = 'idle';
  dash.stopFlag = false;

  // Persist session to capital store
  capitalStore.recordSession({
    startCapital: dash.initialCap,
    endCapital:   dash.equity,
    trades:       dash.totalTrades,
    wins:         dash.wins,
    pnl:          dash.pnl,
  });
  liveConfig.total_capital = dash.equity;

  taskLog(`Trading stopped — ${cycle} cycles — final equity=$${dash.equity.toFixed(2)} pnl=${dash.pnl >= 0 ? '+' : ''}$${dash.pnl.toFixed(2)}`);

  // Persist session summary
  try {
    fs.writeFileSync(
      path.join(DASH_DIR, 'last-session.json'),
      JSON.stringify({ endedAt: Date.now(), equity: dash.equity, pnl: dash.pnl, trades: dash.trades.length }, null, 2),
      'utf8'
    );
  } catch {}

  pushState();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 4000);

app.listen(PORT, '0.0.0.0', () => {
  const hasKey = !!(process.env.POLYMARKET_API_KEY);
  console.log(`\n  Polymarket Dashboard  →  http://0.0.0.0:${PORT}`);
  console.log(`  Mode: ${hasKey ? 'LIVE (real API keys found)' : 'PAPER (no API keys)'}\n`);
});

// ── Graceful shutdown (SIGTERM from process managers / containers) ─────────────
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM — stopping trading loop');
  dash.stopFlag = true;
  setTimeout(() => process.exit(0), 8000);
});

// ── Telegram command interface ────────────────────────────────────────────────
const tgCommander = new TelegramCommander({
  token:  process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID   || '',

  onStart: async () => {
    if (dash.status !== 'idle') return { ok: false, error: `Already ${dash.status}` };
    const hasApiKey = !!(process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET);
    const mode = hasApiKey ? 'live' : 'paper';
    dash.stopFlag = false;
    _runTradingLoop(mode).catch(e => taskLog(`[fatal] ${e.message}`));
    return { ok: true };
  },

  onStop: () => {
    dash.stopFlag = true;
    const fe = _getActiveFastExec();
    if (fe) { fe.stop(); taskLog('[tgCmd] FastExecutor stopped immediately'); }
    taskLog('[tgCmd] Stop requested via Telegram');
  },

  onStatus: () => {
    const pnl = dash.pnl || 0;
    const wr  = dash.totalTrades
      ? `${(dash.wins / dash.totalTrades * 100).toFixed(1)}%`
      : '—';
    const pnlStr = `${pnl >= 0 ? '+$' : '-$'}${Math.abs(pnl).toFixed(2)}`;
    return (
      `📊 <b>${(dash.status || 'idle').toUpperCase()}</b> | ` +
      `${(dash.mode || 'paper').toUpperCase()}${dash.dryRun ? ' TEST' : ' REAL'}\n` +
      `💰 Equity: <b>$${(dash.equity || 0).toFixed(2)}</b>\n` +
      `${pnl >= 0 ? '📈' : '📉'} P&amp;L: <b>${pnlStr}</b>\n` +
      `🎯 Win rate: ${wr} (${dash.wins || 0}W / ${dash.totalTrades || 0}T)\n` +
      `📋 Open positions: ${dash.openPositions || 0}`
    );
  },

  onToggleDryRun: () => {
    const next = !liveConfig.dryRun;
    liveConfig.dryRun = next;
    dash.dryRun = next;
    const fe = _getActiveFastExec();
    if (fe) fe.setDryRun(next);
    taskLog(`[tgCmd] Mode → ${next ? 'TEST (dry-run)' : 'REAL'}`);
    pushState();
    return next;
  },

  onLog: taskLog,
});

tgCommander.start();
