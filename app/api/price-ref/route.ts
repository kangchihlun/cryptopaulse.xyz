import { NextRequest, NextResponse } from "next/server";
import { fetchPriceNear } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/price-ref?coin=BTC&hoursAgo=24 — closest snapshot at/before (now - hoursAgo),
// used to compute "vs 24h ago" price change on the heatmap toolbar.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const coin = (searchParams.get("coin") || "BTC").toUpperCase();
  const hoursAgo = Math.min(Math.max(Number(searchParams.get("hoursAgo") ?? 24), 1), 24 * 30);
  const atMs = Date.now() - hoursAgo * 60 * 60_000;

  try {
    const ref = await fetchPriceNear(coin, atMs);
    return NextResponse.json({ coin, hoursAgo, ref });
  } catch (err) {
    console.error("[/api/price-ref]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
