import { NextRequest, NextResponse } from "next/server";
import { bookCache } from "@/lib/bookCache";

export const dynamic = "force-dynamic";

// GET /api/ticks?coin=BTC&minutes=30&limit=20000 — 讀 lib/bookCache.ts 的記憶體
// 快取（server.ts 啟動時先預載過 24h 歷史、背景每分鐘刷新一次），不再每個
// request 都直接查 Postgres。
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const coin = (searchParams.get("coin") || "BTC").toUpperCase();
  const minutes = Math.min(Math.max(Number(searchParams.get("minutes") ?? 30), 1), 24 * 60);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 20000), 1), 50000);
  const sinceMs = Date.now() - minutes * 60_000;

  const ticks = bookCache.getTicks(coin, sinceMs, limit);
  return NextResponse.json({ coin, minutes, count: ticks.length, ticks });
}
