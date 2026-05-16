'use strict';

require('dotenv').config({ path: '.env' });

const fs = require('fs');
const path = require('path');
const config = require('./config/config.json');

const DataBus = require('./core/dataBus');
const RiskManager = require('./core/riskManager');
const CapitalAllocator = require('./core/capitalAllocator');
const ExecutionEngine = require('./core/executionEngine');
const Coordinator = require('./core/coordinator');
const LearningEngine = require('./core/learningEngine');
const { ensureDir, appendJsonl } = require('./shared/dataStore');
const { fetchMarkets, fetchNews, MockPolymarketApi } = require('./shared/mockApis');

const { PolymarketRestAdapter } = require('./adapters/polymarketRest');
const { PolymarketWsAdapter } = require('./adapters/polymarketWs');
const { PositionBook } = require('./db/positionBook');
const { OrderStore } = require('./db/orderStore');

const { HistoricalLoader } = require('./backtest/historicalLoader');
const { ReplayEngine } = require('./backtest/replayEngine');
const { PerformanceAnalyzer } = require('./backtest/performanceAnalyzer');
const { ReportGenerator } = require('./backtest/reportGenerator');
const { StrategyOptimizer } = require('./optimization/strategyOptimizer');
const { AnnualAnalyzer }   = require('./optimization/annualAnalyzer');

const { TelegramCommander } = require('./core/telegramCommander');
const arbitrageAgent = require('./agents/arbitrageAgent');

const AGENTS = [arbitrageAgent];

// ── CLI arg parsing ────────────────────────────────────────────────────────────

function flag(name) { return process.argv.includes(`--${name}`); }
function opt(name, def) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
}

