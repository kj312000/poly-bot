'use strict';

const fs = require('fs');

/**
 * Generates a comprehensive single-file HTML report covering:
 *  - Full-year equity curve & drawdown
 *  - Rolling win-rate stability ribbon
 *  - Per-window performance heatmap
 *  - Agent strategy characterisation
 *  - Market-regime matrix (agent × regime win rates)
 *  - Optimisation-round progress
 *  - Full performance metrics table
 *  - Strategy recommendations
 */
class AnnualReport {
  generate(data, outPath) {
    fs.writeFileSync(outPath, this._html(data), 'utf8');
    return outPath;
  }

  _html({ fullResult, fullMetrics, windows, stability, regimeMatrix, roundLog, targetWinRate, runId }) {
    const m   = fullMetrics || {};
    const wrs = (windows || []).map(w => parseFloat(w.metrics?.winRate) || 0);
    const windowLabels = (windows || []).map(w => w.label || `W${w.w + 1}`);

    // ── Equity curve ────────────────────────────────────────────────────────
    const eq    = (fullResult?.equityCurve || []).filter((_, i) => i % 5 === 0); // downsample
    const eqLbl = JSON.stringify(eq.map(p => new Date(p.t).toLocaleDateString()));
    const eqDat = JSON.stringify(eq.map(p => +p.equity.toFixed(2)));

    // ── Drawdown curve ───────────────────────────────────────────────────────
    const dd    = (fullResult?.drawdownCurve || []).filter((_, i) => i % 5 === 0);
    const ddDat = JSON.stringify(dd.map(p => -(+p.drawdown.toFixed(3))));

    // ── Rolling win-rate ────────────────────────────────────────────────────
    const wrLbl = JSON.stringify(windowLabels);
    const wrDat = JSON.stringify(wrs.map(v => +v.toFixed(2)));
    const targetLine = JSON.stringify(wrs.map(() => targetWinRate * 100));

    // ── Agent PnL per window (stacked area data) ─────────────────────────────
    const ALL_AGENTS = ['mispricing', 'news', 'market_maker', 'arbitrage', 'liquidity'];
    const AGENT_COLORS = { mispricing:'#4f9cf9', news:'#00d4a0', market_maker:'#ffb347', arbitrage:'#c879ff', liquidity:'#ff6b6b' };
    const agentWindowPnl = {};
    for (const agent of ALL_AGENTS) {
      agentWindowPnl[agent] = (windows || []).map(w => {
        const s = w.agentStats?.[agent];
        return s ? +((s.pnl || 0).toFixed(2)) : 0;
      });
    }

    // ── Heatmap cells ────────────────────────────────────────────────────────
    const heatCells = this._heatmapHtml(windows || [], ALL_AGENTS);

    // ── Regime bar chart ─────────────────────────────────────────────────────
    const regimeData = this._regimeChartData(regimeMatrix || {}, ALL_AGENTS);

    // ── Agent characterisation ───────────────────────────────────────────────
    const agentCards = this._agentCards(windows || [], regimeMatrix || {});

    // ── Optimisation history ─────────────────────────────────────────────────
    const roundLabels = JSON.stringify((roundLog || []).map(r => `Round ${r.round}`));
    const roundWrs    = JSON.stringify((roundLog || []).map(r => +(r.winRateMean || 0).toFixed(2)));

    // ── Stability badge ──────────────────────────────────────────────────────
    const s = stability || {};
    const badge = s.stable
      ? `<span class="badge green">✓ STABLE</span>`
      : `<span class="badge yellow">⚠ CONVERGING</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Polymarket Annual Analysis Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root{--bg:#0d0f1a;--card:#161929;--card2:#1e2235;--border:#252840;--primary:#4f9cf9;--success:#00d4a0;--warn:#ffb347;--danger:#ff5252;--purple:#c879ff;--text:#e2e8f0;--muted:#6b7280}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:13px}
  header{padding:20px 32px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
  header h1{font-size:18px;font-weight:700;color:var(--primary)}
  .sub{color:var(--muted);font-size:11px}
  .container{max-width:1480px;margin:0 auto;padding:24px 32px}
  .section{margin-bottom:36px}
  .section-title{font-size:14px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:16px}
  .stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px}
  .stat .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
  .stat .val{font-size:20px;font-weight:700}
  .stat.pos .val{color:var(--success)}.stat.neg .val{color:var(--danger)}.stat.neu .val{color:var(--primary)}.stat.warn .val{color:var(--warn)}
  .chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .chart-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px}
  .chart-card h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:12px}
  .chart-card.full{grid-column:1/-1}
  canvas{max-height:260px}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}
  .badge.green{background:#00d4a022;color:var(--success);border:1px solid var(--success)}
  .badge.yellow{background:#ffb34722;color:var(--warn);border:1px solid var(--warn)}
  /* Heatmap */
  .heatmap{overflow-x:auto;margin-top:8px}
  .hm-table{border-collapse:collapse;min-width:100%}
  .hm-table th,.hm-table td{padding:5px 9px;border:1px solid var(--border);text-align:center;font-size:11px}
  .hm-table th{background:var(--card2);color:var(--muted);font-weight:600}
  .hm-cell-high{background:#00d4a033;color:#00d4a0}
  .hm-cell-mid{background:#ffb34722;color:#ffb347}
  .hm-cell-low{background:#ff525222;color:#ff5252}
  .hm-cell-none{color:var(--muted)}
  /* Agent cards */
  .agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
  .agent-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
  .agent-card .name{font-size:13px;font-weight:700;color:var(--primary);margin-bottom:4px;text-transform:capitalize}
  .agent-card .desc{font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:10px}
  .agent-card .kv{display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border)}
  .agent-card .kv .k{color:var(--muted)}.agent-card .kv .v{font-weight:600}
  .best-regime{display:inline-block;margin-top:8px;padding:2px 8px;border-radius:4px;font-size:10px;background:#4f9cf922;color:var(--primary);border:1px solid var(--primary)}
  /* Table */
  table.metrics{width:100%;border-collapse:collapse}
  table.metrics th,table.metrics td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);font-size:12px}
  table.metrics th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
  .pos{color:var(--success)}.neg{color:var(--danger)}.neu{color:var(--primary)}
  .stab-summary{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;gap:24px;flex-wrap:wrap;align-items:center}
  .stab-stat{text-align:center}
  .stab-stat .sv{font-size:22px;font-weight:700;color:var(--primary)}.stab-stat .sk{font-size:10px;color:var(--muted);text-transform:uppercase}
</style>
</head>
<body>
<header>
  <div>
    <h1>📈 Polymarket Annual Analysis Report</h1>
    <span class="sub">Run ${new Date().toLocaleString()}  ·  ${(windows||[]).length} rolling windows  ·  target ≥${Math.round((targetWinRate||0.8)*100)}%</span>
  </div>
  <div>${badge}</div>
</header>
<div class="container">

<!-- ── Overview ─────────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Annual Overview</div>
  <div class="stat-grid">
    ${this._card('Final Equity', '$'+m.finalEquity, m.finalEquity>=(m.initialEquity||1000)?'pos':'neg')}
    ${this._card('Total PnL', '$'+m.totalPnl, parseFloat(m.totalPnl)>=0?'pos':'neg')}
    ${this._card('Total Return', m.totalReturn, parseFloat(m.totalReturn)>=0?'pos':'neg')}
    ${this._card('Sharpe', m.sharpe, parseFloat(m.sharpe)>=1?'pos':parseFloat(m.sharpe)>=0?'neu':'neg')}
    ${this._card('Sortino', m.sortino, 'neu')}
    ${this._card('Max Drawdown', m.maxDrawdown, 'neg')}
    ${this._card('Win Rate', m.winRate, parseFloat(m.winRate)>=70?'pos':'warn')}
    ${this._card('Total Trades', m.totalTrades, 'neu')}
    ${this._card('Profit Factor', m.profitFactor, parseFloat(m.profitFactor)>=1.5?'pos':'warn')}
    ${this._card('CAGR', m.cagr, parseFloat(m.cagr)>=0?'pos':'neg')}
    ${this._card('Calmar', m.calmar, parseFloat(m.calmar)>=0.5?'pos':'warn')}
    ${this._card('Expectancy', '$'+m.expectancy, parseFloat(m.expectancy)>=0?'pos':'neg')}
  </div>
</div>

<!-- ── Stability ─────────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Win-Rate Stability across Rolling Windows</div>
  <div class="stab-summary" style="margin-bottom:16px">
    <div class="stab-stat"><div class="sv">${(s.mean||0).toFixed(1)}%</div><div class="sk">Mean Win Rate</div></div>
    <div class="stab-stat"><div class="sv">±${(s.std||0).toFixed(1)}%</div><div class="sk">Std Dev</div></div>
    <div class="stab-stat"><div class="sv">${(s.minWr||0).toFixed(1)}%</div><div class="sk">Worst Window</div></div>
    <div class="stab-stat"><div class="sv">${(s.maxWr||0).toFixed(1)}%</div><div class="sk">Best Window</div></div>
    <div class="stab-stat"><div class="sv">${s.pctAbove||'0'}%</div><div class="sk">Windows ≥ Target</div></div>
    <div class="stab-stat"><div class="sv">${s.cvPct||'?'}%</div><div class="sk">Coeff. of Variation</div></div>
    <div style="margin-left:auto">${badge}</div>
  </div>
</div>

<!-- ── Charts ─────────────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Performance Charts</div>
  <div class="chart-grid">
    <div class="chart-card full"><h3>Full-Year Equity Curve ($)</h3><canvas id="eq"></canvas></div>
    <div class="chart-card"><h3>Drawdown (%)</h3><canvas id="dd"></canvas></div>
    <div class="chart-card"><h3>Rolling 30-day Win Rate (%)</h3><canvas id="wr"></canvas></div>
    <div class="chart-card full"><h3>Agent Cumulative PnL by Window</h3><canvas id="agentPnl"></canvas></div>
    ${(roundLog||[]).length>1?`<div class="chart-card"><h3>Win Rate by Optimisation Round</h3><canvas id="rounds"></canvas></div>`:''}
  </div>
</div>

<!-- ── Per-Window Heatmap ──────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Agent Win-Rate Heatmap (per Window)</div>
  <div class="heatmap">${heatCells}</div>
</div>

<!-- ── Strategy Characterisation ──────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Strategy Characterisation</div>
  <div class="agent-grid">${agentCards}</div>
</div>

<!-- ── Regime Chart ────────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Agent Win Rate by Market Regime</div>
  <div class="chart-card full"><canvas id="regime" style="max-height:320px"></canvas></div>
</div>

<!-- ── Full Metrics ────────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Full Performance Metrics</div>
  <table class="metrics">
    <thead><tr><th>Metric</th><th>Value</th><th>Benchmark</th><th>Assessment</th></tr></thead>
    <tbody>
      ${this._metricRow('Win Rate',        m.winRate,      '≥70%',    parseFloat(m.winRate)>=70)}
      ${this._metricRow('Sharpe Ratio',    m.sharpe,       '≥1.0',    parseFloat(m.sharpe)>=1)}
      ${this._metricRow('Sortino Ratio',   m.sortino,      '≥1.5',    parseFloat(m.sortino)>=1.5)}
      ${this._metricRow('Calmar Ratio',    m.calmar,       '≥0.5',    parseFloat(m.calmar)>=0.5)}
      ${this._metricRow('CAGR',            m.cagr,         '≥20%',    parseFloat(m.cagr)>=20)}
      ${this._metricRow('Max Drawdown',    m.maxDrawdown,  '≤10%',    parseFloat(m.maxDrawdown)<=10)}
      ${this._metricRow('Profit Factor',   m.profitFactor, '≥1.5',    parseFloat(m.profitFactor)>=1.5)}
      ${this._metricRow('Expectancy',      '$'+m.expectancy,'≥$0.05', parseFloat(m.expectancy)>=0.05)}
      ${this._metricRow('Stability Mean',  (s.mean||0).toFixed(2)+'%','≥75%', (s.mean||0)>=75)}
      ${this._metricRow('Stability StdDev','±'+(s.std||0).toFixed(2)+'%','≤10%', (s.std||0)<=10)}
      ${this._metricRow('Windows ≥ Target',s.pctAbove+'%','≥65%',    parseFloat(s.pctAbove||0)>=65)}
    </tbody>
  </table>
</div>

<!-- ── Agent Breakdown ─────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Agent Breakdown (Full Year)</div>
  <table class="metrics">
    <thead><tr><th>Agent</th><th>Trades</th><th>Win Rate</th><th>Total PnL</th><th>Avg PnL/Trade</th><th>Status</th></tr></thead>
    <tbody>
      ${Object.entries(m.agentBreakdown||{}).map(([agent,s]) => `
        <tr>
          <td style="text-transform:capitalize;font-weight:600">${agent.replace('_',' ')}</td>
          <td>${s.trades}</td>
          <td class="${parseFloat(s.winRate)>=70?'pos':parseFloat(s.winRate)>=50?'warn':'neg'}">${s.winRate}</td>
          <td class="${parseFloat(s.totalPnl)>=0?'pos':'neg'}">$${s.totalPnl}</td>
          <td class="${parseFloat(s.avgPnl)>=0?'pos':'neg'}">$${s.avgPnl}</td>
          <td>${parseFloat(s.winRate)>=70?'★ Best performer':parseFloat(s.winRate)>=50?'Active':'⚠ Underperforming'}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</div>

</div><!-- /container -->

<script>
Chart.defaults.color='#6b7280';
Chart.defaults.borderColor='#252840';
const gc='rgba(37,40,64,0.5)';

// Equity
new Chart(document.getElementById('eq'),{type:'line',data:{labels:${eqLbl},datasets:[{label:'Equity ($)',data:${eqDat},borderColor:'#4f9cf9',backgroundColor:'rgba(79,156,249,0.08)',borderWidth:2,pointRadius:0,tension:.3,fill:true}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{maxTicksLimit:12}},y:{grid:{color:gc}}}}});

// Drawdown
new Chart(document.getElementById('dd'),{type:'line',data:{labels:${eqLbl},datasets:[{label:'Drawdown (%)',data:${ddDat},borderColor:'#ff5252',backgroundColor:'rgba(255,82,82,0.10)',borderWidth:1.5,pointRadius:0,tension:.2,fill:true}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{maxTicksLimit:8}},y:{grid:{color:gc}}}}});

