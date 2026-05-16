# Polymarket Multi-Agent Autonomous Trading System

Production-oriented Node.js architecture with independent strategy agents, centralized coordinator, EV-based filtering, risk controls, and dual execution modes (paper/live).

## Features

- Independent agents:
  - `mispricing`
  - `news`
  - `market_maker`
  - `arbitrage`
  - `liquidity`
- Coordinator for:
  - trade conflict resolution
  - dynamic Kelly-based capital allocation
  - portfolio risk constraints
- Shared data bus for cross-agent signal/outcome sharing
- Execution engine with `paper`, `live`, and `backtest` modes
- Learning engine for adaptive per-agent allocation
- Dashboard output and JSONL trade logs

## Project Structure

```
agents/
core/
shared/
config/config.json
logs/
dashboard/
index.js
```

## Run

```bash
npm start
```

### Paper mode

```bash
npm run paper
```

### Live mode

```bash
set POLYMARKET_API_KEY=your_key_here
set CLAUDE_API_KEY=your_key_here
npm run live
```

### Backtest mode

```bash
npm run backtest
```

## Configuration

Edit `config/config.json`:

- `mode`: `paper | live | backtest`
- `ev_threshold`
- `confidence_threshold`
- `fractional_kelly`
- drawdown/exposure/concurrency limits
- initial agent allocations

## Safety Rules Enforced

- Stops trading at max drawdown
- Caps exposure per market
- Caps concurrent trades
- Applies cooldowns after losses
- Avoids blind LLM dependency through deterministic fallback when AI key is missing

## Outputs

- Trades: `logs/trades-<timestamp>.jsonl`
- Dashboard: `dashboard/dashboard.json`

Includes:
- total PnL
- agent-wise PnL
- win rate
- max drawdown
- open positions count
- agent leaderboard
# poly-bot
