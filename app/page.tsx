import Link from "next/link";
import { bookCache } from "@/lib/bookCache";
import LiveHeatmapPanel from "@/components/LiveHeatmapPanel";
import MomentumPanel from "@/components/MomentumPanel";
import MethodologyAccordion, { HEATMAP_METHODOLOGY, MOMENTUM_METHODOLOGY } from "@/components/MethodologyAccordion";

// Perpl 的推薦連結——帶 ref 參數，導去他們自己的交易頁面（不是我們自己的路由）。
const PERPL_TRADE_URL = "https://app.perpl.xyz/trade?ref=KeZRdUarmoK";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // 讀 lib/bookCache.ts 的記憶體快取（server.ts 啟動時已預載過），不是即時查
  // Postgres——所以這裡不會拋錯，也不需要 try/catch（DB 真的連不上的話 bookCache
  // 內部會記 log 並保留舊快取，不會讓整個 dashboard 掛掉）。
  const coins = bookCache.getCoinSummaries(Date.now() - 60 * 60_000);

  const coinCodes = coins.map((c) => c.coin);
  const defaultCoin = coinCodes.includes("BTC") ? "BTC" : coinCodes[0];

  return (
    <main className="max-w-7xl mx-auto px-4 py-6">
      <header className="mb-6">
        <h1 className="text-xl font-bold">CryptoPulse.xyz</h1>
        <p className="text-sm text-muted">
          Real-time perpetual market microstructure monitor for{" "}
          <Link href={PERPL_TRADE_URL} target="_blank" rel="noopener noreferrer" className="text-bull hover:underline">
            Perpl
          </Link>{" "}
          — orderbook pressure heatmap + multi-coin momentum comparison
        </p>
      </header>

      {coins.length === 0 && (
        <div className="rounded-md border border-border bg-panel text-muted text-sm p-3 mb-4">
          No signal_snapshot data in the past hour — check whether the snapshot collector
          is still running, or
          check the server's startup log for "[bookCache] bootstrap failed".
        </div>
      )}

      {defaultCoin && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-muted mb-2">Orderbook Pressure Heatmap (Perpl)</h2>
          <LiveHeatmapPanel initialCoin={defaultCoin} coins={coinCodes} />
          <MethodologyAccordion title="About this heatmap" sections={HEATMAP_METHODOLOGY} />
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-muted mb-2">Momentum Comparison (live order-flow)</h2>
        <MomentumPanel />
        <MethodologyAccordion title="About these indicators" sections={MOMENTUM_METHODOLOGY} />
      </section>
    </main>
  );
}
