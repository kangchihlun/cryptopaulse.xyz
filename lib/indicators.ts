/**
 * lib/indicators.ts — collector 端 Python 指標模組（indicators.py）的
 * TypeScript 移植，逐函式對照，常數也照抄原本的設定。
 *
 * 跟原本 Postgres 版最大的差別：原本只存折算後的單一 momentum_bias，這裡把
 * obi/cvd/macd/rsi/vwap/poc/walls/ema 等每個分量都個別算出、個別回傳
 * （見 computeBreakdown()），給 MomentumPanel 分開顯示，而不是只看一個總分。
 */
import type { BinanceState, Kline, Trade } from "./binanceFeed";

const OBI_BAND_PCT = 0.5;
const OBI_THRESH = 0.2;
const WALL_MULT = 3;
const RSI_PERIOD = 14;
const RSI_OB = 70;
const RSI_OS = 30;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIG = 9;
const EMA_S = 5;
const EMA_L = 20;
const VP_BINS = 24;
const TREND_THRESH = 3;

const BIAS_WEIGHTS = {
  ema: 1.0,
  obi: 1.0,
  macd: 1.0,
  cvd: 1.0,
  ha: 1.0,
  vwap: 1.0,
  rsi: 1.0,
  poc: 1.0,
  walls: 1.0,
};

type Level = [number, number]; // [price, size]

export function obi(bids: Level[], asks: Level[], mid: number): number {
  const band = (mid * OBI_BAND_PCT) / 100;
  const bv = bids.filter(([p]) => p >= mid - band).reduce((s, [, q]) => s + q, 0);
  const av = asks.filter(([p]) => p <= mid + band).reduce((s, [, q]) => s + q, 0);
  const tot = bv + av;
  return tot ? (bv - av) / tot : 0;
}

export function walls(bids: Level[], asks: Level[]): { bidWalls: Level[]; askWalls: Level[] } {
  const vols = [...bids.map(([, q]) => q), ...asks.map(([, q]) => q)];
  if (!vols.length) return { bidWalls: [], askWalls: [] };
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const thr = avg * WALL_MULT;
  return {
    bidWalls: bids.filter(([, q]) => q >= thr),
    askWalls: asks.filter(([, q]) => q >= thr),
  };
}

/** 累計成交量淨額（USD，主動買為正、主動賣為負），窗口 `secs` 秒。 */
export function cvd(trades: Trade[], secs: number): number {
  const cut = Date.now() / 1000 - secs;
  return trades
    .filter((t) => t.t >= cut)
    .reduce((s, t) => s + t.qty * t.price * (t.isBuy ? 1 : -1), 0);
}

/** 幣安主動買賣量拆開回傳（USD + 筆數），不只是折算後的正負號——直接呈現原始資料。 */
export function activeBuySell(trades: Trade[], secs: number) {
  const cut = Date.now() / 1000 - secs;
  let buyUsd = 0;
  let sellUsd = 0;
  let buyCount = 0;
  let sellCount = 0;
  for (const t of trades) {
    if (t.t < cut) continue;
    const usd = t.qty * t.price;
    if (t.isBuy) {
      buyUsd += usd;
      buyCount += 1;
    } else {
      sellUsd += usd;
      sellCount += 1;
    }
  }
  return { buyUsd, sellUsd, netUsd: buyUsd - sellUsd, buyCount, sellCount };
}

function emaSeries(vals: number[], period: number): (number | null)[] {
  if (vals.length < period) return vals.map(() => null);
  const mult = 2 / (period + 1);
  const out: (number | null)[] = new Array(period - 1).fill(null);
  out.push(vals.slice(0, period).reduce((a, b) => a + b, 0) / period);
  for (let i = period; i < vals.length; i++) {
    const prev = out[out.length - 1] as number;
    out.push(vals[i] * mult + prev * (1 - mult));
  }
  return out;
}

