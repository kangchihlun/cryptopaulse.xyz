import { NextRequest, NextResponse } from "next/server";
import { bookCache } from "@/lib/bookCache";

export const dynamic = "force-dynamic";

// GET /api/coins?minutes=60 — 各幣種最新快照 + 過去 N 分鐘筆數（用筆數判斷是否為
// 「有連續收集」還是「366 筆那種短暫測試殘留」）。讀 lib/bookCache.ts 的記憶體
// 快取，不再每個 request 都直接查 Postgres。
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const minutes = Math.min(Math.max(Number(searchParams.get("minutes") ?? 60), 1), 24 * 60);
  const sinceMs = Date.now() - minutes * 60_000;

  const summaries = bookCache.getCoinSummaries(sinceMs);
  return NextResponse.json({ minutes, coins: summaries });
}
