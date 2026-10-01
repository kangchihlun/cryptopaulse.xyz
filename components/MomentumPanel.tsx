"use client";

import { useEffect, useState } from "react";
import Sparkline from "./Sparkline";
import { COLORS } from "@/lib/theme";

/**
 * MomentumPanel — 不再讀 Postgres 的 BookSnapshot.momentum_bias（那是折算後的
 * 單一分數），改成直接連 lib/marketState.ts + lib/indicators.ts（Python 版
 * feeds.py + indicators.py 的 TS 移植）即時監聽幣安主動買賣算出的完整指標拆解。
 * 每個指標分開顯示，不是只看折算後的單一 bias 數字。
 *
 * 2026-09-05：資料傳輸從「每 4 秒 fetch /api/momentum」的 polling 改成
 * server.ts 開的 WebSocket（/ws/momentum）主動推播——server 端每秒把
 * marketState 的最新快照 broadcast 給所有連線的瀏覽器，前端只是被動接收，
 * 不用自己排程重複請求。/api/momentum 這條 REST route 還留著當手動除錯用
 * （curl 一下看現在資料長什麼樣），面板本身已經不呼叫它了。
 */

interface Breakdown {
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
  biasLabel: "BULLISH" | "BEARISH" | "NEUTRAL";
  trend: { score: number; label: "BULLISH" | "BEARISH" | "NEUTRAL" };
}

interface CoinLive {
  coin: string;
  symbol: string;
  connected: boolean;
  bootError: string | null;
  lastTradeAt: number;
  lastKlineAt: number;
  breakdown: Breakdown;
  history: { ts: number; biasScore: number | null; cvd5m: number | null }[];
}

const WS_PATH = "/ws/momentum";
const WS_RETRY_MS = 3000;

export default function MomentumPanel() {
  const [coins, setCoins] = useState<CoinLive[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (stopped) return;
      // 開頁面就立刻建立連線；用目前頁面的 protocol/host 組 ws(s):// URL，
      // 不寫死 localhost，部署到任何 host/port 都適用。
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "momentum") setCoins(msg.coins ?? []);
        } catch {
          // 收到壞掉的 frame 就略過，等下一筆 broadcast。
        }
        setLoading(false);
      };
      ws.onclose = () => {
        if (!stopped) retryTimer = setTimeout(connect, WS_RETRY_MS);
      };
      ws.onerror = () => ws?.close();
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  if (loading && coins.length === 0) {
    return <div className="text-muted text-sm">Connecting to live Binance data…</div>;
  }

  // bootError（Binance 現貨無此代號 / 啟動失敗）的幣種直接略過不顯示卡片——
  // 不需要在面板上呈現「無資料」的降級狀態，見 lib/marketState.ts 的
  // bootError 欄位（實測 HYPEUSDT/MONUSDT 會落在這裡）。
  const available = coins.filter((c) => !c.bootError);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {available.map((c) => (
        <CoinCard key={c.coin} c={c} />
      ))}
    </div>
  );
}

