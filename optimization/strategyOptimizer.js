'use strict';

const fs = require('fs');
const path = require('path');

const { ClaudeAdvisor } = require('./claudeAdvisor');
const { HistoricalLoader } = require('../backtest/historicalLoader');
const { ReplayEngine } = require('../backtest/replayEngine');
const { PerformanceAnalyzer } = require('../backtest/performanceAnalyzer');
const { ReportGenerator } = require('../backtest/reportGenerator');
const agentParams = require('../shared/agentParams');
const { ensureDir } = require('../shared/dataStore');

const SEPARATOR = '─'.repeat(60);

// Fixed seed markets with guaranteed inter-group divergence so the arbitrage
// agent always has opportunities regardless of GBM noise variance.
const SEED_MARKETS = [
  { id: 'election_2028',      group: 'politics', impliedProb: 0.68, volatility: 0.25 },
  { id: 'btc_100k_2026',      group: 'crypto',   impliedProb: 0.32, volatility: 0.40 },
  { id: 'fed_cut_q3',         group: 'macro',    impliedProb: 0.74, volatility: 0.20 },
  { id: 'championship_team_a',group: 'sports',   impliedProb: 0.28, volatility: 0.35 },
  { id: 'oil_above_100',      group: 'macro',    impliedProb: 0.41, volatility: 0.28 },
  // ↑ fed_cut_q3 (0.74) vs oil_above_100 (0.41) → divergence 0.33 >> arbitrage threshold
];

class StrategyOptimizer {
  constructor({ config, agents, outDir, restAdapter = null }) {
    this.baseConfig = JSON.parse(JSON.stringify(config));
    this.agents = agents;
    this.outDir = outDir;
    this.restAdapter = restAdapter;
    this.analyzer = new PerformanceAnalyzer();
    this.history = [];

    // Claude advisor is optional — heuristic fallback handles missing / expired keys
    try {
      this.advisor = new ClaudeAdvisor(process.env.CLAUDE_API_KEY);
    } catch {
      this.advisor = null;
      console.log('[opt] CLAUDE_API_KEY not set — will use heuristic optimisation only');
    }
  }

