# CryptoPulse Monitor

A real-time market monitor built with Next.js (App Router + TypeScript + Tailwind). It reads
Perpl orderbook snapshots that a separate collector service (`perpl_snapshot_collector.py`,
deployed as its own Railway service via `Dockerfile.snapshot`) writes to Postgres. The app
draws them as a gradient heatmap next to a multi-coin momentum comparison. Detailed
requirements are in [`SPEC.md`](./SPEC.md).

## Running

```bash
npm install
npm run dev   # http://localhost:3000 — custom Node.js server (server.ts), not `next dev`
```

**This project cannot be run with `next dev` / `next start`.** `npm run dev` / `npm run start`
actually run `tsx server.ts` (see "Real-time push" below). That is a custom Node.js server: after
`app.prepare()` sets up Next.js, one `http.Server` serves three things together: the Next.js
request handler, the HMR WebSocket, and our own `/ws/momentum` WebSocket server. This means:

- It must run as a long-lived Node.js process (Railway or self-hosted both work). **It cannot be
  deployed to Vercel serverless**, because a custom server can't run inside serverless functions.
- `npm run build` is still plain `next build` and has nothing to do with the custom server.
  `server.ts` is executed directly by `tsx` and never goes through Next's webpack/turbopack
  bundling.
- Running `npm run dev` after `next build` leaves dev-mode output in `.next`. After that,
  `npm run start` fails with "Could not find a production build". Run `rm -rf .next` and then
  `npm run build` again before using `npm run start`.

## Environment variables (`.env` / `.env.local`)

```
POSTGRES_URL="postgresql://..."   # Postgres database shared with the collector
TABLE_NAME="BookSnapshot"         # Table the collector writes to (see "Data sources" below)
```

`.env` files are gitignored. Create your own with your connection string.

## Deploying to Railway

- **Root Directory**: leave empty (the repo root is the service).
- **Dockerfile Path**: set to `dockerfile_web`. The build has two stages:
  1. Install all dependencies, including devDependencies, and run `next build`.
  2. Install only production dependencies, then copy in the compiled `.next` output plus
     `server.ts` and the `lib/` source it imports. The custom server is transpiled at runtime
     by `tsx` rather than started with `next start`, so the runtime image needs the source
     files as well as the build output.
- **Variables**: set `POSTGRES_URL` and `TABLE_NAME` in Railway's Variables tab, with the same
  values as your `.env`. `.dockerignore` excludes `.env`, so the file never reaches the Docker
  image and Railway can't read it. You don't need to set `PORT` or `NODE_ENV`: Railway injects
  `PORT`, and `dockerfile_web` already sets `ENV NODE_ENV=production`.
- When the container receives SIGTERM (a Railway redeploy or service stop), `server.ts` shuts
  down cleanly within about 1.5 seconds. The `CMD` in `dockerfile_web` execs `tsx` directly
  rather than `npm run start`, because npm doesn't forward signals reliably.

## Data sources: two fully independent pipelines

The site uses two data sources. **Each feeds a different part of the page, and neither depends
on the other.**

### 1. Orderbook heatmap (Perpl, read from Postgres)

The collector (`perpl_snapshot_collector.py` + `libs/feeds.py`) keeps batch-writing Perpl
orderbook snapshots into the Postgres table `"BookSnapshot"`. The name is mixed-case, so SQL
must double-quote it. Each row has `kind='signal_snapshot'`, `ts` (ms) and `raw` (JSONB).
`lib/db.ts` holds the low-level Postgres queries (`fetchTicks` / `fetchCoinSummaries` /
`fetchPriceNear`).

`app/page.tsx`, `/api/ticks` and `/api/coins` **don't query Postgres directly**. They read an
in-memory cache in `lib/bookCache.ts`. `server.ts` preloads that cache in two phases, after
`app.prepare()` and before `server.listen()`:

1. **Blocking phase**: load each coin's last 30 minutes of history into memory. `server.listen()`
   waits for this step. 30 minutes covers the heatmap's default and most-used window. Loading a
   full day up front (roughly 60–90k rows for BTC alone) would slow startup from about 1.5
   seconds to several seconds.
