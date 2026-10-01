"use client";

import { useEffect, useState } from "react";
import type { SnapshotTick } from "@/lib/db";
import Heatmap from "./Heatmap";
import Sparkline from "./Sparkline";

const POLL_MS = 5000;

// 時框按鈕已經拿掉了，固定顯示 30 分鐘就好——不需要再讓使用者切換。
const MINUTES = 30;

export default function CoinDetailClient({ coin }: { coin: string }) {
  const [ticks, setTicks] = useState<SnapshotTick[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const res = await fetch(`/api/ticks?coin=${coin}&minutes=${MINUTES}&limit=5000`);
        const json = await res.json();
        if (cancelled) return;
        setTicks(json.ticks ?? []);
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, POLL_MS);
        }
      }
    }
    setLoading(true);
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [coin]);

  const latest = ticks[ticks.length - 1];
  const recent = [...ticks].slice(-20).reverse();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <StatBox label="Perpl Mid" value={latest ? `$${latest.perpl_mid.toLocaleString()}` : "--"} />
        <StatBox
          label="Momentum Bias"
          value={latest?.momentum_bias != null ? latest.momentum_bias.toFixed(1) : "--"}
          tone={latest?.momentum_bias != null ? (latest.momentum_bias >= 0 ? "bull" : "bear") : "muted"}
        />
        <StatBox
          label="Basis (vs Binance)"
          value={latest?.basis_bps != null ? `${latest.basis_bps.toFixed(2)} bps` : "--"}
          tone={latest?.basis_bps != null ? (latest.basis_bps >= 0 ? "bull" : "bear") : "muted"}
        />
        <StatBox label="Depth Levels" value={latest ? String(latest.depth) : "--"} />
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <h3 className="text-sm font-semibold text-muted mb-2">Orderbook Pressure Heatmap</h3>
        {loading && ticks.length === 0 ? (
          <div className="h-[420px] flex items-center justify-center text-muted text-sm">Loading…</div>
        ) : ticks.length === 0 ? (
          <div className="h-[420px] flex items-center justify-center text-muted text-sm">No data in this time window</div>
        ) : (
          // 這頁的時窗只有 30 分鐘（MINUTES），用 15 分鐘的棒子只會有兩根，改 5 分鐘一根。
          <Heatmap ticks={ticks} height={420} bucketMinutes={5} />
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-panel p-4">
          <h3 className="text-sm font-semibold text-muted mb-2">Momentum Bias Trend</h3>
          <Sparkline values={ticks.map((t) => t.momentum_bias)} width={480} height={100} />
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <h3 className="text-sm font-semibold text-muted mb-2">Basis (Perpl - Binance) Trend</h3>
          <Sparkline values={ticks.map((t) => t.basis_bps)} width={480} height={100} />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4 overflow-x-auto">
        <h3 className="text-sm font-semibold text-muted mb-2">Last 20 Snapshots</h3>
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr className="text-left">
              <th className="py-1 pr-3">Time</th>
              <th className="py-1 pr-3">mid</th>
              <th className="py-1 pr-3">bid_usd</th>
              <th className="py-1 pr-3">ask_usd</th>
              <th className="py-1 pr-3">ask/bid</th>
              <th className="py-1 pr-3">bias</th>
              <th className="py-1 pr-3">basis(bps)</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((t) => (
              <tr key={t.ts} className="border-t border-border/50">
                <td className="py-1 pr-3 text-muted">
                  {new Date(t.ts * 1000).toLocaleTimeString("en-US", { hour12: false })}
                </td>
                <td className="py-1 pr-3">${t.perpl_mid.toLocaleString()}</td>
                <td className="py-1 pr-3 text-bull">${t.bid_usd.toLocaleString()}</td>
                <td className="py-1 pr-3 text-bear">${t.ask_usd.toLocaleString()}</td>
                <td className="py-1 pr-3">{t.ask_over_bid?.toFixed(2) ?? "--"}</td>
                <td className={`py-1 pr-3 ${(t.momentum_bias ?? 0) >= 0 ? "text-bull" : "text-bear"}`}>
                  {t.momentum_bias?.toFixed(1) ?? "--"}
                </td>
                <td className="py-1 pr-3">{t.basis_bps?.toFixed(2) ?? "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear" | "muted" | "default";
}) {
  const color =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "muted" ? "text-muted" : "text-white";
  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2">
      <div className="text-[10px] text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
