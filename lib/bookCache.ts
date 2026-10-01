/**
 * lib/bookCache.ts — process 內單例，把 Postgres BookSnapshot 的歷史資料先撈進
 * 記憶體，取代原本每個 API request 都直接查 Postgres 的做法。
 *
 * 背景：`components/LiveHeatmapPanel.tsx`/`CoinDetailClient.tsx` 每 5 秒 poll
 * 一次 `/api/ticks`——原本每次都是活生生打 Postgres，連線多的時候（多個瀏覽器
 * 分頁同時開著）會對同一個資料庫重複查同一批資料。跟 lib/marketState.ts 對
 * 幣安的作法一致：process 啟動時先把資料收進記憶體，之後 API 只讀記憶體，
 * 定期背景刷新才去補打一次 DB。
 *
 * server.ts 會在 `await app.prepare()` 之後、`server.listen()` 之前先
 * `await bookCache.start()`——先把歷史資料拿進來才開始對外服務，符合
 * 「Node.js 後端啟動時要先連線 DB 拿歷史」的要求。
 *
 * 2026-09-05：`start()` 拆成兩階段，不要讓 server 啟動卡在一次抓 24 小時
 * （BTC 一天下來有 6~9 萬筆，實測要好幾秒）：
 *   1. 阻塞階段——先把「過去 30 分鐘」填滿就宣告 bootstrap 完成、放行
 *      server.listen()，這樣網站幾乎立刻就能開始回應，且 30 分鐘已經
 *      覆蓋熱圖預設/最常用的時窗。
 *   2. 背景階段——`start()` 回傳之後，不擋著任何人，繼續把每個幣種往回
 *      補到完整的 24 小時保留窗（給 LiveHeatmapPanel 的 2h/12h/24h 選項
 *      用）。背景階段還沒補完之前，這些較長時窗看到的資料會比較少，
 *      補完後下一次前端輪詢就會自動變完整，不用特別處理。
 */
import { fetchTicks, type SnapshotTick, type CoinSummary } from "./db";

// 跟 lib/marketState.ts 的 COINS 一致。
const COINS_TO_TRACK = ["BTC", "ETH", "HYPE", "MON", "ZEC", "SOL"];

// 阻塞階段先填多少——覆蓋熱圖預設時窗，讓 server 幾乎立刻就能開始服務。
const FAST_BOOTSTRAP_MS = 30 * 60_000;
// 快取總共留多久——熱圖最長的時窗選項是 24 小時（LiveHeatmapPanel 的
// RANGE_OPTIONS），留這麼多就夠了，不用囤更久（process 長駐幾天記憶體才不會一直長）。
const CACHE_WINDOW_MS = 24 * 60 * 60_000;
// collector 本來就是小時級批次寫入 Postgres（見 web/README.md「已知落差」），
// 1 分鐘刷新一次已經遠比它的寫入頻率即時，不用刷更頻繁去打 DB。
const REFRESH_INTERVAL_MS = 60_000;
// 24h @ 約 1 筆/秒的量級抓寬一點當上限。
const BOOTSTRAP_LIMIT = 100_000;

interface CoinCacheEntry {
  ticks: SnapshotTick[]; // 依 ts 由舊到新排序
  lastFetchMs: number; // 上次成功刷新時，資料庫裡最新一筆的 ts（毫秒）
}

class BookCache {
  private cache = new Map<string, CoinCacheEntry>();
  private started = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    console.log(
      `[bookCache] fast bootstrap: filling last ${FAST_BOOTSTRAP_MS / 60_000}m of BookSnapshot for ${COINS_TO_TRACK.join(",")}…`
    );
    await Promise.all(COINS_TO_TRACK.map((coin) => this.bootstrap(coin, Date.now() - FAST_BOOTSTRAP_MS)));
    console.log(
      "[bookCache] fast bootstrap complete:",
      COINS_TO_TRACK.map((c) => `${c}=${this.cache.get(c)?.ticks.length ?? 0}`).join(" ")
    );
    this.refreshTimer = setInterval(() => this.refreshAll(), REFRESH_INTERVAL_MS);

