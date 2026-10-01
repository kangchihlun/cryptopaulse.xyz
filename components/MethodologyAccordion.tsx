import type { ReactNode } from "react";

/**
 * MethodologyAccordion — 每個面板下方的「資料來源 + 計算方式」折疊說明。
 *
 * 用原生 <details>/<summary>：不需要 client state、鍵盤/螢幕閱讀器原生支援、
 * 預設收合不佔版面。這是 server component（沒有 "use client"），內容全是靜態
 * 文字，跟面板本身的即時資料完全無關。
 *
 * 說明文字的常數（HEATMAP_METHODOLOGY / MOMENTUM_METHODOLOGY）就放在這裡，
 * 每一條都對照到實際程式碼的常數或算式——改動 lib/footprint.ts、
 * lib/indicators.ts、lib/binanceFeed.ts 的視窗/門檻時，這裡的數字要一起改，
 * 不然面板上寫的跟實際算的會對不上（這份說明是給評審/使用者看的，寫錯比
 * 沒寫更糟）。
 */

export interface MethodologySection {
  heading: string;
  items: ReactNode[];
}

interface MethodologyAccordionProps {
  title: string;
  sections: MethodologySection[];
}

export default function MethodologyAccordion({ title, sections }: MethodologyAccordionProps) {
  return (
    <details className="methodology group mt-2 rounded-lg border border-border bg-panel text-sm">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2 text-muted hover:text-[#e6e9ef]">
        <span className="chevron inline-block text-[10px] transition-transform">▶</span>
        <span className="font-semibold">{title}</span>
        <span className="text-xs">— data source &amp; how it is calculated</span>
      </summary>
      <div className="grid grid-cols-1 gap-4 border-t border-border px-4 py-3 md:grid-cols-2">
        {sections.map((s) => (
          <section key={s.heading}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{s.heading}</h3>
            <ul className="space-y-1.5 text-xs leading-relaxed">
              {s.items.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-[2px] shrink-0 text-muted">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}

/** 小字等寬標籤，用來標常數/欄位/端點名稱。 */
function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-bg px-1 py-[1px] font-mono text-[11px] text-bull/90">{children}</code>;
}

// ---------------------------------------------------------------------------
// 熱圖：對照 lib/footprint.ts、lib/footprintOverlay.ts、components/Heatmap.tsx、
// lib/perplOrderbook.ts、components/LiveHeatmapPanel.tsx
// ---------------------------------------------------------------------------
export const HEATMAP_METHODOLOGY: MethodologySection[] = [
  {
    heading: "Data source",
    items: [
      <>
        <b>Perpl orderbook snapshots.</b> A separate collector service (<C>perpl_snapshot_collector.py</C>) samples the
        Perpl BTC perpetual L2 book <b>once per second</b> and stores the top <b>3 price levels per side</b> as{" "}
        <C>[price, size]</C> pairs, plus the mid price. Rows land in the Postgres table <C>BookSnapshot</C>.
      </>,
      <>
        <b>Latency.</b> The collector flushes to Postgres in hourly batches, so the newest snapshot can lag the exchange by
        up to <b>60 minutes</b>. This chart is a microstructure replay, not a live tape.
      </>,
      <>
        <b>Serving.</b> The Node server preloads the last 30 minutes into memory at boot and back-fills 24 hours in the
        background; the page polls <C>/api/ticks</C> every 5 s from that cache, never hitting the database per request.
      </>,
      <>
        <b>Live ladder overlay (BTC only).</b> The server holds its own subscription to Perpl&apos;s market-data
        WebSocket (<C>order-book@1</C>) and re-broadcasts the top <b>20 levels per side</b> every 500 ms over{" "}
        <C>/ws/orderbook</C>. This is the only truly real-time layer on the chart.
      </>,
      <>
        <b>24h reference price.</b> The mid of the newest snapshot at or before 24 hours ago (<C>/api/price-ref</C>);
        the headline change is <C>(current mid − reference mid) / reference mid</C>.
      </>,
    ],
  },
  {
    heading: "How it is calculated",
    items: [
      <>
        <b>Axes.</b> X is absolute time aligned to <b>15-minute</b> bucket boundaries (data gaps stay blank). Y is
        <b> absolute price</b> on one shared scale: min/max of every mid and every quoted level in the window, padded 4%.
      </>,
      <>
        <b>Glow points.</b> Every quoted level in every 1-second snapshot is one point: bids in the bull colour, asks in
        the bear colour. Brightness = <C>log10(price × size + 1) / log10(max + 1) × 0.3</C>. Points are drawn with
        additive blending (WebGPU, canvas2D fallback), so overlapping resting liquidity sums into brighter bands.
      </>,
      <>
        <b>Candles.</b> Open/high/low/close of the Perpl mid price inside each 15-minute bucket.
      </>,
      <>
        <b>Footprint cells (<i>bid × ask</i>).</b> The price axis is cut into rows (~14 px each). For each bucket and
        row, the USD resting on bids and on asks is summed across all snapshots and <b>divided by the number of
        snapshots</b> in that bucket, giving the <b>average resting liquidity</b> at that price. Sides under $1 are
        hidden; numbers are omitted when the cell is too small to fit them.
      </>,
      <>
        <b>Δ book (bottom strip).</b> Per bucket: average resting bid USD − average resting ask USD. Positive means the
        book leans to the bid side. It is an <b>orderbook imbalance</b>, not a traded-volume delta.
      </>,
      <>
        <b>Ladder overlay.</b> Classic depth-chart shape: bids fill the left half, asks the right, best price toward the
        centre. Height is cumulative size from the best level outward, normalised by that side&apos;s total.
      </>,
      <>
        <b>Caveat.</b> The collector stores orderbook state only, <b>no individual trades</b>, so every number here is
        resting order pressure rather than executed volume. A NinjaTrader-style volume footprint would require changing
        the collector.
      </>,
    ],
  },
];

// ---------------------------------------------------------------------------
// 動量面板：對照 lib/binanceFeed.ts、lib/indicators.ts、lib/marketState.ts、
// components/MomentumPanel.tsx
// ---------------------------------------------------------------------------
export const MOMENTUM_METHODOLOGY: MethodologySection[] = [
  {
    heading: "Data source",
    items: [
      <>
        <b>Binance spot, not Perpl.</b> Each coin runs its own connection to Binance: one combined WebSocket with the{" "}
        <C>@trade</C> stream (aggressor side = the inverse of Binance&apos;s <C>isBuyerMaker</C> flag) and the{" "}
        <C>@kline_1m</C> stream, plus a REST poll of the top-20 <C>/depth</C> book every 2 s.
      </>,
      <>
        <b>Windows kept in memory.</b> Trades: last <b>600 s</b>. Candles: 200 one-minute klines bootstrapped at start,
        up to 500 retained (~8 h). Nothing from this panel is written to the database.
      </>,
      <>
        <b>Coins.</b> BTCUSDT, ETHUSDT, SOLUSDT, ZECUSDT. HYPE and MON have no Binance spot pair and are omitted.
      </>,
      <>
        <b>Delivery.</b> The server recomputes every indicator in-process and pushes a snapshot to the browser once per
        second over <C>/ws/momentum</C>. The sparkline is the bias score sampled every 5 s over the last hour.
      </>,
      <>
        <b>Readiness.</b> A card shows values only after at least 26 one-minute candles exist (the MACD slow period).
      </>,
    ],
  },
  {
    heading: "How it is calculated",
    items: [
      <>
        <b>Active Buy/Sell 5m.</b> Σ <C>price × qty</C> of trades in the last 300 s, split by aggressor side, with trade
        counts. CVD 5m = buy USD − sell USD.
      </>,
      <>
        <b>EMA(5/20).</b> Exponential moving averages of 1-minute closes; &quot;Bullish cross&quot; when EMA5 &gt; EMA20.
      </>,
      <>
        <b>OBI.</b> <C>(bid qty − ask qty) / (bid qty + ask qty)</C> using only levels within ±0.5% of mid. Coloured
        beyond ±0.05.
      </>,
      <>
        <b>MACD Hist.</b> EMA12 − EMA26 of closes, signal = EMA9 of that line, histogram = MACD − signal.
      </>,
      <>
        <b>RSI(14).</b> Wilder-smoothed RSI on 1-minute closes; ≥70 flagged overbought (bearish), ≤30 oversold (bullish).
      </>,
      <>
        <b>vs VWAP.</b> Σ(typical price × volume) / Σ volume across the retained candles, compared with the current mid.
      </>,
      <>
        <b>vs POC.</b> Volume profile over the retained candles in 24 price bins (each candle&apos;s volume spread evenly
        across the bins its high–low range covers); POC is the centre of the densest bin.
      </>,
      <>
        <b>Walls.</b> Count of levels per side whose size is ≥ 3× the average size across all 40 polled levels.
      </>,
      <>
        <b>Heikin-Ashi streak.</b> Number of consecutive same-colour Heikin-Ashi candles among the last three (+ green, −
        red).
      </>,
      <>
        <b>Bias Score (−100…+100).</b> Nine components, equal weight 1: EMA cross ±1, raw OBI, MACD histogram sign ±1,
        CVD sign ±1, HA streak / 3 (clamped ±1), above/below VWAP ±1, RSI (+1 at ≤30, −1 at ≥70, linear{" "}
        <C>(50 − RSI) / 20</C> in between), above/below POC ±1, walls <C>(min(bid,2) − min(ask,2)) × 2</C> clamped ±1.
        Score = sum / 9 × 100. BULLISH above +10, BEARISH below −10.
      </>,
      <>
        <b>Vote trend.</b> Integer votes: OBI ±1 beyond ±0.2, CVD sign, RSI (−1 &gt;70, +1 &lt;30), MACD sign, VWAP
        side, EMA cross, up to ±2 per side for walls, ±1 when the last three HA candles agree. |score| ≥ 3 sets the label.
      </>,
    ],
  },
];
