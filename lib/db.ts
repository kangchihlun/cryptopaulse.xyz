/**
 * Postgres 連線層 — 直讀 perpl_snapshot_collector.py 寫入的 BookSnapshot 表。
 *
 * 表結構（跟 collector 端的快取表一致）：
 *   kind TEXT, key TEXT, ts BIGINT(ms), raw JSONB
 * 這裡只讀 kind='signal_snapshot' 這個分區；raw 內還有一層 raw.kind="tick"，
 * 是每筆快照自己的型別欄位，跟外層的 kind 是兩個不同層級，
 * 不要混淆。
 *
 * snapshot collector 實際寫入的表是 "BookSnapshot"（大小寫混合，需雙引號），
 * 可用 TABLE_NAME 環境變數覆寫，此處預設值即為 "BookSnapshot"。
 */
import { Pool } from "pg";

const TABLE_NAME = process.env.TABLE_NAME || "BookSnapshot";
const SNAPSHOT_KIND = "signal_snapshot";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error(
        "POSTGRES_URL is not set — add the Postgres connection string to .env(.local)"
      );
    }
    pool = new Pool({
      connectionString: url,
      ssl: url.includes("railway") ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

/** 關掉 Postgres connection pool，process 收尾用（不然閒置的連線會讓 event loop 賴著不退出）。 */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** raw JSONB 的欄位形狀，對應 perpl_snapshot_collector.py 的 _queue_snapshot(coin, "tick", ...)。 */
export interface SnapshotTick {
  ts: number; // epoch seconds (float)
  coin: string;
  kind: "tick";
  depth: number;
  bid_usd: number;
  ask_usd: number;
  bid1_usd: number;
  ask1_usd: number;
  bids_detail: [number, number][]; // [price, size][]，由頂檔到最差價
  asks_detail: [number, number][];
  ask_over_bid: number | null;
  bid_over_ask: number | null;
  momentum_bias: number | null; // -100..+100，null = 動能訊號尚未暖機/該幣種無 Binance 對照
  perpl_mid: number;
  binance_mid: number | null;
  basis_bps: number | null;
}

const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** 依幣種、時間窗查詢逐筆快照，由舊到新排序（時間序列圖表要的順序）。 */
export async function fetchTicks(
  coin: string,
  sinceMs: number,
  limit = 20000
): Promise<SnapshotTick[]> {
  const sql = `
    SELECT raw FROM ${identifier(TABLE_NAME)}
    WHERE kind = $1 AND ts >= $2 AND raw->>'coin' = $3
    ORDER BY ts DESC
    LIMIT $4
  `;
  const { rows } = await getPool().query(sql, [SNAPSHOT_KIND, sinceMs, coin, limit]);
  return rows.map((r) => r.raw as SnapshotTick).reverse();
}

export interface PriceRef {
  ts: number; // epoch ms
  mid: number;
}

/**
 * 找離某個目標時間最近、且不晚於它的一筆快照（給「相對 24 小時前漲跌幅」這種
 * 參考價用）。優先抓 ts <= atMs 裡最新的一筆；如果這個幣種收集的歷史還沒那麼
 * 久（例如剛開始收集），退回抓全部裡最舊的一筆，至少給個有意義的參考點而不是
 * 完全沒有。
 */
export async function fetchPriceNear(coin: string, atMs: number): Promise<PriceRef | null> {
  const beforeSql = `
    SELECT ts, raw->>'perpl_mid' AS mid FROM ${identifier(TABLE_NAME)}
    WHERE kind = $1 AND raw->>'coin' = $2 AND ts <= $3
    ORDER BY ts DESC LIMIT 1
  `;
  const { rows } = await getPool().query(beforeSql, [SNAPSHOT_KIND, coin, atMs]);
  if (rows.length > 0) {
    return { ts: Number(rows[0].ts), mid: Number(rows[0].mid) };
  }
  const earliestSql = `
    SELECT ts, raw->>'perpl_mid' AS mid FROM ${identifier(TABLE_NAME)}
    WHERE kind = $1 AND raw->>'coin' = $2
    ORDER BY ts ASC LIMIT 1
  `;
  const { rows: earliestRows } = await getPool().query(earliestSql, [SNAPSHOT_KIND, coin]);
  if (earliestRows.length === 0) return null;
  return { ts: Number(earliestRows[0].ts), mid: Number(earliestRows[0].mid) };
}

export interface CoinSummary {
  coin: string;
  latest: SnapshotTick;
  rowCount1h: number;
}

/** 有資料的幣種清單 + 各自最新一筆快照（給 dashboard 總覽 / 動量比較面板用）。 */
export async function fetchCoinSummaries(sinceMs: number): Promise<CoinSummary[]> {
  const distinctSql = `
    SELECT DISTINCT raw->>'coin' AS coin
    FROM ${identifier(TABLE_NAME)}
    WHERE kind = $1 AND ts >= $2
  `;
  const { rows: coinRows } = await getPool().query(distinctSql, [SNAPSHOT_KIND, sinceMs]);
  const coins: string[] = coinRows.map((r) => r.coin).filter(Boolean);

  const summaries: CoinSummary[] = [];
  for (const coin of coins) {
    const latestSql = `
      SELECT raw FROM ${identifier(TABLE_NAME)}
      WHERE kind = $1 AND raw->>'coin' = $2
      ORDER BY ts DESC LIMIT 1
    `;
    const countSql = `
      SELECT count(*)::int AS n FROM ${identifier(TABLE_NAME)}
      WHERE kind = $1 AND raw->>'coin' = $2 AND ts >= $3
    `;
    const [latestRes, countRes] = await Promise.all([
      getPool().query(latestSql, [SNAPSHOT_KIND, coin]),
      getPool().query(countSql, [SNAPSHOT_KIND, coin, sinceMs]),
    ]);
    if (latestRes.rows.length === 0) continue;
    summaries.push({
      coin,
      latest: latestRes.rows[0].raw as SnapshotTick,
      rowCount1h: countRes.rows[0].n,
    });
  }
  // 依最新更新時間排序，斷線太久的幣種排後面。
  summaries.sort((a, b) => b.latest.ts - a.latest.ts);
  return summaries;
}
