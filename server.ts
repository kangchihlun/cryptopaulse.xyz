/**
 * server.ts — 自訂 Node.js server：先 `app.prepare()` 把 Next.js 準備好，
 * 同一個 http.Server 上同時掛：
 *   1. Next.js 自己的 request handler（一般網頁請求 + API routes）
 *   2. Next.js 自己的 HMR websocket（dev 模式的 /_next/webpack-hmr，透過
 *      `app.getUpgradeHandler()` 轉發，不然自訂 server 下 HMR 會斷線重連）
 *   3. 我們自己的 WebSocket server（/ws/momentum）：把 lib/marketState.ts
 *      即時監聽幣安主動買賣算出的指標，用 push 的方式推給前端，取代原本
 *      MomentumPanel.tsx 每 4 秒 fetch("/api/momentum") 的 polling。
 *   4. 另一個 WebSocket server（/ws/orderbook）：把 lib/perplOrderbook.ts
 *      訂閱 Perpl BTC 訂單簿的前 20 檔 bid/ask 轉播給前端，給
 *      components/Heatmap.tsx 疊加 orderbook ladder 用（Perpl 的 market-data
 *      WS 會依 Origin header 擋非 app.perpl.xyz 的連線，瀏覽器不能直接訂閱，
 *      只能由這支後端訂閱再轉播——見 lib/perplOrderbook.ts 檔頭說明）。
 *
 * marketState.start() 在這裡（server 啟動的當下、prepare 完成後）直接呼叫一次
 * ——這是唯一一個保證跑得到、且只跑一次的地方，所以拿掉了原本 instrumentation.ts
 * 那個「保險」寫法（custom server 架構下已經不需要那層保險）。
 *
 * bookCache.start() 也在這裡呼叫，而且是 `await`（阻塞 server.listen()）：
 * 先把 Postgres BookSnapshot 最近 24 小時的歷史撈進記憶體，/api/ticks、
 * /api/coins 才有資料可以立刻回——不用等第一個 request 進來才臨時現查 DB。
 *
 * 執行方式：`tsx server.ts`（dev 用 `tsx watch server.ts`）而不是 `next dev`/
 * `next start`——package.json 的 scripts 已經改過來了。custom server 是 Node.js
 * 長駐進程才能用的架構，部署在 Vercel serverless 上跑不動；這個專案本來就假設
 * 跑在 Railway/自架這種長駐 Node 環境（instrumentation.ts 那版也是同樣假設）。
 */
import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { marketState } from "./lib/marketState";
import { bookCache } from "./lib/bookCache";
import { perplOrderbook } from "./lib/perplOrderbook";
import { closePool } from "./lib/db";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;
const MOMENTUM_WS_PATH = "/ws/momentum";
const ORDERBOOK_WS_PATH = "/ws/orderbook";
// 前端輪詢原本是 4 秒一次；改成 push 後可以稍微更即時一點，但也不用逼近
// 幣安 trade 事件的頻率（那樣浪費頻寬）——1 秒一次夠「即時」也夠省。
const BROADCAST_INTERVAL_MS = 1000;
// orderbook ladder 是疊圖用的即時快照，比動能指標更想要「順」一點的更新頻率，
// 20 檔資料量還是很小，500ms 一次不算浪費頻寬。
const ORDERBOOK_BROADCAST_INTERVAL_MS = 500;

const app = next({ dev });
const handle = app.getRequestHandler();

function momentumPayload() {
  return JSON.stringify({ type: "momentum", coins: marketState.getAll(), servedAt: Date.now() });
}

function orderbookPayload() {
  const { bids, asks } = perplOrderbook.getTopLevels(20);
  return JSON.stringify({ type: "orderbook", coin: "BTC", bids, asks, servedAt: Date.now() });
}

