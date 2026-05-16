'use strict';

const fs   = require('fs');
const path = require('path');

const { HistoricalLoader }  = require('../backtest/historicalLoader');
const { ReplayEngine }      = require('../backtest/replayEngine');
const { PerformanceAnalyzer } = require('../backtest/performanceAnalyzer');
const { StrategyOptimizer } = require('./strategyOptimizer');
const agentParams           = require('../shared/agentParams');
const { ensureDir }         = require('../shared/dataStore');

const BAR  = '═'.repeat(62);
const LINE = '─'.repeat(62);

// Fixed seed markets — deterministic divergence for the arbitrage agent
const SEED_MARKETS = [
  { id: 'election_2028',       group: 'politics', impliedProb: 0.68, volatility: 0.25 },
  { id: 'btc_100k_2026',       group: 'crypto',   impliedProb: 0.32, volatility: 0.40 },
  { id: 'fed_cut_q3',          group: 'macro',    impliedProb: 0.74, volatility: 0.20 },
  { id: 'championship_team_a', group: 'sports',   impliedProb: 0.28, volatility: 0.35 },
  { id: 'oil_above_100',       group: 'macro',    impliedProb: 0.41, volatility: 0.28 },
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

class AnnualAnalyzer {
  constructor({ config, agents, outDir, restAdapter = null }) {
    this.config      = JSON.parse(JSON.stringify(config));
    this.config.mode = 'backtest';
    this.agents      = agents;
    this.outDir      = outDir;
    this.restAdapter = restAdapter;
    this.analyzer    = new PerformanceAnalyzer();
  }

  /**
   * Entry point.
   * @param {number} targetWinRate  e.g. 0.80
   * @param {number} maxRounds      max optimisation + re-analysis rounds
   */
  async run({ targetWinRate = 0.80, maxRounds = 6 } = {}) {
    ensureDir(this.outDir);
    const runId    = Date.now();
    const logPath  = path.join(this.outDir, `annual-${runId}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const log = (...args) => {
      const msg = args.join(' ');
      console.log(msg);
      logStream.write(msg + '\n');
    };

    log(`\n${BAR}`);
    log(` Annual Analysis Pipeline  — target ≥${Math.round(targetWinRate * 100)}% stable win rate`);
    log(BAR);

    // ── 1. Generate / fetch 365-day data ──────────────────────────────────────
    log('\n[annual] Loading 365-day market dataset…');
    const loader = new HistoricalLoader(this.restAdapter);
    let yearData;

    if (this.restAdapter) {
      try {
        const raw   = await this.restAdapter.getGammaMarkets({ limit: 10, active: true });
        const mkts  = Array.isArray(raw) ? raw : (raw.markets || []);
        const ids   = mkts.slice(0, 5).map(m => m.conditionId).filter(Boolean);
        if (ids.length >= 3) {
          yearData = await loader.loadFromApi(ids, 365);
          log(`[annual] Loaded real data for ${yearData.size} markets`);
        }
      } catch (e) {
        log(`[annual] Real data unavailable (${e.message}) — using synthetic`);
      }
    }
    if (!yearData) {
      yearData = await loader.generateSynthetic(SEED_MARKETS, 365);
      log(`[annual] Synthetic data: ${yearData.size} markets × ${[...yearData.values()][0].length} steps`);
    }

    let liveConfig   = JSON.parse(JSON.stringify(this.config));
    let bestResult   = null;
    let bestStability = { stable: false, mean: 0, std: 999 };
    let round        = 0;
    const roundLog   = [];

    // ── 2. Continuous analysis + optimisation loop ────────────────────────────
    while (round < maxRounds) {
      round++;
      log(`\n${LINE}`);
      log(` Round ${round}/${maxRounds}`);
      log(LINE);

      // Full-year backtest
      log('[annual] Running full 365-day backtest…');
      const fullResult  = await this._backtest(yearData, liveConfig);
      const fullMetrics = this.analyzer.analyze(
        fullResult.equityCurve, fullResult.trades, liveConfig.total_capital
      );
      log(`[annual] Full year → wr=${fullMetrics.winRate}  PnL=$${fullMetrics.totalPnl}  trades=${fullMetrics.totalTrades}  Sharpe=${fullMetrics.sharpe}`);

      // Rolling 30-day windows (12 monthly slices + overlapping 7-day stride)
      log('[annual] Running rolling-window analysis (30-day / 7-day stride)…');
      const windows = await this._rollingWindows(yearData, liveConfig);
      log(`[annual] ${windows.length} windows completed`);

      // Stability assessment
      const stability = this._stability(windows, targetWinRate);
      this._logStability(stability, log);

      // Per-agent regime analysis
      const regimeMatrix = this._buildRegimeMatrix(windows);

      const snapshot = {
        round,
        fullResult,
        fullMetrics,
        windows,
        stability,
        regimeMatrix,
        config: JSON.parse(JSON.stringify(liveConfig)),
        agentSnapshot: agentParams.getAll(),
      };
      roundLog.push({ round, winRateMean: stability.mean, winRateStd: stability.std, config: JSON.parse(JSON.stringify(liveConfig)) });

      if (stability.mean > (bestStability.mean || 0)) {
        bestResult    = snapshot;
        bestStability = stability;
      }

      if (stability.stable) {
        log(`\n✓ Win rate is stable at ${stability.mean.toFixed(1)}% ± ${stability.std.toFixed(1)}%`);
        break;
      }

      if (round >= maxRounds) {
        log(`\n[annual] Max rounds reached — finalising with best result (wr=${bestStability.mean.toFixed(1)}%)`);
        break;
      }

      // ── Optimise and re-run ─────────────────────────────────────────────────
      log(`\n[annual] Win rate unstable — running optimisation pass…`);
      try {
        const opt = new StrategyOptimizer({
          config:      liveConfig,
          agents:      this.agents,
          outDir:      this.outDir,
          restAdapter: this.restAdapter,
        });
        const optResult = await opt.run({
          maxIterations: 5,
          targetWinRate,
          minTrades:   10,
          backtestDays: 30,
        });
        liveConfig = optResult.optimalConfig || liveConfig;
        log(`[annual] Optimisation → best_wr=${optResult.bestWinRate}`);
      } catch (e) {
        log(`[annual] Optimisation error: ${e.message} — continuing with current config`);
      }
    }

    // ── 3. Generate comprehensive final report ────────────────────────────────
    log(`\n${BAR}`);
    log(' Generating final comprehensive report…');
    log(BAR);

    const { AnnualReport } = require('../backtest/annualReport');
    const reporter  = new AnnualReport();
    const reportPath = path.join(this.outDir, `annual-report-${runId}.html`);
    reporter.generate({ ...bestResult, roundLog, targetWinRate, runId }, reportPath);
    log(`[annual] Report → ${reportPath}`);

    // Save final config
    const projectRoot      = path.resolve(this.outDir, '..');
    const finalConfigPath  = path.join(projectRoot, 'config', 'config-annual.json');
    fs.writeFileSync(finalConfigPath, JSON.stringify({
      ...bestResult.config,
      _annual: { finalWinRate: bestResult.fullMetrics.winRate, stabilityMean: bestStability.mean, rounds: round, timestamp: new Date().toISOString() },
    }, null, 2), 'utf8');
    log(`[annual] Final config → ${finalConfigPath}`);

    logStream.close();
    return { ...bestResult, reportPath, rounds: round };
  }

  // ── Rolling window analysis ──────────────────────────────────────────────────

  async _rollingWindows(historicalData, config) {
    const first      = [...historicalData.values()][0];
    const total      = first.length;
    const winSteps   = 30 * 96;   // 30-day window
    const strideSteps = 7 * 96;   // 7-day stride
    const count      = Math.floor((total - winSteps) / strideSteps) + 1;
    const results    = [];

    for (let w = 0; w < count; w++) {
      const start = w * strideSteps;
      const end   = start + winSteps;

      const slice = new Map();
      for (const [id, series] of historicalData) {
        slice.set(id, series.slice(start, Math.min(end, series.length)));
      }

      const result  = await this._backtest(slice, config);
      const metrics = this.analyzer.analyze(result.equityCurve, result.trades, config.total_capital);
      const regime  = this._regime(slice);

      results.push({
        w,
        label: `W${w + 1}`,
        startTs: first[start]?.t || 0,
        endTs:   first[Math.min(end - 1, first.length - 1)]?.t || 0,
        metrics,
        agentStats: result.agentStats,
        regime,
      });

      const wr = metrics.winRate;
      process.stdout.write(`\r[annual] Window ${w + 1}/${count}  wr=${String(wr).padEnd(8)} regime=${regime.volatilityLevel}`);
    }
    process.stdout.write('\n');
    return results;
  }

  // ── Stability check ─────────────────────────────────────────────────────────

  _stability(windows, target) {
    const wrs   = windows.map(w => parseFloat(w.metrics.winRate) || 0).filter(v => !isNaN(v));
    if (!wrs.length) return { stable: false, mean: 0, std: 0, minWr: 0, maxWr: 0, cvPct: '∞', windowsAboveTarget: 0 };

    const mean  = wrs.reduce((s, v) => s + v, 0) / wrs.length;
    const std   = Math.sqrt(wrs.reduce((s, v) => s + (v - mean) ** 2, 0) / wrs.length);
    const minWr = Math.min(...wrs);
    const maxWr = Math.max(...wrs);
    const aboveTgt = wrs.filter(v => v >= target * 100).length;
    const pctAbove = (aboveTgt / wrs.length) * 100;

    const stable = mean >= target * 100 - 5    // mean within 5pp of target
      && std   <= 10                            // low variance across windows
      && minWr >= target * 100 - 20            // no catastrophic windows
      && pctAbove >= 65;                        // ≥65% of windows hit target

    return { stable, mean, std, minWr, maxWr, cvPct: (std / Math.max(1, mean) * 100).toFixed(1), aboveTgt, pctAbove: pctAbove.toFixed(1) };
  }

  _logStability(s, log) {
    log(`[annual] Stability → mean=${s.mean.toFixed(2)}%  std=±${s.std.toFixed(2)}%  min=${s.minWr.toFixed(2)}%  max=${s.maxWr.toFixed(2)}%  cv=${s.cvPct}%  above-target=${s.pctAbove}%`);
    log(`[annual] Verdict: ${s.stable ? '✓ STABLE' : '✗ not yet stable'}`);
  }

  // ── Market regime detection ─────────────────────────────────────────────────

  _regime(windowData) {
    const series = [...windowData.values()][0];
    const prices = series.map(p => p.p);
    const n      = prices.length;
    if (n < 4) return { volatilityLevel: 'unknown', trend: 'unknown', divergenceLevel: 'unknown', std: 0, slope: 0, spread: 0 };

    // Volatility: daily std of returns
    const returns = prices.slice(1).map((p, i) => (p - prices[i]) / Math.max(prices[i], 0.01));
    const rMean   = returns.reduce((s, r) => s + r, 0) / returns.length;
    const rStd    = Math.sqrt(returns.reduce((s, r) => s + (r - rMean) ** 2, 0) / returns.length);
    const volLevel = rStd < 0.003 ? 'low' : rStd < 0.008 ? 'medium' : 'high';

    // Trend: compare first-quarter avg vs last-quarter avg
    const q     = Math.floor(n / 4);
    const early = prices.slice(0, q).reduce((s, p) => s + p, 0) / q;
    const late  = prices.slice(-q).reduce((s, p) => s + p, 0) / q;
    const delta = late - early;
    const trend = Math.abs(delta) < 0.03 ? 'ranging' : delta > 0 ? 'bullish' : 'bearish';

    // Divergence: max spread between same-group markets
    const macroSeries = [...windowData.entries()]
      .filter(([id]) => id.includes('fed') || id.includes('oil'))
      .map(([, s]) => s[Math.floor(s.length / 2)]?.p || 0.5);
    const spread = macroSeries.length >= 2
      ? Math.max(...macroSeries) - Math.min(...macroSeries)
      : 0;
    const divLevel = spread < 0.10 ? 'converging' : spread < 0.25 ? 'moderate' : 'diverging';

    return { volatilityLevel: volLevel, trend, divergenceLevel: divLevel, std: rStd, slope: delta, spread };
  }

  // ── Per-agent regime performance matrix ────────────────────────────────────

  _buildRegimeMatrix(windows) {
    // For each (agent, regime) pair → average win rate
    const matrix = {}; // { agent: { regime: { wins, count } } }
    const ALL_AGENTS = ['mispricing', 'news', 'market_maker', 'arbitrage', 'liquidity'];

    for (const w of windows) {
      const regimeKey = `${w.regime.volatilityLevel}-${w.regime.trend}`;
      for (const agent of ALL_AGENTS) {
        const stats = w.agentStats?.[agent];
        if (!stats || stats.trades < 1) continue;
        if (!matrix[agent]) matrix[agent] = {};
        if (!matrix[agent][regimeKey]) matrix[agent][regimeKey] = { wins: 0, trades: 0, pnl: 0 };
        matrix[agent][regimeKey].wins   += stats.wins || 0;
        matrix[agent][regimeKey].trades += stats.trades || 0;
        matrix[agent][regimeKey].pnl    += stats.pnl || 0;
      }
    }

    // Convert to win rates
    const result = {};
    for (const [agent, regimes] of Object.entries(matrix)) {
      result[agent] = {};
      for (const [regime, data] of Object.entries(regimes)) {
        result[agent][regime] = {
          winRate: data.trades ? Math.round(data.wins / data.trades * 100) : 0,
          trades:  data.trades,
          pnl:     Math.round(data.pnl * 100) / 100,
        };
      }
    }
    return result;
  }

  async _backtest(data, config) {
    return new ReplayEngine({ config: { ...config, mode: 'backtest' }, agents: this.agents }).run(data);
  }
}

module.exports = { AnnualAnalyzer };
