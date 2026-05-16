---
name: Polymarket Multi-Agent Trader Architecture
description: Architecture snapshot of the polymarket trading system after adding real adapters, persistent position book, Prometheus metrics, and backtest replay engine
type: project
---

Multi-agent Polymarket trading system (Node.js, CommonJS, zero-native-deps).

**Core agents (5):** mispricing, news, marketMaker, arbitrage, liquidity — all in agents/

**New additions (May 2026):**
- `adapters/polymarketRest.js` — Real Polymarket CLOB + Gamma REST client with HMAC L2 auth and rate limiting
- `adapters/polymarketWs.js` — WebSocket price feed adapter with auto-reconnect (requires ws package)
- `db/positionBook.js` — File-backed persistent position store (JSON + atomic rename writes), full open/partially_closed/closed lifecycle
- `db/orderStore.js` — File-backed order store with full state machine: PENDING→SUBMITTED→OPEN→PARTIALLY_FILLED→FILLED/CANCELLED/REJECTED/EXPIRED
- `metrics/prometheus.js` — prom-client metrics + HTTP server on :9091/metrics (counters, gauges, histograms for trades, equity, drawdown, agent stats, cycle duration)
- `backtest/historicalLoader.js` — Loads price history from Polymarket API or generates GBM synthetic data
- `backtest/replayEngine.js` — Event-driven replay engine stepping through historical price timelines
- `backtest/performanceAnalyzer.js` — Sharpe, Sortino, Calmar, CAGR, max drawdown, win rate, profit factor
- `backtest/reportGenerator.js` — Self-contained dark-theme HTML report with Chart.js charts
- `docker/` — docker-compose with Prometheus (:9090) + Grafana (:3000) + Alertmanager (:9093), alerting rules, Grafana auto-provisioned dashboard

**Dependencies added:** dotenv, prom-client, ws (6 packages total, no native builds)

**CLI flags:** --mode=paper|live|backtest, --adapter=real|mock, --metrics, --metrics-port=9091

**Key integration points:**
- ExecutionEngine(config, marketApi, positionBook, orderStore) — positionBook/orderStore optional
- Coordinator accepts metrics and positionBook — null-safe, emits metrics.recordTrade/updatePortfolio/etc.
- index.js: runBacktest() for historical replay, generateReport() for paper/live HTML output

**Why:** Production readiness — real exchange connectivity, durability across restarts, observability, and rigorous strategy validation.
**How to apply:** When adding agents or modifying execution flow, check that new code calls metrics.recordTrade() and updates positionBook appropriately.