  /**
   * @param {number} maxIterations
   * @param {number} targetWinRate  e.g. 0.70
   * @param {number} minTrades      reject solutions that trade too rarely
   * @param {number} backtestDays   fast backtest window during optimisation
   */
  async run({ maxIterations = 12, targetWinRate = 0.70, minTrades = 15, backtestDays = 10 } = {}) {
    ensureDir(this.outDir);
    const logPath = path.join(this.outDir, `optimize-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const log = (msg) => { console.log(msg); logStream.write(msg + '\n'); };

    log(`\n${SEPARATOR}`);
    log(`Strategy Optimizer  target=${Math.round(targetWinRate * 100)}%  maxIter=${maxIterations}  claude=${this.advisor ? 'yes' : 'heuristic-only'}`);
    log(SEPARATOR);

    let liveConfig = JSON.parse(JSON.stringify(this.baseConfig));
    liveConfig.mode = 'backtest';
    agentParams.reset();

    let bestWinRate = 0;
    let bestConfig = JSON.parse(JSON.stringify(liveConfig));
    let bestAgentParams = agentParams.getAll();

    // ── Generate synthetic dataset ────────────────────────────────────────────
    log(`\n[opt] Generating ${backtestDays}-day synthetic dataset (${backtestDays * 96} steps)...`);
    const loader = new HistoricalLoader(this.restAdapter);
    const historicalData = await loader.generateSynthetic(SEED_MARKETS, backtestDays);

    // ── Iteration loop ────────────────────────────────────────────────────────
    for (let iter = 1; iter <= maxIterations; iter++) {
      log(`\n${SEPARATOR}`);
      log(`[opt] Iteration ${iter}/${maxIterations}`);
      log(SEPARATOR);

      const btResult = await this._runBacktest(historicalData, liveConfig);
      const metrics = this.analyzer.analyze(btResult.equityCurve, btResult.trades, liveConfig.total_capital);

      const winRatePct = parseFloat(metrics.winRate);   // already a "%" string like "76.20%"
      const winRateNum = isNaN(winRatePct) ? 0 : winRatePct;
      const totalTrades = metrics.totalTrades;

      log(`[opt] Win rate: ${metrics.winRate}  (target ≥${Math.round(targetWinRate * 100)}%)  trades: ${totalTrades}`);
      log(`[opt] PnL: $${metrics.totalPnl}  Sharpe: ${metrics.sharpe}  MaxDD: ${metrics.maxDrawdown}`);

      // Per-agent win rates + inactive detection
      const breakdown = metrics.agentBreakdown || {};
      const ALL_AGENTS = ['mispricing', 'news', 'market_maker', 'arbitrage', 'liquidity'];
      log('[opt] Agent status:');
      for (const agent of ALL_AGENTS) {
        if (!agentParams.isEnabled(agent)) {
          log(`  ${agent.padEnd(14)} ✗ ELIMINATED`);
          continue;
        }
        const s = breakdown[agent];
        if (!s || s.trades === 0) {
          log(`  ${agent.padEnd(14)} — inactive (0 trades — signals filtered by threshold)`);
        } else {
          const wr = parseFloat(s.winRate);
          const flag = wr < 40 ? ' ⚠ underperforming' : wr > 70 ? ' ★ best' : '';
          log(`  ${agent.padEnd(14)} wr=${s.winRate}  trades=${s.trades}  pnl=$${s.totalPnl}${flag}`);
        }
      }

      // ── Track best valid result ─────────────────────────────────────────────
      if (winRateNum > bestWinRate && totalTrades >= minTrades) {
        bestWinRate = winRateNum;
        bestConfig = JSON.parse(JSON.stringify(liveConfig));
        bestAgentParams = agentParams.getAll();
      }

      this.history.push({
        iteration: iter,
        winRate: winRateNum,
        totalTrades,
        sharpe: metrics.sharpe,
        totalPnl: metrics.totalPnl,
        changes: null,
        config: JSON.parse(JSON.stringify(liveConfig)),
        agentSnapshot: agentParams.getAll(),
      });

      // ── Success check ───────────────────────────────────────────────────────
      if (winRateNum >= targetWinRate * 100 && totalTrades >= minTrades) {
        log(`\n✓ Target reached! Win rate ${metrics.winRate} ≥ ${Math.round(targetWinRate * 100)}% with ${totalTrades} trades`);
        break;
      }

      if (iter === maxIterations) {
        log(`\n[opt] Max iterations reached. Best win rate: ${bestWinRate.toFixed(2)}%`);
        break;
      }

      // ── Compute improvements (Claude first, heuristic fallback) ─────────────
      let suggestion = null;

      if (this.advisor) {
        try {
          log('\n[opt] Consulting Claude for strategy improvements...');
          suggestion = await this.advisor.suggestImprovements({
            iteration: iter,
            currentConfig: this._serializeConfig(liveConfig),
            metrics,
            agentBreakdown: breakdown,
            history: this.history.slice(-4),
            targetWinRate,
          });
          log(`[opt] Claude: ${suggestion.analysis}`);
        } catch (e) {
          log(`[opt] Claude unavailable (${e.message.split(':')[0]}) — using heuristic`);
        }
      }

      if (!suggestion) {
        suggestion = this._heuristicImprovements(winRateNum, totalTrades, liveConfig, breakdown);
        log(`[opt] Heuristic: ${suggestion.analysis}`);
      }

      // ── Apply changes ───────────────────────────────────────────────────────
      const changes = suggestion.changes || {};
      const appliedChanges = this._applyChanges(changes, liveConfig, log);

      if (Object.keys(appliedChanges).length === 0 && totalTrades < minTrades) {
        // Hard reset: thresholds are too strict — open them up
        log('[opt] No progress and no trades — resetting thresholds to permissive values');
        liveConfig.ev_threshold = 0.03;
        liveConfig.confidence_threshold = 0.50;
        appliedChanges._reset = true;
      }

      this.history[this.history.length - 1].changes = appliedChanges;
    }

    // ── Final 30-day validation backtest ──────────────────────────────────────
    log(`\n${SEPARATOR}`);
    log('[opt] Running final 30-day validation with best config...');
    log(SEPARATOR);

    agentParams.reset();
    agentParams.updateMany(bestAgentParams);

    const fullData = await loader.generateSynthetic(SEED_MARKETS, 30);
    const finalResult = await this._runBacktest(fullData, bestConfig);
    const finalMetrics = this.analyzer.analyze(finalResult.equityCurve, finalResult.trades, bestConfig.total_capital);

    log(`[opt] FINAL win rate: ${finalMetrics.winRate}  trades: ${finalMetrics.totalTrades}  Sharpe: ${finalMetrics.sharpe}  PnL: $${finalMetrics.totalPnl}`);
    this._logAgentEliminations(bestAgentParams, log);

    // ── Save optimal config ───────────────────────────────────────────────────
    // Fix: resolve project root as parent of outDir (outDir = dashboard/)
    const projectRoot = path.resolve(this.outDir, '..');
    const optimalConfigPath = path.join(projectRoot, 'config', 'config-optimized.json');
    ensureDir(path.dirname(optimalConfigPath));

    const optimalConfig = {
      ...bestConfig,
      _optimized: {
        timestamp: new Date().toISOString(),
        iterations: this.history.length,
        finalWinRate: finalMetrics.winRate,
        agentParams: bestAgentParams,
      },
    };
    fs.writeFileSync(optimalConfigPath, JSON.stringify(optimalConfig, null, 2), 'utf8');
    log(`[opt] Optimal config → ${optimalConfigPath}`);

    // ── HTML report ───────────────────────────────────────────────────────────
    const reporter = new ReportGenerator();
    const reportPath = path.join(this.outDir, `optimize-report-${Date.now()}.html`);
    reporter.generate({ ...finalResult, metrics: finalMetrics, mode: 'optimize', cyclesRun: finalResult.cyclesRun }, reportPath);
    log(`[opt] Report → ${reportPath}`);

    fs.writeFileSync(
      path.join(this.outDir, 'optimization-history.json'),
      JSON.stringify(this.history, null, 2), 'utf8'
    );

    logStream.close();
    return { bestWinRate: finalMetrics.winRate, iterations: this.history.length, finalMetrics, optimalConfig: bestConfig, reportPath };
  }

  // ── Heuristic improvement rules (no Claude required) ──────────────────────

  _heuristicImprovements(winRateNum, totalTrades, cfg, agentBreakdown) {
    const changes = {};

    if (totalTrades < 5) {
      // Nothing traded — thresholds are too tight, open them up
      changes.ev_threshold = Math.max(0.03, cfg.ev_threshold - 0.015);
      changes.confidence_threshold = Math.max(0.50, cfg.confidence_threshold - 0.03);
      return { changes, analysis: `0-trade deadlock — relaxing ev_threshold → ${changes.ev_threshold.toFixed(3)} and confidence_threshold → ${changes.confidence_threshold.toFixed(3)}` };
    }

    // Raise thresholds proportionally to close the gap
    if (winRateNum < 50) {
      changes.ev_threshold = Math.min(0.15, cfg.ev_threshold + 0.025);
      changes.confidence_threshold = Math.min(0.85, cfg.confidence_threshold + 0.05);
    } else if (winRateNum < 65) {
      changes.ev_threshold = Math.min(0.14, cfg.ev_threshold + 0.015);
      changes.confidence_threshold = Math.min(0.83, cfg.confidence_threshold + 0.04);
    } else if (winRateNum < 75) {
      changes.ev_threshold = Math.min(0.13, cfg.ev_threshold + 0.008);
      changes.confidence_threshold = Math.min(0.80, cfg.confidence_threshold + 0.02);
    } else {
      changes.confidence_threshold = Math.min(0.78, cfg.confidence_threshold + 0.01);
    }

    // Agent-level culling
    const agentChanges = {};
    const currentAlloc = cfg.agent_allocations || {};
    const newAlloc = { ...currentAlloc };
    let topAgent = null;
    let topWr = 0;

    for (const [agent, stats] of Object.entries(agentBreakdown)) {
      if (stats.trades < 3) continue;
      const wr = parseFloat(stats.winRate);

      if (wr < 25) {
        // Disable — consistently losing
        agentChanges[agent] = { enabled: false };
        newAlloc[agent] = 0.01;
      } else if (wr < 40) {
        // Underperforming — boost confidence bar, shrink size
        agentChanges[agent] = { confidenceScale: Math.min(1.4, (agentParams.get(agent).confidenceScale || 1) + 0.1), sizeScale: 0.7 };
        newAlloc[agent] = Math.max(0.02, (currentAlloc[agent] || 0.2) * 0.7);
      }

      if (wr > topWr) { topWr = wr; topAgent = agent; }
    }

    // Reward the best performer
    if (topAgent && topWr > 65) {
      newAlloc[topAgent] = Math.min(0.55, (currentAlloc[topAgent] || 0.2) * 1.2);
    }

    // Normalise allocations so sum ≤ 1
    const total = Object.values(newAlloc).reduce((s, v) => s + v, 0);
    if (total > 0.99) {
      for (const k of Object.keys(newAlloc)) newAlloc[k] = Math.round((newAlloc[k] / total) * 1000) / 1000;
    }

    changes.agent_allocations = newAlloc;
    if (Object.keys(agentChanges).length) changes.agentParams = agentChanges;

    return { changes, analysis: `wr=${winRateNum.toFixed(1)}% — raising thresholds, culling underperformers` };
  }

  // ── Apply a changes object to liveConfig + agentParams ────────────────────

  _applyChanges(changes, liveConfig, log) {
    const applied = {};

    const scalarFields = ['ev_threshold', 'confidence_threshold', 'fractional_kelly', 'cooldown_cycles_after_loss'];
    for (const f of scalarFields) {
      if (changes[f] != null && changes[f] !== liveConfig[f]) {
        const old = liveConfig[f];
        liveConfig[f] = changes[f];
        applied[f] = { from: old, to: changes[f] };
        log(`  ${f.padEnd(30)} ${old} → ${changes[f]}`);
      }
    }

    if (changes.agent_allocations) {
      if (!liveConfig.agent_allocations) liveConfig.agent_allocations = {};
      for (const [agent, val] of Object.entries(changes.agent_allocations)) {
        const old = liveConfig.agent_allocations[agent];
        if (old !== val) {
          liveConfig.agent_allocations[agent] = val;
          applied[`alloc.${agent}`] = { from: old, to: val };
          log(`  agent_allocations.${agent.padEnd(14)} ${(old || 0).toFixed(3)} → ${val.toFixed(3)}`);
        }
      }
    }

    if (changes.agentParams) {
      for (const [agent, p] of Object.entries(changes.agentParams)) {
        const prev = agentParams.get(agent);
        agentParams.update(agent, p);
        for (const [k, v] of Object.entries(p)) {
          if (prev[k] !== v) {
            applied[`agentParams.${agent}.${k}`] = { from: prev[k], to: v };
            const enabledStr = k === 'enabled' ? (v ? ' ✓' : ' ✗ DISABLED') : '';
            log(`  agentParams.${agent}.${k.padEnd(16)} ${prev[k]} → ${v}${enabledStr}`);
          }
        }
      }
    }

    return applied;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async _runBacktest(historicalData, config) {
    const replayEngine = new ReplayEngine({
      config: { ...config, mode: 'backtest' },
      agents: this.agents,
    });
    return replayEngine.run(historicalData);
  }

  _serializeConfig(cfg) {
    return {
      ev_threshold: cfg.ev_threshold,
      confidence_threshold: cfg.confidence_threshold,
      fractional_kelly: cfg.fractional_kelly,
      cooldown_cycles_after_loss: cfg.cooldown_cycles_after_loss,
      agent_allocations: cfg.agent_allocations,
      agentParams: agentParams.getAll(),
    };
  }

  _logAgentEliminations(finalAgentParams, log) {
    const disabled = Object.entries(finalAgentParams).filter(([, p]) => p.enabled === false).map(([a]) => a);
    const tuned = Object.entries(finalAgentParams).filter(([, p]) => p.confidenceScale > 1.05 || p.sizeScale < 0.9).map(([a]) => a);
    if (disabled.length) log(`[opt] Eliminated agents: ${disabled.join(', ')}`);
    if (tuned.length) log(`[opt] Tuned agents (higher bar): ${tuned.join(', ')}`);
  }
}

module.exports = { StrategyOptimizer };