2. **Background phase**: once `start()` returns and the server is already serving, backfill each
   coin to the full 24-hour retention window (24h is the heatmap's longest window option). This
   doesn't block any request. Until it finishes, the 2h/12h/24h windows show less data. The
   next frontend poll after the backfill picks up the full history automatically.

After that, the cache refreshes in the background every minute and fetches only new rows. If a
refresh fails, the old cache stays in place, so data never vanishes from the screen. Two
benefits:

- Many open browser tabs still cost only one DB query.
- The server has data before it starts serving, so the heatmap is never empty right after
  startup.

`/api/price-ref` (the reference price for the 24h change) still queries the DB directly. It is
called rarely, so caching it wasn't worth the extra complexity.

The `raw` fields that `components/Heatmap.tsx` consumes:

| Field | Description |
|---|---|
| `ts` | epoch seconds |
| `coin` | coin symbol |
| `depth` | number of levels sampled in this snapshot (currently 3) |
| `bid_usd` / `ask_usd` | summed USD depth of the top `depth` levels |
| `bid1_usd` / `ask1_usd` | USD depth at the top of book (level 1) |
| `bids_detail` / `asks_detail` | per-level `[price, size]`, from top of book outward |
| `ask_over_bid` / `bid_over_ask` | depth ratios |
| `momentum_bias` | composite momentum score (-100 to +100) computed by the collector. The dashboard doesn't use it; it appears only as a reference column in the `/coin/[symbol]` detail table. |
| `perpl_mid` / `binance_mid` / `basis_bps` | mid prices on both venues and the basis between them (bps) |

**Known gap**: the SPEC wants the heatmap's Y axis to cover 25 levels on each side, but the
collector currently samples only `depth=3`. `Heatmap.tsx` buckets by continuous bps offsets
rather than discrete level indices, so the frontend won't need changes when richer data arrives.
Getting 25-level resolution means raising `PERPL_SNAPSHOT_DEPTH` on the collector and
redeploying it.

### 2. Momentum comparison panel (Binance, live stream, no DB)

`components/MomentumPanel.tsx` **never reads Postgres**. It runs a direct TypeScript port of the
collector's `libs/feeds.py` + `libs/indicators.py`:

- `lib/binanceFeed.ts` opens one Binance WebSocket per coin, combining the `<symbol>@trade` and
  `<symbol>@kline_1m` streams. For every trade it stores `isBuy` (`!isBuyerMaker`, meaning the
  buyer was the aggressor). It also polls the REST spot order book as a fallback. Like the
  Python version, it reconnects in place 5 seconds after a disconnect.
- `lib/indicators.ts` ports `obi/walls/cvd/rsi/macd/vwap/emas/heikinAshi/volProfile/biasScore/scoreTrend`
  function by function, with the same constants as the Python config. The collector stores only
  one folded `momentum_bias` score. This port instead **returns every indicator separately**
  (`computeBreakdown()`), and MomentumPanel shows each one. It also exposes raw aggressive
  buy/sell USD volume and trade counts (`activeBuySell5m`) rather than only the sign of the CVD.
- `lib/marketState.ts` is an in-process singleton. It holds the runtime state for every coin and
  samples bias history every 5 seconds for the sparklines. `server.ts` calls `start()` once
  after `app.prepare()` finishes. `/api/momentum` also calls it as a safeguard, and a `started`
  flag prevents duplicate connections. The singleton is attached to `globalThis` so that Next.js
  dev-mode hot reloads don't leave orphaned WebSocket connections behind.

### Real-time push: `/ws/momentum`

`server.ts` runs a WebSocket server on the path `/ws/momentum`. Every second it broadcasts the
latest `marketState.getAll()` snapshot to all connected browsers. The frontend connects when the
page opens and receives updates passively, with no polling of its own. Each new connection gets
the current snapshot right away instead of waiting for the next broadcast. After a disconnect,
the frontend reconnects automatically 3 seconds later.

The `/api/momentum` REST route remains for manual debugging (`curl` it to inspect the payload).
The panel itself no longer calls it.

The heatmap and coin-detail pages still use REST polling for Postgres data. The collector writes
in batches, so that data can arrive up to 60 minutes late, and pushing it over WebSocket would
gain nothing. Only the momentum panel moved to push, because its Binance source updates every
second.

**Coin coverage**: the collector itself only subscribes to BTC on Binance. For the multi-coin
comparison, this app also subscribes to the other five Perpl markets using the same naming
convention. **In testing, Binance spot returns `Invalid symbol.` for HYPEUSDT and MONUSDT**
because HYPE and MON have no Binance spot market to compare against. BTC, ETH, SOL and ZEC all
work. The panel shows HYPE and MON as "no data" instead of crashing the process or showing
made-up numbers.

### Orderbook ladder: `/ws/orderbook` (live Perpl BTC order book overlay)

`components/Heatmap.tsx` overlays a step-line ladder of the top 20 levels of the Perpl BTC order
book, drawn as a classic depth chart:

- **X axis = price.** Bids take the left half of the canvas, with the best bid at `centerX` and
  the 20th level at `x-min`. Asks take the right half, with the best ask at `centerX` and the
  20th level at `x-max`.
- **Y axis = cumulative depth.** The baseline (zero cumulative size, best price) is at the
  bottom (`y-max`), and depth grows toward the top (`y-min`). The chart is low in the middle and
  high at the sides.
- Each side is scaled to full width and height by its own price range and total size. The two
  sides don't share a scale, so a thinner side never shrinks into a corner.

**The browser can't subscribe directly.** Perpl's market-data WebSocket
(`wss://app.perpl.xyz/ws/v1/market-data`) checks the `Origin` header and rejects connections
from origins other than `app.perpl.xyz`. A connection with a foreign Origin gets a 403; it works
only with no Origin or with `app.perpl.xyz`'s own. A browser always sends the page's real Origin
on WebSocket connections, and page JavaScript can't change or omit it. So this follows the same
pattern as the Binance feed:

- `lib/perplOrderbook.ts` subscribes on the backend. Node.js WebSocket clients don't send an
  Origin header by default.
- `server.ts` relays the book to the frontend over `/ws/orderbook` every 500 ms.

Only BTC is supported for now. The market settings (`market_id=1`, `price_decimals=1`,
`size_decimals=5`) come from `GET /v1/pub/context` and are hardcoded, since they rarely change.

The ladder is drawn on a **separate transparent overlay canvas** (`ladderCanvasRef`) on top of
the heatmap. This way it shows up whether the heatmap is rendered with WebGPU (`renderGpu`, the
main path in modern browsers) or the canvas2D fallback. WebGPU has no built-in 2D
`strokeStyle`/`lineTo`/`fill` API. Building line geometry inside the render pipeline would be
complex and hard to verify without a browser, while a transparent canvas2D overlay is a common,
much lower-risk approach. It also means ladder redraws, which follow the 500 ms `/ws/orderbook`
push, never wait on the heavier heatmap recomputation, and vice versa.

## Pages

- `/`: dashboard with the Perpl heatmap, switchable by coin and time window (from the DB), plus
  the all-coin momentum comparison panel (live Binance WebSocket, no DB).
- `/coin/[symbol]`: per-coin depth analysis with a larger heatmap, the collector's bias/basis
  trends and a table of the latest 20 rows (from the DB).

## API

- `GET /api/ticks?coin=BTC&minutes=30&limit=20000`: Perpl orderbook snapshots, oldest to newest
  (from the DB).
- `GET /api/coins?minutes=60`: latest Perpl snapshot per coin and the row count over the past N
  minutes (from the DB).
- `GET /api/price-ref?coin=BTC&hoursAgo=24`: the reference price closest to (and before) a point
  in time, used for percentage change.
- `GET /api/momentum`: live per-indicator breakdown for all coins, read from process memory with
  no DB query. Meant for manual debugging; `MomentumPanel.tsx` uses `/ws/momentum` instead.
- `WS /ws/momentum`: broadcasts the per-indicator breakdown for all coins every second. This is
  the actual data source for `MomentumPanel.tsx`.
- `WS /ws/orderbook`: broadcasts the top 20 bid/ask levels of the Perpl BTC order book every
  500 ms. `Heatmap.tsx` uses it for the orderbook ladder overlay.
