"use client";

import { useEffect, useState } from "react";
import type { SnapshotTick } from "@/lib/db";
import Heatmap from "./Heatmap";

// collector 每小時才批次 flush 一次進 Postgres（見 web/README.md「已知落差」），
// 資料庫裡最新一筆正常就落後 0~60 分鐘。時窗太短（例如 5 分鐘）常態性會查到空
// 結果——不是這個網站或收集器壞了，只是還沒到下次批次寫入。預設給 2 小時，
// 確保任何時候打開都看得到圖。
const RANGE_OPTIONS = [
  { label: "30m", minutes: 30 },
  { label: "2h", minutes: 120 },
  { label: "12h", minutes: 720 },
  { label: "24h", minutes: 1440 },
];

const POLL_MS = 5000;

// K 棒長度：2 小時的時窗切成 15 分鐘一根＝8 根，每根寬度才夠放得下 footprint
// 的數字（見 components/Heatmap.tsx 的 showText 門檻）。
const BUCKET_MINUTES = 15;

interface LiveHeatmapPanelProps {
  initialCoin: string;
  coins: string[];
  height?: number;
}

export default function LiveHeatmapPanel({ initialCoin, coins, height = 500 }: LiveHeatmapPanelProps) {
  const [coin, setCoin] = useState(initialCoin);
  const [minutes, setMinutes] = useState(120);
  const [ticks, setTicks] = useState<SnapshotTick[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dayAgoMid, setDayAgoMid] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function load() {
      try {
        // downsample：時窗愈長，跟後端要的逐筆上限愈低（1 小時本來就有 ~3600 筆/幣，
        // 12 小時直接全拉會太重，交給後端 limit 由新到舊截斷，圖表本身也會再合併取樣）。
        const limit = minutes <= 30 ? 5000 : minutes <= 120 ? 8000 : 15000;
        const [ticksRes, refRes] = await Promise.all([
          fetch(`/api/ticks?coin=${coin}&minutes=${minutes}&limit=${limit}`),
          // 24h 參考價跟選擇的時窗無關，只需要在切換幣種時重抓一次即可，但跟
          // ticks 併在同一輪 poll 裡最簡單，成本也很低（單筆查詢）。
          fetch(`/api/price-ref?coin=${coin}&hoursAgo=24`),
        ]);
        if (!ticksRes.ok) throw new Error(`HTTP ${ticksRes.status}`);
        const json = await ticksRes.json();
        if (cancelled) return;
        setTicks(json.ticks ?? []);
        setError(null);

        if (refRes.ok) {
          const refJson = await refRes.json();
          if (!cancelled) setDayAgoMid(refJson.ref?.mid ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
        if (!cancelled) timer = setTimeout(load, POLL_MS);
      }
    }
    setLoading(true);
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [coin, minutes]);

  const currentPrice = ticks.length > 0 ? ticks[ticks.length - 1].perpl_mid : null;
  const changePct =
    currentPrice != null && dayAgoMid ? ((currentPrice - dayAgoMid) / dayAgoMid) * 100 : null;

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <select
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
            className="bg-bg border border-border rounded px-2 py-1 text-sm"
          >
            {coins.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums">
              {currentPrice != null ? `$${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "--"}
            </span>
            {changePct != null && (
              <span className={`text-sm font-semibold ${changePct >= 0 ? "text-bull" : "text-bear"}`}>
                {changePct >= 0 ? "+" : ""}
                {changePct.toFixed(2)}% (24h)
              </span>
            )}
            {error && <span className="text-bear text-xs ml-2">{error}</span>}
          </div>
        </div>
      </div>
      {ticks.length === 0 && !loading ? (
        <div style={{ height }} className="flex items-center justify-center text-muted text-sm">
          No data in this time window
        </div>
      ) : (
        <Heatmap ticks={ticks} height={height} bucketMinutes={BUCKET_MINUTES} />
      )}
    </div>
  );
}
