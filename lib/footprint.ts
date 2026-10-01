/**
 * lib/footprint.ts — 把 BookSnapshot 的逐秒快照聚合成「K 棒 + 掛單流 footprint」模型，
 * 給 components/Heatmap.tsx 疊在熱圖上畫。
 *
 * ⚠️ 資料來源的先天限制（重要，不要誤讀圖）：
 *   perpl_snapshot_collector.py 收的是**訂單簿快照**（每秒取樣、每邊 3 檔），
 *   **沒有逐筆成交**。所以這裡的格子數字不是 NinjaTrader footprint 那種
 *   「該價位的主動買/賣成交量」，而是「該 15 分鐘內、該價位上掛單簿停駐的
 *   平均美金量」（bid 掛單 vs ask 掛單）。語意是**掛單壓力**而不是成交量，
 *   delta 也因此是「掛單簿失衡」而不是「主動買賣淨額」。真要做成交量 footprint
 *   必須先改 collector 落地逐筆成交，是資料管線變更、不是前端能解決的。
 *
 * K 棒本身（OHLC）則是真的：用 bucket 內 perpl_mid 的 first/max/min/last。
 *
 * Y 軸從「相對各自 mid 的 bps」改成**絕對價格**：舊畫法每根 tick 都以自己的 mid
 * 重新置中，價格走勢在圖上完全看不到，也就沒辦法把 K 棒疊上同一個座標系。改成
 * 全視窗共用一把價格尺之後，熱圖散點會沿著價格走成一條流動的流動性帶
 * （Bookmap 的經典樣子），K 棒/footprint 才有辦法跟它對齊。
 */
import type { SnapshotTick } from "./db";

/** 一個價格列（row）在某根 K 棒裡的掛單停駐量，單位美金（已除以樣本數＝平均值）。 */
export interface FootprintRow {
  bidUsd: number;
  askUsd: number;
}

export interface FootprintBucket {
  startMs: number;
  endMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  samples: number; // 這根棒子裡有幾筆快照（資料有缺口時各棒不一樣，所以要用平均而非總和）
  rows: Map<number, FootprintRow>; // key = 價格列索引（見 FootprintModel.rowHeight）
  bidUsd: number; // 整根棒子的平均 bid 掛單量（各列加總）
  askUsd: number;
  delta: number; // bidUsd - askUsd，正=掛單簿偏買方
  cumDelta: number; // 從最左邊那根累積到這根
}

export interface FootprintModel {
  buckets: FootprintBucket[];
  priceMin: number;
  priceMax: number;
  rowHeight: number; // 每一價格列涵蓋多少美金
  rowCount: number;
  tStartMs: number; // 對齊到 bucket 邊界（整點 / 整 15 分）的時間軸左端
  tEndMs: number;
  maxRowUsd: number; // 所有棒子所有列裡單邊最大值，給亮度正規化用
  lastPrice: number | null;
}

const EMPTY: FootprintModel = {
  buckets: [],
  priceMin: 0,
  priceMax: 1,
  rowHeight: 1,
  rowCount: 1,
  tStartMs: 0,
  tEndMs: 1,
  maxRowUsd: 1,
  lastPrice: null,
};

/**
 * @param ticks     由舊到新排序的逐筆快照（/api/ticks 就是這個順序）
 * @param bucketMs  一根 K 棒的長度（預設呼叫端給 15 分鐘）
 * @param rowCount  價格軸切幾列——呼叫端依畫布高度決定，讓每列有足夠像素放數字
 */
