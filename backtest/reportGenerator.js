'use strict';

const fs = require('fs');

class ReportGenerator {
  /**
   * Generate a self-contained HTML performance report.
   * @param {object} result  — combined ReplayEngine + PerformanceAnalyzer output
   * @param {string} outPath — where to write the .html file
   */
  generate(result, outPath) {
    const html = this._buildHtml(result);
    fs.writeFileSync(outPath, html, 'utf8');
    return outPath;
  }

  _buildHtml({ equityCurve, drawdownCurve, trades, metrics, agentStats, mode, cyclesRun }) {
    const m = metrics || {};
    const fmt = v => (v !== undefined && v !== null ? v : '—');

    // ── Equity chart data ────────────────────────────────────────────────────
    const eqLabels = JSON.stringify(equityCurve.map(p => new Date(p.t).toLocaleDateString()));
    const eqData = JSON.stringify(equityCurve.map(p => p.equity));

    // ── Drawdown chart data ──────────────────────────────────────────────────
    const ddLabels = JSON.stringify(drawdownCurve.map(p => new Date(p.t).toLocaleDateString()));
    const ddData = JSON.stringify(drawdownCurve.map(p => -Math.abs(p.drawdown)));

    // ── Agent PnL bar chart ──────────────────────────────────────────────────
    const agentNames = Object.keys(agentStats || {});
    const agentPnls = agentNames.map(n => (agentStats[n]?.pnl || 0).toFixed(2));
    const agentColors = agentPnls.map(v => parseFloat(v) >= 0 ? '#00d4a0' : '#ff5252');

    // ── Trade PnL distribution histogram ────────────────────────────────────
    const tradePnls = (trades || []).map(t => t.pnl || 0);
    const { bins, counts } = histogramBins(tradePnls, 20);

    // ── Rolling Sharpe (20-period window) ────────────────────────────────────
    const equityArr = equityCurve.map(p => p.equity);
    const rolling = rollingMetric(equityArr, 40);
    const rollingLabels = JSON.stringify(equityCurve.slice(40).map(p => new Date(p.t).toLocaleDateString()));
    const rollingSharpe = JSON.stringify(rolling);

    const timestamp = new Date().toLocaleString();
    const title = `Polymarket Backtest Report — ${mode || 'backtest'}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    :root {
      --bg: #0d0f1a; --card: #161929; --border: #252840;
      --primary: #4f9cf9; --success: #00d4a0; --danger: #ff5252;
      --warn: #ffb347; --text: #e2e8f0; --muted: #6b7280;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
    header { padding: 24px 32px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 20px; font-weight: 600; color: var(--primary); }
    header span { color: var(--muted); font-size: 12px; }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px 32px; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
    .stat-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 8px; }
    .stat-card .value { font-size: 22px; font-weight: 700; }
    .stat-card.positive .value { color: var(--success); }
    .stat-card.negative .value { color: var(--danger); }
    .stat-card.neutral .value { color: var(--primary); }
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
    .chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .chart-card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 16px; }
    .chart-card.full { grid-column: 1 / -1; }
    canvas { max-height: 280px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    td.pos { color: var(--success); } td.neg { color: var(--danger); }
    .section-title { font-size: 16px; font-weight: 600; margin: 32px 0 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  </style>
</head>
<body>
<header>
  <h1>📊 ${title}</h1>
  <span>Generated ${timestamp} | Cycles: ${cyclesRun || 0} | Trades: ${(trades || []).length}</span>
</header>
<div class="container">

  <div class="stat-grid">
    ${statCard('Final Equity', '$' + fmt(m.finalEquity), m.finalEquity >= (m.initialEquity || 0) ? 'positive' : 'negative')}
    ${statCard('Total PnL', '$' + fmt(m.totalPnl), parseFloat(m.totalPnl) >= 0 ? 'positive' : 'negative')}
    ${statCard('Total Return', fmt(m.totalReturn), parseFloat(m.totalReturn) >= 0 ? 'positive' : 'negative')}
    ${statCard('Sharpe Ratio', fmt(m.sharpe), parseFloat(m.sharpe) >= 1 ? 'positive' : parseFloat(m.sharpe) >= 0 ? 'neutral' : 'negative')}
    ${statCard('Sortino Ratio', fmt(m.sortino), parseFloat(m.sortino) >= 1 ? 'positive' : 'neutral')}
    ${statCard('Max Drawdown', fmt(m.maxDrawdown), 'negative')}
    ${statCard('Win Rate', fmt(m.winRate), parseFloat(m.winRate) >= 50 ? 'positive' : 'neutral')}
    ${statCard('CAGR', fmt(m.cagr), parseFloat(m.cagr) >= 0 ? 'positive' : 'negative')}
    ${statCard('Profit Factor', fmt(m.profitFactor), parseFloat(m.profitFactor) >= 1.5 ? 'positive' : 'neutral')}
    ${statCard('Expectancy', '$' + fmt(m.expectancy), parseFloat(m.expectancy) >= 0 ? 'positive' : 'negative')}
    ${statCard('Calmar Ratio', fmt(m.calmar), parseFloat(m.calmar) >= 0.5 ? 'positive' : 'neutral')}
    ${statCard('Trading Days', fmt(m.tradingDays), 'neutral')}
  </div>

  <div class="charts-grid">
    <div class="chart-card full">
      <h3>Equity Curve</h3>
      <canvas id="equityChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Drawdown (%)</h3>
      <canvas id="drawdownChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Rolling Sharpe (40-step window)</h3>
      <canvas id="sharpeChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Agent PnL</h3>
      <canvas id="agentChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Trade PnL Distribution</h3>
      <canvas id="distChart"></canvas>
    </div>
  </div>

  <div class="section-title">Agent Breakdown</div>
  <table>
    <thead><tr><th>Agent</th><th>Trades</th><th>Win Rate</th><th>Total PnL</th><th>Avg PnL</th></tr></thead>
    <tbody>
      ${Object.entries(m.agentBreakdown || {}).map(([agent, s]) => `
        <tr>
          <td>${agent}</td>
          <td>${s.trades}</td>
          <td>${s.winRate}</td>
          <td class="${parseFloat(s.totalPnl) >= 0 ? 'pos' : 'neg'}">$${s.totalPnl}</td>
          <td class="${parseFloat(s.avgPnl) >= 0 ? 'pos' : 'neg'}">$${s.avgPnl}</td>
        </tr>`).join('')}
    </tbody>
  </table>

</div>

<script>
Chart.defaults.color = '#6b7280';
Chart.defaults.borderColor = '#252840';
const gridColor = 'rgba(37,40,64,0.6)';

// Equity Curve
new Chart(document.getElementById('equityChart'), {
  type: 'line',
  data: {
    labels: ${eqLabels},
    datasets: [{ label: 'Equity ($)', data: ${eqData}, borderColor: '#4f9cf9', backgroundColor: 'rgba(79,156,249,0.08)', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: gridColor }, ticks: { maxTicksLimit: 10 } }, y: { grid: { color: gridColor } } } }
});

// Drawdown
new Chart(document.getElementById('drawdownChart'), {
  type: 'line',
  data: {
    labels: ${ddLabels},
    datasets: [{ label: 'Drawdown (%)', data: ${ddData}, borderColor: '#ff5252', backgroundColor: 'rgba(255,82,82,0.12)', borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: true }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: gridColor }, ticks: { maxTicksLimit: 8 } }, y: { grid: { color: gridColor } } } }
});

// Rolling Sharpe
new Chart(document.getElementById('sharpeChart'), {
  type: 'line',
  data: {
    labels: ${rollingLabels},
    datasets: [{ label: 'Rolling Sharpe', data: ${rollingSharpe}, borderColor: '#ffb347', backgroundColor: 'rgba(255,179,71,0.08)', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: true }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: gridColor }, ticks: { maxTicksLimit: 8 } }, y: { grid: { color: gridColor } } } }
});

// Agent PnL
new Chart(document.getElementById('agentChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(agentNames)},
    datasets: [{ label: 'PnL ($)', data: ${JSON.stringify(agentPnls)}, backgroundColor: ${JSON.stringify(agentColors)}, borderRadius: 6 }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: gridColor } }, y: { grid: { color: gridColor } } } }
});

// Distribution
new Chart(document.getElementById('distChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(bins)},
    datasets: [{ label: 'Trades', data: ${JSON.stringify(counts)}, backgroundColor: 'rgba(79,156,249,0.7)', borderRadius: 4 }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: gridColor } }, y: { grid: { color: gridColor } } } }
});
</script>
</body>
</html>`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function statCard(label, value, cls = 'neutral') {
  return `<div class="stat-card ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function histogramBins(values, numBins) {
  if (!values.length) return { bins: [], counts: [] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min) / numBins || 1;
  const counts = new Array(numBins).fill(0);
  for (const v of values) {
    const i = Math.min(numBins - 1, Math.floor((v - min) / step));
    counts[i]++;
  }
  const bins = Array.from({ length: numBins }, (_, i) => `${(min + i * step).toFixed(2)}`);
  return { bins, counts };
}

function rollingMetric(equityArr, window) {
  const result = [];
  for (let i = window; i < equityArr.length; i++) {
    const slice = equityArr.slice(i - window, i);
    const returns = slice.slice(1).map((v, j) => (v - slice[j]) / slice[j]);
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    result.push(std === 0 ? 0 : Math.round((mean / std) * Math.sqrt(252 * 96) * 100) / 100);
  }
  return result;
}

module.exports = { ReportGenerator };
