/**
 * lib/binanceFeed.ts — collector 端 Python 行情模組（feeds.py）的 TypeScript 移植。
 *
 * 跟 Python 版一樣：現貨成交 WS（<symbol>@trade，主動買賣方向靠 `!m` 判斷，
 * `m`=isBuyerMaker）+ K 線 WS（<symbol>@kline_INTERVAL）合併訂閱一條連線，
 * 斷線 5 秒後原地重連；REST 輪詢現貨 order book 當備援（WS 沒有 depth 頻道）。
 * 這裡不再是「算完折進單一 momentum_bias 存進 Postgres」，而是把 State 整包
 * 交給呼叫端（lib/marketState.ts）即時算全部指標——真正做到直接監聽幣安。
 */
import WebSocket from "ws";

const BINANCE_REST = "https://api.binance.com/api/v3";
const BINANCE_WS = "wss://stream.binance.com:9443/stream";

const TRADE_TTL_SEC = 600; // 秒；成交紀錄保留窗口（跟 Python 版設定一致）
const KLINE_MAX = 500;
const KLINE_BOOT = 200;
const OB_POLL_INTERVAL_MS = 2000;
const WS_RETRY_MS = 5000;

export interface Trade {
  t: number; // epoch seconds
  price: number;
  qty: number;
  isBuy: boolean; // 主動買方（taker 是買方）
}

export interface Kline {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export class BinanceState {
  bids: [number, number][] = [];
  asks: [number, number][] = [];
  mid = 0;
  trades: Trade[] = [];
  klines: Kline[] = [];
  curKline: Kline | null = null;

  connected = false;
  lastTradeAt = 0;
  lastKlineAt = 0;
  lastObAt = 0;
  wsRetries = 0;
}

/** 啟動時回補歷史 K 線（REST），讓技術指標一開始就有足夠樣本。失敗時拋出（呼叫端記 bootError）。 */
export async function bootstrapKlines(symbol: string, interval: string, state: BinanceState): Promise<void> {
  const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${KLINE_BOOT}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error(typeof json?.msg === "string" ? json.msg : `unexpected klines response for ${symbol}`);
  }
  state.klines = json.map((r: unknown[]) => ({
    t: Number(r[0]) / 1e3,
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[5]),
  }));
}

/** REST 輪詢現貨 order book（backup，主要行情走 WS）。回傳一個停止函式。 */
export function startObPoller(symbol: string, state: BinanceState): () => void {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(`${BINANCE_REST}/depth?symbol=${symbol}&limit=20`);
      const j = await res.json();
      if (Array.isArray(j?.bids) && Array.isArray(j?.asks)) {
        state.bids = j.bids.map((x: string[]) => [Number(x[0]), Number(x[1])]);
        state.asks = j.asks.map((x: string[]) => [Number(x[0]), Number(x[1])]);
        if (state.bids.length && state.asks.length) {
          state.mid = (state.bids[0][0] + state.asks[0][0]) / 2;
        }
        state.lastObAt = Date.now();
      }
    } catch {
      // 跟 Python 版一樣：單次輪詢失敗直接吞掉，下一輪再試。
    }
    if (!stopped) setTimeout(tick, OB_POLL_INTERVAL_MS);
  }
  tick();
  return () => {
    stopped = true;
  };
}

/** WS 訂閱現貨成交 + K 線，斷線自動重連。回傳一個停止函式。 */
export function startTradeAndKlineFeed(symbol: string, klineInterval: string, state: BinanceState): () => void {
  const sym = symbol.toLowerCase();
  const streams = [`${sym}@trade`, `${sym}@kline_${klineInterval}`].join("/");
  const url = `${BINANCE_WS}?streams=${streams}`;
  let stopped = false;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (stopped) return;
    ws = new WebSocket(url);

    ws.on("open", () => {
      state.connected = true;
      state.wsRetries = 0;
      console.log(`[binance ws] connected ${symbol}`);
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString());
        const stream: string = data.stream || "";
        const pay = data.data;
        if (!pay) return;

        if (stream.includes("@trade")) {
          state.trades.push({
            t: pay.T / 1000,
            price: Number(pay.p),
            qty: Number(pay.q),
            isBuy: !pay.m, // isBuyerMaker=false → taker 是買方 → 主動買
          });
          state.lastTradeAt = Date.now();
          if (state.trades.length > 5000) {
            const cut = Date.now() / 1000 - TRADE_TTL_SEC;
            state.trades = state.trades.filter((t) => t.t >= cut);
          }
        } else if (stream.includes("@kline")) {
          const k = pay.k;
          const candle: Kline = {
            t: k.t / 1000,
            o: Number(k.o),
            h: Number(k.h),
            l: Number(k.l),
            c: Number(k.c),
            v: Number(k.v),
          };
          state.curKline = candle;
          state.lastKlineAt = Date.now();
          if (k.x) {
            state.klines.push(candle);
            if (state.klines.length > KLINE_MAX) state.klines = state.klines.slice(-KLINE_MAX);
          }
        }
      } catch (err) {
        console.error(`[binance ws] parse error ${symbol}`, err);
      }
    });

    ws.on("close", () => {
      state.connected = false;
      if (!stopped) {
        state.wsRetries += 1;
        console.log(`[binance ws] closed ${symbol}, reconnecting in ${WS_RETRY_MS}ms (attempt ${state.wsRetries})`);
        retryTimer = setTimeout(connect, WS_RETRY_MS);
      }
    });

    ws.on("error", (err: Error) => {
      console.error(`[binance ws] error ${symbol}: ${err.message}`);
      ws?.close();
    });
  }

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    ws?.close();
  };
}
