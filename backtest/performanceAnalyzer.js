'use strict';

const RISK_FREE_RATE = 0.05; // 5% annual

class PerformanceAnalyzer {
  /**
   * Compute full suite of performance metrics from a backtest result.
   * @param {Array<{t:number, equity:number}>} equityCurve
   * @param {Array<object>} trades
   * @param {number} initialEquity
   */
  analyze(equityCurve, trades, initialEquity) {
    if (!equityCurve.length) return this._empty();

    const equityValues = equityCurve.map(p => p.equity);
    const returns = this._periodicReturns(equityValues);
    const startMs = equityCurve[0].t || 0;
    const endMs = equityCurve[equityCurve.length - 1].t || 0;
    const tradingDays = Math.max(1, (endMs - startMs) / (86400 * 1000));
    const tradingYears = tradingDays / 365;

    const finalEquity = equityValues[equityValues.length - 1];
    const totalReturn = (finalEquity - initialEquity) / initialEquity;
    const cagr = tradingYears > 0 ? Math.pow(1 + totalReturn, 1 / tradingYears) - 1 : 0;

    const { maxDrawdown, avgDrawdown, drawdownDurations } = this._drawdownStats(equityValues);
    const calmar = maxDrawdown > 0 ? cagr / maxDrawdown : 0;

    const sharpe = this._sharpe(returns, RISK_FREE_RATE, tradingYears);
    const sortino = this._sortino(returns, RISK_FREE_RATE, tradingYears);

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const winRate = trades.length ? wins.length / trades.length : 0;
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : Infinity;
    const expectancy = trades.length
      ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length
      : 0;

    const agentBreakdown = this._agentBreakdown(trades);

    return {
      // Summary
      initialEquity: r(initialEquity),
      finalEquity: r(finalEquity),
      totalPnl: r(finalEquity - initialEquity),
      totalReturn: pct(totalReturn),
      tradingDays: Math.round(tradingDays),
      // Return/risk ratios
      cagr: pct(cagr),
      sharpe: r(sharpe),
      sortino: r(sortino),
      calmar: r(calmar),
      // Drawdown
      maxDrawdown: pct(maxDrawdown),
      avgDrawdown: pct(avgDrawdown),
      avgDrawdownDurationDays: r(drawdownDurations.avg / 86400000),
      maxDrawdownDurationDays: r(drawdownDurations.max / 86400000),
      // Trade stats
      totalTrades: trades.length,
      winRate: pct(winRate),
      avgWin: r(avgWin),
      avgLoss: r(avgLoss),
      profitFactor: r(profitFactor),
      expectancy: r(expectancy),
      // Per-agent
      agentBreakdown,
    };
  }

  // ── Ratio calculations ─────────────────────────────────────────────────────

  _sharpe(returns, rfAnnual, tradingYears) {
    if (!returns.length) return 0;
    const stepsPerYear = returns.length / Math.max(0.01, tradingYears);
    const rfPerStep = rfAnnual / stepsPerYear;
    const excess = returns.map(r => r - rfPerStep);
    const mean = excess.reduce((s, r) => s + r, 0) / excess.length;
    const std = Math.sqrt(excess.reduce((s, r) => s + (r - mean) ** 2, 0) / excess.length);
    return std === 0 ? 0 : (mean / std) * Math.sqrt(stepsPerYear);
  }

  _sortino(returns, rfAnnual, tradingYears) {
    if (!returns.length) return 0;
    const stepsPerYear = returns.length / Math.max(0.01, tradingYears);
    const rfPerStep = rfAnnual / stepsPerYear;
    const excess = returns.map(r => r - rfPerStep);
    const mean = excess.reduce((s, r) => s + r, 0) / excess.length;
    const downside = excess.filter(r => r < 0);
    if (!downside.length) return mean > 0 ? Infinity : 0;
    const downsideDev = Math.sqrt(downside.reduce((s, r) => s + r ** 2, 0) / downside.length);
    return downsideDev === 0 ? 0 : (mean / downsideDev) * Math.sqrt(stepsPerYear);
  }

  _drawdownStats(equityValues) {
    let peak = equityValues[0];
    let maxDD = 0;
    let sumDD = 0;
    let ddCount = 0;
    let inDD = false;
    let ddStart = 0;
    const ddDurations = [];

    for (let i = 0; i < equityValues.length; i++) {
      const v = equityValues[i];
      if (v > peak) {
        if (inDD) {
          ddDurations.push(i - ddStart);
          inDD = false;
        }
        peak = v;
      }
      const dd = (peak - v) / peak;
      if (dd > 0 && !inDD) { inDD = true; ddStart = i; ddCount++; }
      maxDD = Math.max(maxDD, dd);
      sumDD += dd;
    }
    if (inDD) ddDurations.push(equityValues.length - ddStart);

    const avgDD = equityValues.length ? sumDD / equityValues.length : 0;
    const avgDur = ddDurations.length ? ddDurations.reduce((s, d) => s + d, 0) / ddDurations.length : 0;
    const maxDur = ddDurations.length ? Math.max(...ddDurations) : 0;

    // Convert step-counts to ms (rough 15-min steps)
    const stepMs = 15 * 60 * 1000;
    return {
      maxDrawdown: maxDD,
      avgDrawdown: avgDD,
      drawdownDurations: { avg: avgDur * stepMs, max: maxDur * stepMs },
    };
  }

  _periodicReturns(equityValues) {
    const returns = [];
    for (let i = 1; i < equityValues.length; i++) {
      if (equityValues[i - 1] !== 0) {
        returns.push((equityValues[i] - equityValues[i - 1]) / equityValues[i - 1]);
      }
    }
    return returns;
  }

  _agentBreakdown(trades) {
    const byAgent = {};
    for (const t of trades) {
      if (!byAgent[t.agent]) byAgent[t.agent] = { trades: 0, wins: 0, pnl: 0 };
      byAgent[t.agent].trades++;
      byAgent[t.agent].pnl += t.pnl;
      if (t.pnl > 0) byAgent[t.agent].wins++;
    }
    const result = {};
    for (const [agent, s] of Object.entries(byAgent)) {
      result[agent] = {
        trades: s.trades,
        winRate: pct(s.wins / Math.max(1, s.trades)),
        totalPnl: r(s.pnl),
        avgPnl: r(s.pnl / Math.max(1, s.trades)),
      };
    }
    return result;
  }

  _empty() {
    return {
      initialEquity: 0, finalEquity: 0, totalPnl: 0, totalReturn: '0%',
      tradingDays: 0, cagr: '0%', sharpe: 0, sortino: 0, calmar: 0,
      maxDrawdown: '0%', avgDrawdown: '0%', avgDrawdownDurationDays: 0,
      maxDrawdownDurationDays: 0, totalTrades: 0, winRate: '0%',
      avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, agentBreakdown: {},
    };
  }
}

function r(v) { return isFinite(v) ? Math.round(v * 1000) / 1000 : 0; }
function pct(v) { return isFinite(v) ? `${Math.round(v * 10000) / 100}%` : '0%'; }

module.exports = { PerformanceAnalyzer };
