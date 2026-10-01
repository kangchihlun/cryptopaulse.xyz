import { NextResponse } from "next/server";
import { marketState } from "@/lib/marketState";

export const dynamic = "force-dynamic";

// GET /api/momentum — 即時讀 process 內存的 Binance 指標拆解（不查 Postgres）。
export async function GET() {
  // 保險絲：萬一 instrumentation.ts 沒被觸發到，這裡補一次啟動（start() 內建
  // started 旗標擋重複呼叫，不會重開連線）。
  marketState.start();
  return NextResponse.json({ coins: marketState.getAll(), servedAt: Date.now() });
}
