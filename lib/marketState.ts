/**
 * lib/marketState.ts — process 內單例，管理「每個幣種各自一條 Binance WS+REST」
 * 的即時收集（取代原本讀 Postgres BookSnapshot 的做法）。
 *
 * 由 instrumentation.ts 在 server 啟動時呼叫一次 start()；每個 API 呼叫也會
 * 再呼叫一次 start()（有 `started` 旗標擋重複，等於保險絲——避免萬一
 * instrumentation hook 沒被觸發，網站打開時仍要等第一次手動觸發才開始收集）。
 *
 * globalThis 掛載是必要的：Next.js dev 模式每次程式碼變更都會重新 require 模組，
 * 沒有這層保護的話每次熱重載都會多開一組 WS 連線，舊連線變孤兒但仍佔用資源
 */
import { BinanceState, bootstrapKlines, startObPoller, startTradeAndKlineFeed } from "./binanceFeed";
import { computeBreakdown, type IndicatorBreakdown } from "./indicators";

// Perpl 支援的全部市場。
export const COINS = ["BTC", "ETH", "HYPE", "MON", "ZEC", "SOL"] as const;
export type Coin = (typeof COINS)[number];

// collector 端只訂閱 BTC 的幣安行情。這裡要做「多幣種動量
// 比較」，比照 Binance 現貨代號慣例補上其餘 5 幣種——MON 是否已在 Binance 現貨
// 掛牌未經驗證，訂閱失敗時只會讓該幣種 bootError 有值、WS 進入原地重連迴圈，
// 不影響其他幣種收集，面板上會顯示「無資料」而不是讓整個 process 掛掉。
const BINANCE_SYMBOL: Record<Coin, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  HYPE: "HYPEUSDT",
  ZEC: "ZECUSDT",
  MON: "MONUSDT",
};

const KLINE_INTERVAL = "1m";
const HISTORY_SAMPLE_MS = 5000;
const HISTORY_MAX_POINTS = 720; // 5s 一筆 × 720 ≈ 1 小時

export interface HistoryPoint {
  ts: number;
  biasScore: number | null;
  cvd5m: number | null;
}

interface CoinRuntime {
  coin: Coin;
  symbol: string;
  state: BinanceState;
  bootError: string | null;
  history: HistoryPoint[];
  stopFeed: () => void;
  stopPoller: () => void;
}

export interface CoinLiveSnapshot {
  coin: Coin;
  symbol: string;
  connected: boolean;
  bootError: string | null;
  lastTradeAt: number;
  lastKlineAt: number;
  breakdown: IndicatorBreakdown;
  history: HistoryPoint[];
}

class MarketStateManager {
  private runtimes = new Map<Coin, CoinRuntime>();
  private started = false;
  private historyTimer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.started) return;
    this.started = true;

    for (const coin of COINS) {
      const symbol = BINANCE_SYMBOL[coin];
      const state = new BinanceState();
      const stopFeed = startTradeAndKlineFeed(symbol, KLINE_INTERVAL, state);
      const stopPoller = startObPoller(symbol, state);
      const runtime: CoinRuntime = { coin, symbol, state, bootError: null, history: [], stopFeed, stopPoller };
      this.runtimes.set(coin, runtime);

      bootstrapKlines(symbol, KLINE_INTERVAL, state).catch((err) => {
        runtime.bootError = err instanceof Error ? err.message : String(err);
        console.error(`[marketState] ${coin}(${symbol}) kline bootstrap failed: ${runtime.bootError}`);
      });
    }

    this.historyTimer = setInterval(() => this.sampleHistory(), HISTORY_SAMPLE_MS);
    console.log(`[marketState] started, coins=${COINS.join(",")}`);
  }

  /** 關掉每個幣種的 Binance WS/REST 輪詢 + 停止歷史取樣，process 收尾用。 */
  stop() {
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.historyTimer = null;
    for (const rt of this.runtimes.values()) {
      try {
        rt.stopFeed();
      } catch (err) {
        console.error(`[marketState] error stopping feed for ${rt.coin}:`, err);
      }
      try {
        rt.stopPoller();
      } catch (err) {
        console.error(`[marketState] error stopping poller for ${rt.coin}:`, err);
      }
    }
    this.started = false;
  }

  private sampleHistory() {
    for (const rt of this.runtimes.values()) {
      const b = computeBreakdown(rt.state);
      rt.history.push({ ts: Date.now(), biasScore: b.biasScore, cvd5m: b.cvd5m });
      if (rt.history.length > HISTORY_MAX_POINTS) rt.history.shift();
    }
  }

  getAll(): CoinLiveSnapshot[] {
    return COINS.map((coin) => this.get(coin)).filter((x): x is CoinLiveSnapshot => x !== null);
  }

  get(coin: string): CoinLiveSnapshot | null {
    const rt = this.runtimes.get(coin.toUpperCase() as Coin);
    if (!rt) return null;
    return {
      coin: rt.coin,
      symbol: rt.symbol,
      connected: rt.state.connected,
      bootError: rt.bootError,
      lastTradeAt: rt.state.lastTradeAt,
      lastKlineAt: rt.state.lastKlineAt,
      breakdown: computeBreakdown(rt.state),
      history: rt.history,
    };
  }
}

const g = globalThis as unknown as { __marketState?: MarketStateManager };
export const marketState = g.__marketState ?? new MarketStateManager();
g.__marketState = marketState;