async function main() {
  await app.prepare();
  // 先把 Postgres BookSnapshot 最近 24h 的歷史拿進記憶體，再開始 serve——
  // 見 lib/bookCache.ts。這一步是 await（會讓啟動多花幾秒），刻意設計成
  // 阻塞：不要讓第一批打進來的 /api/ticks 請求撲空。
  await bookCache.start();
  // 開始訂閱幣安（每個幣種各自的 WS + REST 輪詢），資料收進 marketState 的
  // 記憶體陣列/物件快取——見 lib/marketState.ts、lib/binanceFeed.ts。這個不用
  // 等，幣安 WS 連線建立跟暖機本來就是漸進式的，先讓網站服務起來。
  marketState.start();
  // 開始訂閱 Perpl BTC 訂單簿——見 lib/perplOrderbook.ts，同樣不用等。
  perplOrderbook.start();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "/", true);
    handle(req, res, parsedUrl);
  });

  // 2026-09-05 實測踩到的坑：`new WebSocketServer({server, path})` 這種自動掛載
  // 模式，`ws` 內部會直接把自己的 upgrade listener 掛上 server——一旦 path
  // 對不上，它不是「放給別的 listener 處理」，是直接 `abortHandshake(socket, 400)`
  // 把 socket 砍掉（讀了 ws 原始碼 handleUpgrade()/shouldHandle() 確認的，不是
  // 猜的）。兩個 WebSocketServer 都用這種模式掛在同一個 server 上時，先註冊的
  // 那個只要 path 對不上就會搶先把請求砍掉，後面的 listener（包含轉給 Next.js
  // HMR 用的那個）根本輪不到——實測 /ws/orderbook 直接收到 400，且這代表
  // dev 模式的 Next.js HMR websocket（/_next/webpack-hmr）從一開始也一直被
  // momentum 這個 WebSocketServer 誤殺，只是先前沒有真的用瀏覽器測過 HMR
  // 重連才沒發現。正確做法（ws README 也是這樣寫的）：兩個都用 `noServer:true`，
  // 自己在唯一一個 upgrade handler 裡依 path 手動分派。
  const momentumWss = new WebSocketServer({ noServer: true });
  const momentumClients = new Set<WebSocket>();

  momentumWss.on("connection", (ws) => {
    momentumClients.add(ws);
    // 一連上就先推一次目前快照，不用等下一輪 broadcast tick 才有資料。
    ws.send(momentumPayload());
    ws.on("close", () => momentumClients.delete(ws));
    ws.on("error", () => momentumClients.delete(ws));
  });

  const broadcastTimer = setInterval(() => {
    if (momentumClients.size === 0) return;
    const payload = momentumPayload();
    for (const ws of momentumClients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }, BROADCAST_INTERVAL_MS);

  const orderbookWss = new WebSocketServer({ noServer: true });
  const orderbookClients = new Set<WebSocket>();

  orderbookWss.on("connection", (ws) => {
    orderbookClients.add(ws);
    ws.send(orderbookPayload());
    ws.on("close", () => orderbookClients.delete(ws));
    ws.on("error", () => orderbookClients.delete(ws));
  });

  const orderbookBroadcastTimer = setInterval(() => {
    if (orderbookClients.size === 0) return;
    const payload = orderbookPayload();
    for (const ws of orderbookClients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }, ORDERBOOK_BROADCAST_INTERVAL_MS);

  // 唯一一個 upgrade handler，依 path 手動分派給對應的 WebSocketServer（或轉給
  // Next.js 自己的 HMR handler）——不再依賴 ws 的自動掛載模式。
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url || "/", true);
    if (pathname === MOMENTUM_WS_PATH) {
      momentumWss.handleUpgrade(req, socket, head, (ws) => momentumWss.emit("connection", ws, req));
    } else if (pathname === ORDERBOOK_WS_PATH) {
      orderbookWss.handleUpgrade(req, socket, head, (ws) => orderbookWss.emit("connection", ws, req));
    } else {
      void app.getUpgradeHandler()(req, socket, head);
    }
  });

  // 2026-09-05 實測踩到的坑：這裡原本沒有真的關掉 marketState 的幣安 WS 連線／
  // 內部 setInterval、bookCache 的背景刷新 timer、Postgres pool——這些 handle
  // 沒收乾淨會讓 event loop 一直有活動，`tsx watch` 偵測不到 process 真的結束，
  // 使用者 Ctrl+C 或存檔觸發重啟時卡住變成殭屍 process，最後只能 `kill -9`。
  // 現在改成：保底的強制退出計時器最先排上（哪怕後面任何一步清理拋例外，
  // 也保證會在很短時間內真的結束），同時也確實呼叫每個模組的 stop()，讓
  // 大多數情況走乾淨關閉而不是每次都硬等到 timeout。shutdownStarted 擋
  // SIGTERM/SIGINT 疊加觸發時重複跑。
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log("[server] shutting down…");
    // 保底最先排：不管下面哪一步出錯，1.5 秒後一定強制退出（tsx watch 觀察到
    // 的耐心大約 5 秒，這裡抓遠短於它，避免又卡成殭屍 process）。
    const forceExit = setTimeout(() => {
      console.log("[server] cleanup didn't finish in time, forcing exit");
      process.exit(0);
    }, 1500);
    forceExit.unref();

    try {
      clearInterval(broadcastTimer);
      clearInterval(orderbookBroadcastTimer);
    } catch (err) {
      console.error("[server] error clearing broadcast timers:", err);
    }
    try {
      momentumWss.close();
      orderbookWss.close();
    } catch (err) {
      console.error("[server] error closing WebSocketServers:", err);
    }
    try {
      marketState.stop();
    } catch (err) {
      console.error("[server] error stopping marketState:", err);
    }
    try {
      bookCache.stop();
    } catch (err) {
      console.error("[server] error stopping bookCache:", err);
    }
    try {
      perplOrderbook.stop();
    } catch (err) {
      console.error("[server] error stopping perplOrderbook:", err);
    }
    void closePool().catch((err) => console.error("[server] error closing pg pool:", err));

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, () => {
    console.log(
      `> Ready on http://localhost:${port} (custom server, WS at ${MOMENTUM_WS_PATH} + ${ORDERBOOK_WS_PATH})`
    );
  });
}

main().catch((err) => {
  console.error("[server] fatal error during startup:", err);
  process.exit(1);
});