config.mode = opt('mode', config.mode);
const useRealAdapter = flag('adapter=real') || opt('adapter') === 'real';
const enableMetrics = flag('metrics') || config.mode === 'live';
const metricsPort = parseInt(opt('metrics-port', process.env.METRICS_PORT || '9091'), 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(tag, msg) {
  process.stdout.write(`[${new Date().toISOString()}] [${tag}] ${msg}\n`);
}

// ── Startup validation ─────────────────────────────────────────────────────────

function validateStartup() {
  if (useRealAdapter) {
    const missing = ['POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE']
      .filter(k => !process.env[k]);
    if (missing.length) {
      throw new Error(`Missing required env vars for real adapter: ${missing.join(', ')}`);
    }
  }

  if (config.total_capital <= 0) throw new Error('total_capital must be > 0');
  if (config.risk_per_trade <= 0 || config.risk_per_trade > 1) throw new Error('risk_per_trade must be in (0, 1]');
  if (config.stop_loss_usd != null && config.stop_loss_usd >= config.total_capital) {
    throw new Error(`stop_loss_usd (${config.stop_loss_usd}) must be less than total_capital (${config.total_capital})`);
  }
}

// ── Graceful shutdown state ────────────────────────────────────────────────────

let shutdownRequested = false;
let shutdownHandlers = [];

function onShutdown(fn) { shutdownHandlers.push(fn); }

async function shutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  log('main', `Graceful shutdown (${signal})...`);
  for (const fn of shutdownHandlers) {
    try { await fn(); } catch (e) { log('shutdown', `Handler error: ${e.message}`); }
  }
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', err => {
  log('fatal', `Uncaught exception: ${err.stack || err.message}`);
  shutdown('uncaughtException').then(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  log('fatal', `Unhandled rejection: ${msg}`);
  shutdown('unhandledRejection').then(() => process.exit(1));
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  validateStartup();

  const logsDir = path.join(__dirname, 'logs');
  const dashDir = path.join(__dirname, 'dashboard');
  const dbDir = path.join(__dirname, 'db');
  ensureDir(logsDir);
  ensureDir(dashDir);
  ensureDir(dbDir);

  const runId = Date.now();
  const logFile = path.join(logsDir, `trades-${runId}.jsonl`);

  log('init', `mode=${config.mode} adapter=${useRealAdapter ? 'real' : 'mock'} metrics=${enableMetrics} capital=$${config.total_capital}`);

  // ── Adapters ────────────────────────────────────────────────────────────────

  let restAdapter = null;
  let marketApi;
  let fetchMarketsImpl;
  let fetchNewsImpl = fetchNews;

  if (useRealAdapter) {
    restAdapter = new PolymarketRestAdapter({
      apiKey:        process.env.POLYMARKET_API_KEY,
      apiSecret:     process.env.POLYMARKET_API_SECRET,
      apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
      walletAddress: process.env.WALLET_ADDRESS || '',
    });
    marketApi = restAdapter;
    fetchMarketsImpl = () => restAdapter.fetchMarketsForTrading({ limit: 20 });
    log('init', 'Using real Polymarket REST adapter');
  } else {
    marketApi = new MockPolymarketApi();
    fetchMarketsImpl = fetchMarkets;
    log('init', 'Using mock adapter');
  }

  // ── Persistent stores ────────────────────────────────────────────────────────

  const positionBook = new PositionBook(path.join(dbDir, 'positions.json'));
  const orderStore = new OrderStore(path.join(dbDir, 'orders.json'));
  log('init', `Position book loaded (${positionBook.getOpen().length} open positions)`);

  // ── Metrics ──────────────────────────────────────────────────────────────────

  let metricsModule = null;
  let metricsServer = null;

  if (enableMetrics) {
    try {
      metricsModule = require('./metrics/prometheus');
      metricsServer = new metricsModule.MetricsServer();
      await metricsServer.start(metricsPort);
      onShutdown(() => metricsServer.stop());
    } catch (e) {
      log('metrics', `Disabled: ${e.message}`);
    }
  }

  const metrics = metricsModule?.metrics || null;

  // ── Core components ───────────────────────────────────────────────────────────

  const dataBus = new DataBus();
  const riskManager = new RiskManager(config);
  const capitalAllocator = new CapitalAllocator(config);
  const executionEngine = new ExecutionEngine(config, marketApi, positionBook, orderStore);
  const learningEngine = new LearningEngine();

  const coordinator = new Coordinator({
    config,
    agents: AGENTS,
    dataBus,
    riskManager,
    capitalAllocator,
    executionEngine,
    loggerPath: logFile,
    metrics,
    positionBook,
  });

  onShutdown(async () => {
    if (coordinator.state.tradeHistory.length > 0) {
      await generateReport(coordinator, config, dashDir);
    }
    const dashboard = coordinator.dashboard();
    const dashboardFile = path.join(dashDir, 'dashboard.json');
    fs.writeFileSync(dashboardFile, JSON.stringify(dashboard, null, 2), 'utf8');
    log('shutdown', `Dashboard → ${dashboardFile}`);
  });

  // ── Annual mode: 1-year backtest + rolling analysis + stability + final report ─

  if (config.mode === 'annual') {
    const targetWr  = parseFloat(opt('target-wr', '0.80'));
    const maxRounds = parseInt(opt('max-rounds', '6'), 10);

    const analyzer = new AnnualAnalyzer({
      config,
      agents: AGENTS,
      outDir: dashDir,
      restAdapter: useRealAdapter ? restAdapter : null,
    });

    const result = await analyzer.run({ targetWinRate: targetWr, maxRounds });

    log('annual', `Analysis complete. Win rate (mean): ${result.stability?.mean?.toFixed(2)}%  stable=${result.stability?.stable}`);
    log('annual', `Report: ${result.reportPath}`);
    return;
  }

  // ── Optimize mode: iterative Claude-driven strategy improvement ──────────────

  if (config.mode === 'optimize') {
    const maxIter = parseInt(opt('max-iter', '12'), 10);
    const targetWr = parseFloat(opt('target-wr', '0.70'));
    const btDays = parseInt(opt('bt-days', '10'), 10);

    const optimizer = new StrategyOptimizer({
      config,
      agents: AGENTS,
      outDir: dashDir,
      restAdapter,
    });

    const result = await optimizer.run({
      maxIterations: maxIter,
      targetWinRate: targetWr,
      minTrades: 15,
      backtestDays: btDays,
    });

    log('optimize', `Complete: ${result.bestWinRate} win rate after ${result.iterations} iterations`);
    log('optimize', `Report: ${result.reportPath}`);
    return;
  }

  // ── Backtest mode: full historical replay ─────────────────────────────────────

  if (config.mode === 'backtest') {
    await runBacktest({ restAdapter, coordinator, config, dashDir, logFile });
    return;
  }

  // ── WebSocket for live mode ───────────────────────────────────────────────────

  let wsAdapter = null;
  if (config.mode === 'live' && useRealAdapter) {
    wsAdapter = new PolymarketWsAdapter({ apiKey: process.env.POLYMARKET_API_KEY });
    wsAdapter.on('connected', () => {
      log('ws', 'Connected to Polymarket price feed');
      if (metrics) metrics.wsConnected.set(1);
    });
    wsAdapter.on('disconnected', () => {
      log('ws', 'Disconnected from price feed, reconnecting...');
      if (metrics) metrics.wsConnected.set(0);
    });
    wsAdapter.on('error', e => log('ws', `Error: ${e.message}`));
    try { wsAdapter.connect(); } catch (e) { log('ws', e.message); }
    onShutdown(() => wsAdapter.close());
  }

  // ── CLOB client v2 (EIP-712 signed orders) ───────────────────────────────────

  let clobClient = null;
  if (useRealAdapter && process.env.PRIVATE_KEY) {
    try {
      const { ethers } = require('ethers');
      const { ClobClient, Chain } = require('@polymarket/clob-client-v2');
      const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
      clobClient = new ClobClient({
        host:   'https://clob.polymarket.com',
        chain:  Chain.POLYGON,
        signer: wallet,
        creds: {
          key:        process.env.POLYMARKET_API_KEY,
          secret:     process.env.POLYMARKET_API_SECRET,
          passphrase: process.env.POLYMARKET_API_PASSPHRASE,
        },
      });
      log('init', 'CLOB client v2 initialized (EIP-712 signing)');
    } catch (e) {
      log('init', `CLOB client v2 init failed: ${e.message} — orders use legacy HMAC path`);
    }
  }

  // ── FastExecutor (latency arbitrage on BTC 5m markets) ───────────────────────

  let fastExecutor = null;
  if (config.mode === 'live' && useRealAdapter && config.latency_mode !== false) {
    const { FastExecutor }       = require('./core/fastExecutor');
    const { getInstance: getBtcFeed } = require('./core/btcDataFeed');

    fastExecutor = new FastExecutor({
      marketApi:    restAdapter,
      clobClient,
      positionBook,
      orderStore,
      config,
      logPath:      logFile,
      polymarketWs: wsAdapter,
      onTrade: (trade) => {
        // Only update coordinator equity on close (entry has pnl=0 until position closes)
        coordinator.handleTradeOutcome(trade.isClose ? trade : { ...trade, pnl: 0 });
        appendJsonl(logFile, trade);
      },
      onLog: (msg) => log('fastExec', msg),
    });

    const btcFeed = getBtcFeed();
    btcFeed.start();
    await fastExecutor.start();
    log('init', 'BTC data feed + FastExecutor started');

    onShutdown(async () => {
      fastExecutor.stop();
      btcFeed.stop();
      log('shutdown', 'FastExecutor + BTC feed stopped');
    });
  }

  // ── Telegram Commander ────────────────────────────────────────────────────────

  const tgCmd = new TelegramCommander({
    token:  process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID   || '',
    onStart: () => Promise.resolve({ ok: false, error: 'CLI already running — use /status to check state' }),
    onStop: () => {
      shutdownRequested = true;
      if (fastExecutor) fastExecutor.stop();
      log('tgCmd', 'Stop requested via Telegram');
    },
    onStatus: () => {
      const s = coordinator.state;
      const pnl = s.equity - config.total_capital;
      const pnlSign = pnl >= 0 ? '+' : '';
      const pnlPct = ((pnl / config.total_capital) * 100).toFixed(1);
      const wins  = s.tradeHistory.filter(t => t.pnl > 0).length;
      const total = s.tradeHistory.length;
      const wr    = total ? ((wins / total) * 100).toFixed(1) : '—';
      const open  = positionBook.getOpen().length;
      return `Equity: $${s.equity.toFixed(2)}\nP&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlPct}%)\nWin rate: ${wr}% (${wins}/${total})\nMode: ${config.mode}${config.dryRun ? ' [DRY RUN]' : ''}\nOpen positions: ${open}`;
    },
    onToggleDryRun: () => {
      config.dryRun = !config.dryRun;
      if (fastExecutor) fastExecutor.dryRun = config.dryRun;
      log('tgCmd', `dryRun → ${config.dryRun}`);
      return config.dryRun;
    },
    onLog: (msg) => process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`),
  });
  tgCmd.start();
  onShutdown(() => { tgCmd.stop(); });

  // ── Main trading loop (runs until SIGINT/SIGTERM or max drawdown) ─────────────

  let cycle = 0;
  let consecutiveFetchErrors = 0;
  const MAX_BACKOFF_MS = 60_000;

  while (!shutdownRequested) {
    cycle++;
    let markets, news;
    try {
      [markets, news] = await Promise.all([fetchMarketsImpl(), fetchNewsImpl()]);
      consecutiveFetchErrors = 0;
    } catch (e) {
      consecutiveFetchErrors++;
      const backoffMs = Math.min(config.poll_interval_ms * (2 ** consecutiveFetchErrors), MAX_BACKOFF_MS);
      log('cycle', `Market fetch error (attempt ${consecutiveFetchErrors}): ${e.message} — retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }

    if (fastExecutor) fastExecutor.updateMarkets(markets);
    const result = await coordinator.runCycle({ markets, news });
    learningEngine.update(coordinator);

    if (result.stopped) {
      log('main', `Stopped at cycle ${cycle}: ${result.reason}`);
      break;
    }

    log('cycle', `cycle=${cycle} proposals=${result.proposals} executed=${result.executed.length} equity=${coordinator.state.equity.toFixed(2)}`);

    await sleep(config.poll_interval_ms);
  }

  // Final dashboard + report written by shutdown handlers
  const dashboard = coordinator.dashboard();
  const dashboardFile = path.join(dashDir, 'dashboard.json');
  fs.writeFileSync(dashboardFile, JSON.stringify(dashboard, null, 2), 'utf8');
  log('main', `Logs → ${logFile}`);
  log('main', `Dashboard → ${dashboardFile}`);

  if (coordinator.state.tradeHistory.length > 0) {
    await generateReport(coordinator, config, dashDir);
  }
}

// ── Backtest runner ───────────────────────────────────────────────────────────

async function runBacktest({ restAdapter, coordinator, config, dashDir, logFile }) {
  log('backtest', 'Starting historical replay...');

  const loader = new HistoricalLoader(restAdapter);

  const mockMarkets = await fetchMarkets();
  const historicalData = await loader.generateSynthetic(mockMarkets, 30);

  if (restAdapter) {
    try {
      const realMarkets = await restAdapter.getGammaMarkets({ limit: 10, active: true });
      const markets = Array.isArray(realMarkets) ? realMarkets : (realMarkets.markets || []);
      const conditionIds = markets.slice(0, 5).map(m => m.conditionId).filter(Boolean);
      if (conditionIds.length) {
        const realData = await loader.loadFromApi(conditionIds, 30);
        for (const [id, series] of realData) {
          if (series.length >= 10) historicalData.set(id, series);
        }
        log('backtest', `Supplemented with ${realData.size} real market histories`);
      }
    } catch (e) {
      log('backtest', `Could not load real history, using synthetic data: ${e.message}`);
    }
  }

  const replayEngine = new ReplayEngine({
    config: { ...config, mode: 'backtest' },
    agents: AGENTS,
    logPath: logFile,
  });

  const result = await replayEngine.run(historicalData);

  const analyzer = new PerformanceAnalyzer();
  const perfMetrics = analyzer.analyze(result.equityCurve, result.trades, config.total_capital);

  log('backtest', `Total PnL:    ${perfMetrics.totalPnl}`);
  log('backtest', `Total Return: ${perfMetrics.totalReturn}`);
  log('backtest', `Sharpe:       ${perfMetrics.sharpe}`);
  log('backtest', `Max DD:       ${perfMetrics.maxDrawdown}`);
  log('backtest', `Win Rate:     ${perfMetrics.winRate}`);
  log('backtest', `Trades:       ${perfMetrics.totalTrades}`);

  const reporter = new ReportGenerator();
  const reportPath = path.join(dashDir, `backtest-report-${Date.now()}.html`);
  reporter.generate({ ...result, metrics: perfMetrics }, reportPath);
  log('backtest', `HTML report → ${reportPath}`);

  fs.writeFileSync(
    path.join(dashDir, 'backtest-summary.json'),
    JSON.stringify({ result: { ...result, equityCurve: undefined, drawdownCurve: undefined }, metrics: perfMetrics }, null, 2),
    'utf8'
  );
}

// ── Post-run HTML report helper (paper/live) ─────────────────────────────────

async function generateReport(coordinator, config, dashDir) {
  try {
    const { PerformanceAnalyzer } = require('./backtest/performanceAnalyzer');
    const { ReportGenerator } = require('./backtest/reportGenerator');
    const analyzer = new PerformanceAnalyzer();
    const perfMetrics = analyzer.analyze(
      coordinator.equityHistory,
      coordinator.state.tradeHistory,
      config.total_capital
    );
    const reporter = new ReportGenerator();
    const reportPath = path.join(dashDir, `report-${Date.now()}.html`);
    reporter.generate({
      equityCurve: coordinator.equityHistory,
      drawdownCurve: coordinator.equityHistory.map(pt => ({
        t: pt.t,
        drawdown: Math.max(0, (coordinator.state.peakEquity - pt.equity) / coordinator.state.peakEquity) * 100,
      })),
      trades: coordinator.state.tradeHistory,
      agentStats: coordinator.state.agentStats,
      metrics: perfMetrics,
      mode: config.mode,
      cyclesRun: coordinator.equityHistory.length - 1,
    }, reportPath);
    log('report', `HTML report → ${reportPath}`);
  } catch (e) {
    log('report', `Could not generate HTML report: ${e.message}`);
  }
}

main().catch(err => {
  log('fatal', `Startup error: ${err.stack || err.message}`);
  process.exit(1);
});
