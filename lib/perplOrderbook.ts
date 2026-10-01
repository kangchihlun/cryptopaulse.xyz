/**
 * lib/perplOrderbook.ts — TS 移植 Python 版 PerplMarketData 的
 * 訂單簿訂閱邏輯（目前只做 BTC），給熱圖的 orderbook ladder 疊圖用。
 *
 * 為什麼不在前端直接訂閱：實測發現
 * Perpl 的 market-data WS（wss://app.perpl.xyz/ws/v1/market-data）會依 Origin
 * header 擋非 app.perpl.xyz 的連線（帶假 Origin 連線直接回 403；不帶 Origin
 * 或帶 app.perpl.xyz 自己的 Origin 才連得上）。瀏覽器發出的 WS 連線一定會帶
 * 頁面真實的 Origin，且無法被頁面 JS 偽造或省略，所以「前端直接訂閱」在技術上
 * 不可能——改成跟幣安那條路一樣：由這支 Node.js 後端訂閱（server-side 的 ws
 * client 預設不送 Origin header，實測連得上），再透過 server.ts 開的
 * /ws/orderbook 轉播給前端，見 components/Heatmap.tsx 的 orderbook ladder。
 *
 * 協定細節（BTC market_id=1、price_decimals=1、size_decimals=5，查
 * GET https://app.perpl.xyz/api/v1/pub/context 得到，寫死不用另外查
 * context——BTC 這個市場設定幾乎不會變，省一次啟動時的額外 REST 請求）：
 *   1. 連線後送 {mt:5, subs:[{stream:"heartbeat@143",subscribe:true},
 *      {stream:"order-book@1",subscribe:true}]}
 *   2. mt:6 SubscriptionResponse 把 sid 對應回訂閱的 stream
 *   3. mt:15 L2BookSnapshot＝整本（先清空再套用），mt:16 L2BookUpdate＝差異
 *      （o:0 或 s:0 代表移除該價位）；價格/數量都是 scaled 整數，除以
 *      10^decimals 還原成人類單位
 * 跟 Python 版一致的重連安全措施：每次重連都先清空 sid/book 狀態（2026-08-25
 * 那次「重連成功但 mid 凍結」的事故就是舊連線狀態沒清乾淨），另外加閒置看門狗
 * （太久沒有任何訊息／太久沒有任何 L2 更新都強制重連）。
 */
import WebSocket from "ws";

const WS_URL = "wss://app.perpl.xyz/ws/v1/market-data";
const CHAIN_ID = 143; // mainnet
const BTC_MARKET_ID = 1;
const PRICE_SCALE = 10 ** 1; // price_decimals=1
const SIZE_SCALE = 10 ** 5; // size_decimals=5

const MT_SUBSCRIPTION_REQUEST = 5;
const MT_SUBSCRIPTION_RESPONSE = 6;
const MT_L2_BOOK_SNAPSHOT = 15;
const MT_L2_BOOK_UPDATE = 16;

const RECV_IDLE_MS = 30_000; // 太久沒收到任何訊息（含心跳）視為斷線
const BOOK_IDLE_MS = 20_000; // 連線活著但太久沒有任何 L2 更新視為斷線
const RECONNECT_DELAY_MS = 2000;
const IDLE_CHECK_INTERVAL_MS = 5000;

export interface OrderbookLevel {
  price: number;
  size: number;
}

interface SubscriptionResponseMsg {
  mt: number;
  subs?: { stream?: string; sid?: number }[];
}

interface L2BookMsg {
  mt: number;
  sid?: number;
  bid?: { p?: number; s?: number; o?: number }[];
  ask?: { p?: number; s?: number; o?: number }[];
}