// Rolling win rate
new Chart(document.getElementById('wr'),{type:'line',data:{labels:${wrLbl},datasets:[{label:'Win Rate %',data:${wrDat},borderColor:'#00d4a0',backgroundColor:'rgba(0,212,160,0.08)',borderWidth:2,pointRadius:3,tension:.3,fill:true},{label:'Target',data:${targetLine},borderColor:'#ffb347',borderWidth:1,borderDash:[5,5],pointRadius:0,fill:false}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{x:{grid:{color:gc}},y:{grid:{color:gc},min:0,max:100}}}});

// Agent PnL per window
new Chart(document.getElementById('agentPnl'),{type:'line',data:{labels:${wrLbl},datasets:[
  ${ALL_AGENTS.map(a => `{label:'${a.replace('_',' ')}',data:${JSON.stringify(agentWindowPnl[a])},borderColor:'${AGENT_COLORS[a]}',backgroundColor:'${AGENT_COLORS[a]}22',borderWidth:1.5,pointRadius:0,tension:.3,fill:false}`).join(',')}
]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{x:{grid:{color:gc}},y:{grid:{color:gc}}}}});

${(roundLog||[]).length>1?`
// Opt rounds
new Chart(document.getElementById('rounds'),{type:'bar',data:{labels:${roundLabels},datasets:[{label:'Mean Win Rate %',data:${roundWrs},backgroundColor:'rgba(79,156,249,0.6)',borderRadius:4}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{grid:{color:gc}},y:{grid:{color:gc},min:0,max:100}}}});
`:''}

// Regime chart
${regimeData}
</script>

</body></html>`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _card(label, value, cls) {
    return `<div class="stat ${cls}"><div class="lbl">${label}</div><div class="val">${value ?? '—'}</div></div>`;
  }

  _metricRow(label, value, bench, pass) {
    const cls = pass ? 'pos' : 'neg';
    return `<tr><td>${label}</td><td class="${cls}">${value ?? '—'}</td><td style="color:var(--muted)">${bench}</td><td class="${cls}">${pass ? '✓ Pass' : '✗ Fail'}</td></tr>`;
  }

  _heatmapHtml(windows, agents) {
    if (!windows.length) return '<p style="color:var(--muted)">No window data</p>';

    const maxCols = Math.min(windows.length, 52);
    const displayWindows = windows.slice(0, maxCols);

    const header = `<tr><th>Agent \\ Window</th>${displayWindows.map(w => `<th>${w.label}</th>`).join('')}</tr>`;
    const rows = agents.map(agent => {
      const cells = displayWindows.map(w => {
        const s = w.agentStats?.[agent];
        if (!s || s.trades < 1) return `<td class="hm-cell-none">—</td>`;
        const wr = Math.round(s.wins / Math.max(1, s.trades) * 100);
        const cls = wr >= 70 ? 'hm-cell-high' : wr >= 45 ? 'hm-cell-mid' : 'hm-cell-low';
        return `<td class="${cls}">${wr}%</td>`;
      }).join('');
      return `<tr><th style="text-align:left;text-transform:capitalize">${agent.replace('_', ' ')}</th>${cells}</tr>`;
    }).join('');

    return `<table class="hm-table"><thead>${header}</thead><tbody>${rows}</tbody></table>`;
  }

  _agentCards(windows, regimeMatrix) {
    const DESCS = {
      mispricing:   'Trades when estimated probability diverges from market price. Win rate scales directly with ev × confidence signal strength. Most active in moderately volatile markets with clear pricing inefficiencies.',
      news:         'Reacts to sentiment signals from news headlines. Triggers directional trades on positive/negative keywords. Performance depends on sentiment clarity — neutral news produces no signal.',
      market_maker: 'Captures bid-ask spread in liquid markets. Win rate improves in low-volatility, high-liquidity conditions. Degrades when spreads compress or volatility spikes.',
      arbitrage:    'Exploits price divergence between related markets in the same group (e.g. two macro outcomes). Generates the highest volume and most consistent win rate. Requires ≥12% inter-market divergence.',
      liquidity:    'Contrarian liquidity provision to illiquid markets (<$2k volume). Takes opposite position to crowd sentiment bias. Performs best when crowd is strongly one-sided.',
    };
    const ALL = ['mispricing', 'news', 'market_maker', 'arbitrage', 'liquidity'];
    const agentColour = { mispricing:'var(--primary)', news:'var(--success)', market_maker:'var(--warn)', arbitrage:'var(--purple)', liquidity:'var(--danger)' };

    return ALL.map(agent => {
      // Overall stats from windows
      let totalTrades = 0, totalWins = 0, totalPnl = 0, activeWindows = 0;
      for (const w of windows) {
        const s = w.agentStats?.[agent];
        if (s && s.trades > 0) { totalTrades += s.trades; totalWins += s.wins||0; totalPnl += s.pnl||0; activeWindows++; }
      }
      const wr        = totalTrades ? (totalWins / totalTrades * 100).toFixed(1) : '—';
      const activity  = windows.length ? (activeWindows / windows.length * 100).toFixed(0) : '0';
      const pnl       = totalPnl.toFixed(2);

      // Best regime
      const rm = regimeMatrix[agent] || {};
      const bestRegime = Object.entries(rm).sort((a, b) => b[1].winRate - a[1].winRate)[0];
      const bestRegimeStr = bestRegime ? `${bestRegime[0]} (${bestRegime[1].winRate}% wr)` : 'n/a';

      return `<div class="agent-card">
        <div class="name" style="color:${agentColour[agent]}">${agent.replace('_', ' ')}</div>
        <div class="desc">${DESCS[agent]}</div>
        <div class="kv"><span class="k">Win Rate</span><span class="v">${wr}%</span></div>
        <div class="kv"><span class="k">Total PnL</span><span class="v">$${pnl}</span></div>
        <div class="kv"><span class="k">Total Trades</span><span class="v">${totalTrades}</span></div>
        <div class="kv"><span class="k">Active Windows</span><span class="v">${activity}%</span></div>
        <div class="best-regime">Best regime: ${bestRegimeStr}</div>
      </div>`;
    }).join('');
  }

  _regimeChartData(regimeMatrix, agents) {
    const ALL_REGIMES = [...new Set(
      Object.values(regimeMatrix).flatMap(r => Object.keys(r))
    )].sort();
    if (!ALL_REGIMES.length) return '// no regime data';

    const COLORS = ['#4f9cf9','#00d4a0','#ffb347','#c879ff','#ff6b6b'];
    const datasets = agents.map((agent, i) => {
      const rm = regimeMatrix[agent] || {};
      const data = ALL_REGIMES.map(regime => rm[regime]?.winRate || 0);
      return `{label:'${agent.replace('_',' ')}',data:${JSON.stringify(data)},backgroundColor:'${COLORS[i]}aa',borderRadius:4}`;
    }).join(',');

    return `new Chart(document.getElementById('regime'),{type:'bar',data:{labels:${JSON.stringify(ALL_REGIMES)},datasets:[${datasets}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{x:{grid:{color:gc}},y:{grid:{color:gc},min:0,max:100,title:{display:true,text:'Win Rate (%)',color:'#6b7280'}}}}});`;
  }
}

// Template-level constants referenced in the JS blocks
const ALL_AGENTS  = ['mispricing','news','market_maker','arbitrage','liquidity'];
const AGENT_COLORS = { mispricing:'#4f9cf9', news:'#00d4a0', market_maker:'#ffb347', arbitrage:'#c879ff', liquidity:'#ff6b6b' };

module.exports = { AnnualReport };