export function rsi(klines: Kline[]): number | null {
  const closes = klines.map((k) => k.c);
  const n = RSI_PERIOD;
  if (closes.length < n + 1) return null;
  const ch = closes.slice(1).map((c, i) => c - closes[i]);
  let ag = ch.slice(0, n).reduce((s, c) => s + Math.max(c, 0), 0) / n;
  let al = ch.slice(0, n).reduce((s, c) => s + Math.max(-c, 0), 0) / n;
  for (const c of ch.slice(n)) {
    ag = (ag * (n - 1) + Math.max(c, 0)) / n;
    al = (al * (n - 1) + Math.max(-c, 0)) / n;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

export function macd(klines: Kline[]): { macd: number | null; signal: number | null; hist: number | null } {
  const closes = klines.map((k) => k.c);
  if (closes.length < MACD_SLOW) return { macd: null, signal: null, hist: null };
  const ef = emaSeries(closes, MACD_FAST);
  const es = emaSeries(closes, MACD_SLOW);
  const ml: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (ef[i] != null && es[i] != null) ml.push((ef[i] as number) - (es[i] as number));
  }
  if (!ml.length) return { macd: null, signal: null, hist: null };
  const sig = emaSeries(ml, MACD_SIG);
  const m = ml[ml.length - 1];
  const s = sig[sig.length - 1];
  const h = s != null ? m - s : null;
  return { macd: m, signal: s, hist: h };
}

export function vwap(klines: Kline[]): number {
  let tpv = 0;
  let v = 0;
  for (const k of klines) {
    tpv += ((k.h + k.l + k.c) / 3) * k.v;
    v += k.v;
  }
  return v ? tpv / v : 0;
}

export function emas(klines: Kline[]): { fast: number | null; slow: number | null } {
  const closes = klines.map((k) => k.c);
  const s = emaSeries(closes, EMA_S);
  const l = emaSeries(closes, EMA_L);
  return { fast: s[s.length - 1] ?? null, slow: l[l.length - 1] ?? null };
}

interface HaCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  green: boolean;
}

export function heikinAshi(klines: Kline[]): HaCandle[] {
  const ha: HaCandle[] = [];
  klines.forEach((k, i) => {
    const c = (k.o + k.h + k.l + k.c) / 4;
    const o = i === 0 ? (k.o + k.c) / 2 : (ha[i - 1].o + ha[i - 1].c) / 2;
    ha.push({ o, h: Math.max(k.h, o, c), l: Math.min(k.l, o, c), c, green: c >= o });
  });
  return ha;
}

export function volProfile(klines: Kline[]): { poc: number; bins: [number, number][] } {
  if (!klines.length) return { poc: 0, bins: [] };
  const lo = Math.min(...klines.map((k) => k.l));
  const hi = Math.max(...klines.map((k) => k.h));
  if (hi === lo) return { poc: lo, bins: [[lo, klines.reduce((s, k) => s + k.v, 0)]] };
  const n = VP_BINS;
  const bsz = (hi - lo) / n;
  const bins = new Array(n).fill(0);
  for (const k of klines) {
    const bLo = Math.max(0, Math.floor((k.l - lo) / bsz));
    const bHi = Math.min(n - 1, Math.floor((k.h - lo) / bsz));
    const share = k.v / Math.max(1, bHi - bLo + 1);
    for (let b = bLo; b <= bHi; b++) bins[b] += share;
  }
  let poci = 0;
  for (let i = 1; i < n; i++) if (bins[i] > bins[poci]) poci = i;
  const poc = lo + (poci + 0.5) * bsz;
  return { poc, bins: bins.map((v, i) => [lo + (i + 0.5) * bsz, v] as [number, number]) };
}

/** 動能評分算法，介於 -100 ~ +100。ready=false（klines 樣本不足）時回傳 null。 */
export function biasScore(state: BinanceState): number | null {
  const { bids, asks, mid, trades, klines } = state;
  if (klines.length < MACD_SLOW) return null;

  const W = BIAS_WEIGHTS;
  let total = 0;

  const { fast: es, slow: el } = emas(klines);
  if (es != null && el != null) total += es > el ? W.ema : -W.ema;

  if (mid) total += obi(bids, asks, mid) * W.obi;

  const { hist: hv } = macd(klines);
  if (hv != null) total += hv > 0 ? W.macd : -W.macd;

  const cvd5 = cvd(trades, 300);
  if (cvd5 !== 0) total += cvd5 > 0 ? W.cvd : -W.cvd;

  const ha = heikinAshi(klines);
  if (ha.length) {
    let streak = 0;
    for (const c of [...ha].slice(-3).reverse()) {
      if (c.green) {
        if (streak >= 0) streak += 1;
        else break;
      } else {
        if (streak <= 0) streak -= 1;
        else break;
      }
    }
    total += Math.max(-W.ha, Math.min(W.ha, streak * (W.ha / 3)));
  }

  const vwapV = vwap(klines);
  if (vwapV && mid) total += mid > vwapV ? W.vwap : -W.vwap;

  const rsiV = rsi(klines);
  if (rsiV != null) {
    if (rsiV <= 30) total += W.rsi;
    else if (rsiV >= 70) total -= W.rsi;
    else if (rsiV < 50) total += (W.rsi * (50 - rsiV)) / 20;
    else total -= (W.rsi * (rsiV - 50)) / 20;
  }

  const { poc } = volProfile(klines);
  if (poc && mid) total += mid > poc ? W.poc : -W.poc;

  const { bidWalls, askWalls } = walls(bids, asks);
  const wallPts = (Math.min(bidWalls.length, 2) - Math.min(askWalls.length, 2)) * 2;
  total += Math.max(-W.walls, Math.min(W.walls, wallPts));

  const maxPossible = Object.values(W).reduce((a, b) => a + b, 0);
  const raw = (total / maxPossible) * 100;
  return Math.max(-100, Math.min(100, raw));
}