class PerplOrderbookManager {
  private bids = new Map<number, number>(); // price_scaled -> size_scaled
  private asks = new Map<number, number>();
  private sid: number | null = null;
  private connected = false;
  private lastMessageAt = 0;
  private lastBookUpdateAt = 0;
  private started = false;
  private stopped = false;
  private ws: WebSocket | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  /** process 收尾用：關掉連線、停止重連跟看門狗計時器。 */
  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 目前整本的前 depth 檔；bid 由高到低、ask 由低到高（跟 Python 版 top_levels() 一致）。 */
  getTopLevels(depth = 20): { bids: OrderbookLevel[]; asks: OrderbookLevel[] } {
    const bidEntries = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, depth);
    const askEntries = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, depth);
    return {
      bids: bidEntries.map(([p, s]) => ({ price: p / PRICE_SCALE, size: s / SIZE_SCALE })),
      asks: askEntries.map(([p, s]) => ({ price: p / PRICE_SCALE, size: s / SIZE_SCALE })),
    };
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      // 🔴 每次連線都從乾淨狀態開始（見檔頭說明的 2026-08-25 事故教訓）：
      // 舊連線的 sid/book 殘留會讓新連線初期的訊息被套到錯的狀態上。
      this.sid = null;
      this.bids.clear();
      this.asks.clear();
      const now = Date.now();
      this.lastMessageAt = now;
      this.lastBookUpdateAt = now;

      ws.send(
        JSON.stringify({
          mt: MT_SUBSCRIPTION_REQUEST,
          subs: [
            { stream: `heartbeat@${CHAIN_ID}`, subscribe: true },
            { stream: `order-book@${BTC_MARKET_ID}`, subscribe: true },
          ],
        })
      );
      console.log("[perplOrderbook] connected + subscribed BTC order-book");
      this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS);
    });

    ws.on("message", (raw) => {
      try {
        this.handleMessage(raw.toString());
      } catch (err) {
        console.error("[perplOrderbook] message parse error:", err);
      }
    });

    ws.on("close", () => {
      this.connected = false;
      if (this.idleTimer) clearInterval(this.idleTimer);
      this.idleTimer = null;
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    ws.on("error", (err) => {
      console.error("[perplOrderbook] ws error:", err.message);
      ws.close();
    });
  }

  private checkIdle(): void {
    const now = Date.now();
    if (now - this.lastMessageAt > RECV_IDLE_MS || now - this.lastBookUpdateAt > BOOK_IDLE_MS) {
      console.warn("[perplOrderbook] idle timeout, forcing reconnect");
      this.ws?.terminate();
    }
  }

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as SubscriptionResponseMsg & L2BookMsg;
    this.lastMessageAt = Date.now();

    if (msg.mt === MT_SUBSCRIPTION_RESPONSE) {
      for (const s of msg.subs || []) {
        if (typeof s.stream === "string" && s.stream.startsWith("order-book@") && s.sid != null) {
          this.sid = s.sid;
        }
      }
      return;
    }
    if (msg.mt !== MT_L2_BOOK_SNAPSHOT && msg.mt !== MT_L2_BOOK_UPDATE) return;
    if (this.sid == null || msg.sid !== this.sid) return; // 訂閱回應還沒到之前的極短窗口，丟掉

    if (msg.mt === MT_L2_BOOK_SNAPSHOT) {
      this.bids.clear();
      this.asks.clear();
    }
    this.applyLevels(this.bids, msg.bid);
    this.applyLevels(this.asks, msg.ask);
    this.lastBookUpdateAt = Date.now();
  }

  private applyLevels(book: Map<number, number>, levels: { p?: number; s?: number; o?: number }[] | undefined): void {
    for (const lvl of levels || []) {
      const p = lvl.p;
      if (p == null) continue;
      if (lvl.o === 0 || !lvl.s) {
        book.delete(p);
      } else {
        book.set(p, lvl.s);
      }
    }
  }
}

const g = globalThis as unknown as { __perplOrderbook?: PerplOrderbookManager };
export const perplOrderbook = g.__perplOrderbook ?? new PerplOrderbookManager();
g.__perplOrderbook = perplOrderbook;