    // 不 await：讓 server.listen() 不用等這一步，背景慢慢把每個幣種補到完整
    // 的 24h 保留窗。
    void this.backfillAll();
  }

  /** 停止背景刷新，process 收尾用。 */
  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.started = false;
  }

  private async bootstrap(coin: string, sinceMs: number): Promise<void> {
    try {
      const ticks = await fetchTicks(coin, sinceMs, BOOTSTRAP_LIMIT);
      const lastFetchMs = ticks.length ? Math.round(ticks[ticks.length - 1].ts * 1000) : sinceMs;
      this.cache.set(coin, { ticks, lastFetchMs });
    } catch (err) {
      console.error(`[bookCache] bootstrap failed for ${coin}, starting empty:`, err);
      this.cache.set(coin, { ticks: [], lastFetchMs: sinceMs });
    }
  }

  private async backfillAll(): Promise<void> {
    console.log(
      `[bookCache] backfilling remaining ${(CACHE_WINDOW_MS - FAST_BOOTSTRAP_MS) / 3_600_000}h in background…`
    );
    await Promise.all(COINS_TO_TRACK.map((coin) => this.backfill(coin)));
    console.log(
      "[bookCache] backfill complete:",
      COINS_TO_TRACK.map((c) => `${c}=${this.cache.get(c)?.ticks.length ?? 0}`).join(" ")
    );
  }

  /** 把某個幣種的快取往回補到完整的 CACHE_WINDOW_MS，只補「比目前最舊那筆更早」的部分。 */
  private async backfill(coin: string): Promise<void> {
    const entry = this.cache.get(coin);
    const oldestKnownMs = entry?.ticks[0] ? Math.round(entry.ticks[0].ts * 1000) : Date.now() - FAST_BOOTSTRAP_MS;
    const targetSinceMs = Date.now() - CACHE_WINDOW_MS;
    if (targetSinceMs >= oldestKnownMs) return; // 已經涵蓋到保留窗底了，不用補
    try {
      const older = await fetchTicks(coin, targetSinceMs, BOOTSTRAP_LIMIT);
      const olderOnly = older.filter((t) => t.ts * 1000 < oldestKnownMs);
      if (olderOnly.length === 0) return;
      const cur = this.cache.get(coin);
      if (!cur) return;
      cur.ticks = [...olderOnly, ...cur.ticks];
    } catch (err) {
      console.error(`[bookCache] backfill failed for ${coin}:`, err);
    }
  }

  private async refreshAll(): Promise<void> {
    await Promise.all(COINS_TO_TRACK.map((coin) => this.refresh(coin)));
  }

  private async refresh(coin: string): Promise<void> {
    const entry = this.cache.get(coin);
    if (!entry) {
      // 正常不會走到這裡——start() 已經對 COINS_TO_TRACK 每個都先 bootstrap
      // 過一次。萬一真的碰到未知幣種，直接補完整的保留窗當初始化。
      await this.bootstrap(coin, Date.now() - CACHE_WINDOW_MS);
      return;
    }
    try {
      // 從上次抓到的最新一筆往前退 1 秒重疊查詢，避免邊界那一筆卡在中間漏掉
      // （跟 collector 端快取的 overlap 回補同精神）。
      const sinceMs = entry.lastFetchMs - 1000;
      const fresh = await fetchTicks(coin, sinceMs, 20_000);
      if (fresh.length === 0) return;
      const seen = new Set(entry.ticks.map((t) => t.ts));
      const merged = [...entry.ticks, ...fresh.filter((t) => !seen.has(t.ts))];
      merged.sort((a, b) => a.ts - b.ts);
      const cutoff = Date.now() - CACHE_WINDOW_MS;
      entry.ticks = merged.filter((t) => t.ts * 1000 >= cutoff);
      const last = entry.ticks[entry.ticks.length - 1];
      if (last) entry.lastFetchMs = Math.round(last.ts * 1000);
    } catch (err) {
      // 保留舊快取，下一輪再試——單次刷新失敗不該讓畫面上的資料整批消失。
      console.error(`[bookCache] refresh failed for ${coin}, keeping stale cache:`, err);
    }
  }

  /** 依幣種、時間窗回傳快取裡的逐筆快照，舊→新排序（跟原本 lib/db.ts 的 fetchTicks 介面一致）。 */
  getTicks(coin: string, sinceMs: number, limit: number): SnapshotTick[] {
    const entry = this.cache.get(coin.toUpperCase());
    if (!entry) return [];
    const filtered = entry.ticks.filter((t) => t.ts * 1000 >= sinceMs);
    return filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
  }

  /** 有資料的幣種清單 + 各自最新一筆快照（跟原本 fetchCoinSummaries 介面一致）。 */
  getCoinSummaries(sinceMs: number): CoinSummary[] {
    const out: CoinSummary[] = [];
    for (const [coin, entry] of this.cache) {
      if (entry.ticks.length === 0) continue;
      const rowCount1h = entry.ticks.filter((t) => t.ts * 1000 >= sinceMs).length;
      out.push({ coin, latest: entry.ticks[entry.ticks.length - 1], rowCount1h });
    }
    out.sort((a, b) => b.latest.ts - a.latest.ts);
    return out;
  }
}

const g = globalThis as unknown as { __bookCache?: BookCache };
export const bookCache = g.__bookCache ?? new BookCache();
g.__bookCache = bookCache;