export type TrendLabel = "BULLISH" | "BEARISH" | "NEUTRAL";

/** 質化趨勢分類（整數投票，每指標 -1/0/+1，OBI/wall 例外可到 ±2）。跟 biasScore() 是兩把不同的尺。 */
export function scoreTrend(state: BinanceState): { score: number; label: TrendLabel } {
  const { bids, asks, mid, trades, klines } = state;
  let score = 0;

  const obiV = mid ? obi(bids, asks, mid) : 0;
  if (obiV > OBI_THRESH) score += 1;
  else if (obiV < -OBI_THRESH) score -= 1;

  const cvd5 = cvd(trades, 300);
  score += cvd5 > 0 ? 1 : cvd5 < 0 ? -1 : 0;

  const rsiV = rsi(klines);
  if (rsiV != null) {
    if (rsiV > RSI_OB) score -= 1;
    else if (rsiV < RSI_OS) score += 1;
  }

  const { hist: hv } = macd(klines);
  if (hv != null) score += hv > 0 ? 1 : -1;

  const vwapV = vwap(klines);
  if (vwapV && mid) score += mid > vwapV ? 1 : -1;

  const { fast: es, slow: el } = emas(klines);
  if (es != null && el != null) score += es > el ? 1 : -1;

  const { bidWalls, askWalls } = walls(bids, asks);
  score += Math.min(bidWalls.length, 2);
  score -= Math.min(askWalls.length, 2);

  const ha = heikinAshi(klines);
  if (ha.length >= 3) {
    const last3 = ha.slice(-3);
    if (last3.every((c) => c.green)) score += 1;
    else if (last3.every((c) => !c.green)) score -= 1;
  }

  const label: TrendLabel = score >= TREND_THRESH ? "BULLISH" : score <= -TREND_THRESH ? "BEARISH" : "NEUTRAL";
  return { score, label };
}

export function biasLabel(bias: number | null): TrendLabel {
  if (bias == null) return "NEUTRAL";
  if (bias > 10) return "BULLISH";
  if (bias < -10) return "BEARISH";
  return "NEUTRAL";
}

/** 給 MomentumPanel 用的完整拆解——所有指標分開回傳，不只是折算後的單一分數。 */
export interface IndicatorBreakdown {
  ready: boolean;
  mid: number;
  ema: { fast: number | null; slow: number | null; bullish: boolean | null };
  obi: number | null;
  macd: { macd: number | null; signal: number | null; hist: number | null };
  cvd5m: number | null;
  activeBuySell5m: { buyUsd: number; sellUsd: number; netUsd: number; buyCount: number; sellCount: number };
  heikinAshiStreak: number;
  vwap: number | null;
  aboveVwap: boolean | null;
  rsi: number | null;
  poc: number | null;
  abovePoc: boolean | null;
  walls: { bid: number; ask: number };
  biasScore: number | null;
  biasLabel: TrendLabel;
  trend: { score: number; label: TrendLabel };
}

export function computeBreakdown(state: BinanceState): IndicatorBreakdown {
  const { bids, asks, mid, trades, klines } = state;
  const ready = mid > 0 && klines.length >= MACD_SLOW;

  const { fast, slow } = emas(klines);
  const emaBullish = fast != null && slow != null ? fast > slow : null;
  const obiV = mid ? obi(bids, asks, mid) : null;
  const macdV = macd(klines);
  const cvd5 = cvd(trades, 300);
  const activeVol = activeBuySell(trades, 300);
  const ha = heikinAshi(klines);
  let haStreak = 0;
  for (const c of [...ha].slice(-3).reverse()) {
    if (c.green) {
      if (haStreak >= 0) haStreak += 1;
      else break;
    } else {
      if (haStreak <= 0) haStreak -= 1;
      else break;
    }
  }
  const vwapV = vwap(klines) || null;
  const { poc } = volProfile(klines);
  const pocV = poc || null;
  const { bidWalls, askWalls } = walls(bids, asks);
  const bias = biasScore(state);
  const trend = scoreTrend(state);

  return {
    ready,
    mid,
    ema: { fast, slow, bullish: emaBullish },
    obi: obiV,
    macd: macdV,
    cvd5m: cvd5,
    activeBuySell5m: activeVol,
    heikinAshiStreak: haStreak,
    vwap: vwapV,
    aboveVwap: vwapV && mid ? mid > vwapV : null,
    rsi: rsi(klines),
    poc: pocV,
    abovePoc: pocV && mid ? mid > pocV : null,
    walls: { bid: bidWalls.length, ask: askWalls.length },
    biasScore: bias,
    biasLabel: biasLabel(bias),
    trend,
  };
}