function CoinCard({ c }: { c: CoinLive }) {
  const b = c.breakdown;
  const tradeAgeSec = c.lastTradeAt ? (Date.now() - c.lastTradeAt) / 1000 : Infinity;
  const status = !c.connected
    ? { text: "Reconnecting", tone: "text-bear bg-bear/20" }
    : tradeAgeSec > 60
    ? { text: "No trades", tone: "text-muted bg-border" }
    : { text: "Live", tone: "text-bull bg-bull/20" };

  return (
    <div className="rounded-md border border-border bg-panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="font-bold text-sm">{c.coin}</span>
          <span className="text-[10px] text-muted ml-1">{c.symbol}</span>
        </div>
        <span className={`text-xs px-1.5 py-0.5 rounded ${status.tone}`}>{status.text}</span>
      </div>

      {!b.ready ? (
        <div className="text-xs text-muted">Warming up candle history (needs ≥26 1m candles)…</div>
      ) : (
        <>
          <div className="flex items-end justify-between mb-2">
            <div>
              <div className="text-[10px] text-muted uppercase">Bias Score</div>
              <div className={`text-2xl font-semibold ${(b.biasScore ?? 0) >= 0 ? "text-bull" : "text-bear"}`}>
                {b.biasScore != null ? `${b.biasScore > 0 ? "+" : ""}${b.biasScore.toFixed(1)}` : "--"}
                <span className="text-xs text-muted ml-1">{b.biasLabel}</span>
              </div>
              <div className="text-[10px] text-muted mt-0.5">
                Vote trend: {b.trend.score >= 0 ? "+" : ""}
                {b.trend.score} ({b.trend.label})
              </div>
            </div>
            <Sparkline values={c.history.map((h) => h.biasScore)} width={140} height={40} />
          </div>

          {/* Binance active buy/sell (5m window) — the raw split buy/sell volume, not just the folded CVD sign */}
          <div className="mb-2">
            <div className="text-[10px] text-muted uppercase mb-1">Active Buy/Sell 5m (Binance spot)</div>
            <ActiveVolBar buyUsd={b.activeBuySell5m.buyUsd} sellUsd={b.activeBuySell5m.sellUsd} />
            <div className="flex justify-between text-[10px] text-muted mt-0.5">
              <span className="text-bull">Buy ${fmtUsd(b.activeBuySell5m.buyUsd)} ({b.activeBuySell5m.buyCount} trades)</span>
              <span className="text-bear">Sell ${fmtUsd(b.activeBuySell5m.sellUsd)} ({b.activeBuySell5m.sellCount} trades)</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <IndicatorRow label="EMA(5/20)" value={b.ema.bullish == null ? "--" : b.ema.bullish ? "Bullish cross" : "Bearish cross"} tone={toneOf(b.ema.bullish)} />
            <IndicatorRow label="OBI" value={b.obi != null ? b.obi.toFixed(3) : "--"} tone={toneOfNum(b.obi, 0.05)} />
            <IndicatorRow label="MACD Hist" value={b.macd.hist != null ? b.macd.hist.toFixed(2) : "--"} tone={toneOfNum(b.macd.hist, 0)} />
            <IndicatorRow label="RSI(14)" value={b.rsi != null ? b.rsi.toFixed(1) : "--"} tone={rsiTone(b.rsi)} />
            <IndicatorRow label="vs VWAP" value={b.aboveVwap == null ? "--" : b.aboveVwap ? "Above" : "Below"} tone={toneOf(b.aboveVwap)} />
            <IndicatorRow label="vs POC" value={b.abovePoc == null ? "--" : b.abovePoc ? "Above" : "Below"} tone={toneOf(b.abovePoc)} />
            <IndicatorRow label="Walls bid/ask" value={`${b.walls.bid} / ${b.walls.ask}`} tone={toneOfNum(b.walls.bid - b.walls.ask, 0)} />
            <IndicatorRow label="Heikin-Ashi streak" value={String(b.heikinAshiStreak)} tone={toneOfNum(b.heikinAshiStreak, 0)} />
          </div>
        </>
      )}
    </div>
  );
}

function ActiveVolBar({ buyUsd, sellUsd }: { buyUsd: number; sellUsd: number }) {
  const total = buyUsd + sellUsd;
  const buyPct = total > 0 ? (buyUsd / total) * 100 : 50;
  // 單一 div、單一 CSS 漸層——不用兩個 div 拼接出硬邊界。過渡帶中心落在
  // buyPct（買賣比例還是看得出來），兩側各留 16 個百分點讓 bull→bear
  // 平滑融合，而不是一刀切的兩色分割。
  const bandHalf = 16;
  const from = Math.max(0, buyPct - bandHalf);
  const to = Math.min(100, buyPct + bandHalf);
  return (
    <div
      className="h-2 w-full rounded-full"
      style={{
        background: `linear-gradient(90deg, ${COLORS.bull} 0%, ${COLORS.bull} ${from}%, ${COLORS.bear} ${to}%, ${COLORS.bear} 100%)`,
      }}
    />
  );
}

function IndicatorRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-0.5">
      <span className="text-muted">{label}</span>
      <span className={tone}>{value}</span>
    </div>
  );
}

function toneOf(v: boolean | null): string {
  if (v == null) return "text-muted";
  return v ? "text-bull" : "text-bear";
}

function toneOfNum(v: number | null, epsilon: number): string {
  if (v == null) return "text-muted";
  if (v > epsilon) return "text-bull";
  if (v < -epsilon) return "text-bear";
  return "text-muted";
}

function rsiTone(v: number | null): string {
  if (v == null) return "text-muted";
  if (v >= 70) return "text-bear";
  if (v <= 30) return "text-bull";
  return "text-muted";
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}