export function buildFootprint(ticks: SnapshotTick[], bucketMs: number, rowCount: number): FootprintModel {
  if (ticks.length === 0) return EMPTY;

  // ---- 第一輪：價格軸範圍。除了 mid 也要涵蓋掛單價位，不然最外檔會被切掉。----
  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const t of ticks) {
    if (!t.perpl_mid) continue;
    if (t.perpl_mid < priceMin) priceMin = t.perpl_mid;
    if (t.perpl_mid > priceMax) priceMax = t.perpl_mid;
    for (const [price] of t.bids_detail) {
      if (price < priceMin) priceMin = price;
      if (price > priceMax) priceMax = price;
    }
    for (const [price] of t.asks_detail) {
      if (price < priceMin) priceMin = price;
      if (price > priceMax) priceMax = price;
    }
  }
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return EMPTY;
  // 價格完全沒動（或只有一筆）時給一個最小可視範圍，避免除以 0。
  if (priceMax - priceMin < 1e-9) {
    const pad = Math.max(priceMax * 1e-4, 1e-6);
    priceMin -= pad;
    priceMax += pad;
  } else {
    const pad = (priceMax - priceMin) * 0.04; // 上下各留 4% 邊界，點的 glow 才不會貼齊邊緣被切
    priceMin -= pad;
    priceMax += pad;
  }

  const rows = Math.max(4, Math.floor(rowCount));
  const rowHeight = (priceMax - priceMin) / rows;
  const rowOf = (price: number) =>
    Math.max(0, Math.min(rows - 1, Math.floor((price - priceMin) / rowHeight)));

  // ---- 時間軸：對齊到整 bucket 邊界，各欄寬度才會一致（資料有缺口也不會歪掉）----
  const firstMs = ticks[0].ts * 1000;
  const lastMs = ticks[ticks.length - 1].ts * 1000;
  const tStartMs = Math.floor(firstMs / bucketMs) * bucketMs;
  const tEndMs = Math.max(tStartMs + bucketMs, Math.ceil(lastMs / bucketMs) * bucketMs);

  // ---- 第二輪：分桶聚合 ----
  const byBucket = new Map<number, FootprintBucket>();
  for (const t of ticks) {
    if (!t.perpl_mid) continue;
    const key = Math.floor((t.ts * 1000) / bucketMs);
    let b = byBucket.get(key);
    if (!b) {
      b = {
        startMs: key * bucketMs,
        endMs: (key + 1) * bucketMs,
        open: t.perpl_mid,
        high: t.perpl_mid,
        low: t.perpl_mid,
        close: t.perpl_mid,
        samples: 0,
        rows: new Map(),
        bidUsd: 0,
        askUsd: 0,
        delta: 0,
        cumDelta: 0,
      };
      byBucket.set(key, b);
    }
    b.samples += 1;
    b.close = t.perpl_mid; // ticks 由舊到新，最後寫進來的就是收盤
    if (t.perpl_mid > b.high) b.high = t.perpl_mid;
    if (t.perpl_mid < b.low) b.low = t.perpl_mid;

    const add = (price: number, size: number, side: "bid" | "ask") => {
      const r = rowOf(price);
      let cell = b!.rows.get(r);
      if (!cell) {
        cell = { bidUsd: 0, askUsd: 0 };
        b!.rows.set(r, cell);
      }
      const usd = price * size;
      if (side === "bid") cell.bidUsd += usd;
      else cell.askUsd += usd;
    };
    for (const [price, size] of t.bids_detail) add(price, size, "bid");
    for (const [price, size] of t.asks_detail) add(price, size, "ask");
  }

  // ---- 收尾：把累加值換成「平均每筆快照的掛單量」----
  // 各棒的樣本數不一定相同（collector 偶爾漏取樣、最新那根還沒走完），直接比
  // 加總會讓樣本多的棒子看起來比較大，除以樣本數才是可比的「停駐量」。
  const buckets = [...byBucket.values()].sort((a, b) => a.startMs - b.startMs);
  let maxRowUsd = 1;
  let cum = 0;
  for (const b of buckets) {
    const n = Math.max(1, b.samples);
    for (const cell of b.rows.values()) {
      cell.bidUsd /= n;
      cell.askUsd /= n;
      b.bidUsd += cell.bidUsd;
      b.askUsd += cell.askUsd;
      if (cell.bidUsd > maxRowUsd) maxRowUsd = cell.bidUsd;
      if (cell.askUsd > maxRowUsd) maxRowUsd = cell.askUsd;
    }
    b.delta = b.bidUsd - b.askUsd;
    cum += b.delta;
    b.cumDelta = cum;
  }

  return {
    buckets,
    priceMin,
    priceMax,
    rowHeight,
    rowCount: rows,
    tStartMs,
    tEndMs,
    maxRowUsd,
    lastPrice: ticks[ticks.length - 1]?.perpl_mid ?? null,
  };
}

/** 12345 → "12.3k"、1234567 → "1.2M"，給格子裡的小字用（寬度有限）。 */
export function compactUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (a >= 10) return v.toFixed(0);
  return v.toFixed(1);
}

// ---------------------------------------------------------------------------
// 座標換算——抽在這裡（純函式、不碰 DOM）是為了能用真實資料在 node 裡直接驗證
// 版面數字，components/Heatmap.tsx 的疊圖跟熱圖本體都從這裡取同一套算式。
// ---------------------------------------------------------------------------

/** 一根 K 棒在畫布上的水平版面（單位：實體畫素）。 */
export interface ColumnBox {
  x0: number; // bucket 時間區間的左界
  x1: number;
  colW: number;
  candleCx: number; // OHLC K 棒的中心線
  candleW: number;
  cellX0: number; // footprint 格子區
  cellX1: number;
  cellW: number;
  cellCx: number; // 格子區中線＝bid/ask 的分界
}

/**
 * 每根 K 棒的版面（單位：實體畫素）：
 *
 *   │ ←colW（一個 bucket 的時間寬度）───────────────→ │
 *   │  ▌ candle  │  footprint 格子（bid × ask）       │
 *
 * 左邊細長的是 OHLC K 棒（影線 + 實體），右邊是同一根棒子的掛單流格子——
 * 這是 NinjaTrader footprint bar 的經典排法：K 棒不蓋在數字上面，兩者共用
 * 同一條價格軸、橫向錯開。
 */
export function columnBox(x0: number, x1: number, dpr: number): ColumnBox {
  const colW = x1 - x0;
  const inner = colW * 0.88;
  const left = x0 + colW * 0.06;
  const candleW = Math.min(9 * dpr, inner * 0.2);
  const cellX0 = left + candleW + 4 * dpr;
  const cellX1 = left + inner;
  return {
    x0,
    x1,
    colW,
    candleCx: left + candleW / 2,
    candleW,
    cellX0,
    cellX1,
    cellW: cellX1 - cellX0,
    cellCx: (cellX0 + cellX1) / 2,
  };
}

/** X（時間）→ 畫素、Y（絕對價格）→ 畫素，兩條軸都只涵蓋繪圖區。 */
export function makeScales(model: FootprintModel, plotW: number, plotH: number) {
  const tSpan = model.tEndMs - model.tStartMs || 1;
  const pSpan = model.priceMax - model.priceMin || 1;
  return {
    xOfMs: (ms: number) => ((ms - model.tStartMs) / tSpan) * plotW,
    yOfPrice: (p: number) => (1 - (p - model.priceMin) / pSpan) * plotH,
  };
}
