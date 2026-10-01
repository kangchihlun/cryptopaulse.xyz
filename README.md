# CryptoPulse Monitor

Next.js（App Router + TypeScript + Tailwind）即時監控站，讀 `perpl_snapshot_collector.py`
（`perpl-single-hardcap-compare` 分支，`Dockerfile.snapshot` 獨立 Railway service）寫進
Postgres 的 orderbook 快照，視覺化成漸層熱圖 + 多幣種動量比較。詳細需求見 [`SPEC.md`](./SPEC.md)。

## 執行

```bash
npm install
npm run dev   # http://localhost:3000 — 自訂 Node.js server（server.ts），不是 `next dev`
```

**這個專案不能用 `next dev`/`next start` 跑**——`npm run dev`/`npm run start` 實際跑的是
`tsx server.ts`（見下方「即時推播」）：一個自訂 Node.js server，`app.prepare()` 把 Next.js
準備好之後，同一個 http.Server 上同時掛 Next.js 的 request handler + HMR websocket +
我們自己的 `/ws/momentum` WebSocket server。這代表：
- 一定要是長駐 Node.js 進程（Railway/自架都可以），**不能部署在 Vercel serverless**
  （custom server 架構本來就跟 serverless function 互斥）。
- `npm run build` 還是原本的 `next build`，跟 custom server 無關（`server.ts` 是用
  `tsx` 直接執行，不經過 Next 自己的 webpack/turbopack 打包）。
- Dev 模式跑完 `next build` 之後如果又跑過 `npm run dev`，`.next` 會被 dev 模式的
  產物弄髒，`npm run start` 會報 "Could not find a production build"——要 `rm -rf .next`
  重新 `npm run build` 一次才能再用 `npm run start`。

## 環境變數（`.env` / `.env.local`）

```
POSTGRES_URL="postgresql://..."   # Railway Postgres，跟收集端共用同一個資料庫
TABLE_NAME="BookSnapshot"         # 收集端實際寫入的表名（見下方「資料來源」）
```

`.env` 已含目前可用的連線字串（gitignored，不會進版控）。

## 部署到 Railway

- **Root Directory** 留空（repo 根目錄就是這個服務）。
- **Dockerfile Path** 設成 `dockerfile_web`。多階段 build：第一階段裝完整依賴（含 devDependencies）
  跑 `next build`，第二階段只裝 production 依賴 + 複製 `.next` 編譯產物 + `server.ts`
  跟它需要的 `lib/` 原始碼（custom server 用 `tsx` 在 runtime 直接轉譯執行，不是
  `next start`，所以 runtime image 需要原始碼而不只是編譯產物）。
- **Variables**：把 `.env` 裡的 `POSTGRES_URL`、`TABLE_NAME` 一模一樣設進 Railway 的
  Variables 分頁——`.env` 本身被 `.dockerignore` 排除、不會進 Docker image，Railway
  完全讀不到這個檔案，一定要手動在那邊設一份。`PORT`/`NODE_ENV` 不用設，Railway 會
  自己注入 `PORT`，`dockerfile_web` 裡已經 `ENV NODE_ENV=production`。
- Container 收到 SIGTERM（Railway 重部署/停止服務）時，`server.ts` 會在 ~1.5 秒內
  乾淨退出（見上面「執行」的說明跟下方即時推播段落）；`dockerfile_web` 的 `CMD`
  直接 exec `tsx`（不是 `npm run start`），避免 npm 包一層對訊號轉發不可靠的問題。

## 資料來源——兩條完全獨立的管線

這個站現在混合兩種資料來源，**分別對應不同頁面區塊，互不依賴**：

### 1. Orderbook 熱圖（Perpl，讀 Postgres）

`perpl_snapshot_collector.py` + `libs/feeds.py`（`perpl-single-hardcap-compare` 分支，
**不是** `perpl-single`）持續把 Perpl orderbook 快照批次寫進 Postgres 表 `"BookSnapshot"`
（大小寫混合，SQL 需雙引號；schema 沿用 `tests/perpl/trade_cache.py` 的
`TradeCache`：`kind='signal_snapshot'`、`ts`(ms)、`raw`(JSONB)）。`lib/db.ts` 是最底層
的 Postgres 查詢函式（`fetchTicks`/`fetchCoinSummaries`/`fetchPriceNear`）。

2026-09-05 起，`app/page.tsx`、`/api/ticks`、`/api/coins` **不再直接查 Postgres**，改讀
`lib/bookCache.ts` 的記憶體快取，`server.ts` 啟動時（`app.prepare()` 之後、
`server.listen()` 之前）分兩階段預載：

1. **阻塞階段**——先 `await` 把每個幣種「過去 30 分鐘」的歷史撈進記憶體，`server.listen()`
   等這一步做完才放行。30 分鐘覆蓋熱圖預設/最常用的時窗，一次抓一天份（BTC 一天約
   6~9 萬筆）反而會拖慢開機（實測差在 ~1.5 秒 vs 好幾秒）。
2. **背景階段**——`start()` 回傳之後（server 已經在 serve 了）繼續把每個幣種往回補到
   完整 24 小時的保留窗（熱圖最長的時窗選項就是 24h），不擋任何 request；補完之前
   2h/12h/24h 這種較長時窗看到的資料會比較少，補完後下一次前端輪詢自動變完整。

之後背景每分鐘刷新一次（只補新資料，刷新失敗會保留舊快取、不會讓畫面資料整批消失）。
好處：多個瀏覽器分頁同時開著也只打一次 DB，而且 server 剛啟動、還沒開始 serve 就已經
有資料可以回，不會出現「剛開機時熱圖顯示沒資料」的空窗期。`/api/price-ref`（算 24h
漲跌幅用的參考價）維持直接查 DB，沒有走快取——那是低頻查詢，快取的複雜度不划算。
餵給 `components/Heatmap.tsx` 的 `raw` 欄位：

| 欄位 | 說明 |
|---|---|
| `ts` | epoch seconds |
| `coin` | 幣種代碼 |
| `depth` | 這筆快照取樣的深度檔數（目前收集 = 3） |
| `bid_usd` / `ask_usd` | 前 `depth` 檔加總美金深度 |
| `bid1_usd` / `ask1_usd` | 第一檔（頂檔）美金深度 |
| `bids_detail` / `asks_detail` | 逐檔 `[price, size]`，由頂檔到最差價 |
| `ask_over_bid` / `bid_over_ask` | 深度比 |
| `momentum_bias` | collector 端算好的 -100~+100 動能綜合分（不影響本站，僅供 `/coin/[symbol]` 明細表對照參考） |
| `perpl_mid` / `binance_mid` / `basis_bps` | 兩所中價與價差(bps) |

**已知落差**：SPEC 設想熱圖 Y 軸涵蓋上下 25 檔，實際收集 `depth=3`（`Heatmap.tsx`
用連續 bps 分桶而非離散檔位索引，資料變豐富時前端不用改，但要看到 25 檔解析度
需要把 `PERPL_SNAPSHOT_DEPTH` 調大並重新部署 Railway——資料管線端的事）。

### 2. 動量比較面板（Binance，即時監聽，不查 DB）

`components/MomentumPanel.tsx` **完全不讀 Postgres**。改成 TS 直接移植
`libs/feeds.py` + `libs/indicators.py`（同一個 `perpl-single-hardcap-compare` 分支）：

- `lib/binanceFeed.ts` — 對每個幣種各開一條 Binance WS（`<symbol>@trade` +
  `<symbol>@kline_1m` 合併訂閱），逐筆存 `isBuy`（`!isBuyerMaker`，即主動買方）；
  REST 輪詢現貨 order book 當備援。跟 Python 版一樣斷線 5 秒後原地重連。
- `lib/indicators.ts` — 逐函式移植 `obi/walls/cvd/rsi/macd/vwap/emas/heikinAshi/
  volProfile/biasScore/scoreTrend`，常數照抄 `libs/config.py`。跟原本只存
  折算後單一 `momentum_bias` 不同：這裡**每個指標分開回傳**（`computeBreakdown()`），
  MomentumPanel 也分開顯示，另外還直接拆開「主動買/主動賣」的原始美金量與筆數
  （`activeBuySell5m`），不只是折算成 CVD 的正負號。
- `lib/marketState.ts` — process 內單例，管理全部幣種的 runtime state + 5 秒一次的
  bias 歷史取樣（給 sparkline 用）。由 `server.ts` 在 `app.prepare()` 完成後直接呼叫
  一次 `start()`；`/api/momentum` 也會保險呼叫一次（`started` 旗標擋重複，不會重開
  連線）。`globalThis` 掛載避免 Next.js dev 模式熱重載時開出孤兒 WS 連線。

### 即時推播：`/ws/momentum`（取代原本 polling）

2026-09-05 之前 `MomentumPanel.tsx` 是每 4 秒 `fetch("/api/momentum")` 拉一次；現在
`server.ts` 開了一條 WebSocket（path `/ws/momentum`），每 1 秒把 `marketState.getAll()`
的最新快照 broadcast 給所有連線的瀏覽器，前端一開頁面就連線、被動接收 push，不用自己
排程重複請求。連線一建立會先收到一筆當下快照（不用等下一輪 broadcast），斷線 3 秒後
前端自動重連。`/api/momentum` 這條 REST route 還留著給手動除錯用（`curl` 一下看資料
長什麼樣），面板本身已經不呼叫它。

熱圖／coin detail 頁的 Postgres 資料（本來就有 collector 端最長 60 分鐘的批次寫入延遲，
見上面「已知落差」）維持原本的 REST polling，沒有改成 WS——即時推播對一個本來就有
分鐘級延遲的資料源沒有意義，這次只換了真正即時（幣安 WS 秒級更新）的動量面板。

**幣種覆蓋**：`libs/config.py` 的 `BINANCE_SYMBOL` 只放 BTC（該分支只交易 BTC，
沒理由訂閱別的）。這裡為了多幣種比較，比照命名慣例補了 `tests/perpl/perpl_common.py`
`COINS` 其餘 5 幣種——**實測 HYPEUSDT、MONUSDT 在 Binance 現貨回 `Invalid symbol.`**
（HYPE/MON 目前沒有 Binance 現貨對應盤可比對），BTC/ETH/SOL/ZEC 這 4 個正常運作。
面板上 HYPE/MON 會顯示「無資料」而不是讓整個 process 掛掉或誤植假資料。

### Orderbook Ladder：`/ws/orderbook`（Perpl BTC 訂單簿即時疊圖）

`components/Heatmap.tsx` 疊上 Perpl BTC 訂單簿前 20 檔的階梯狀線段（orderbook
ladder），經典 depth chart 造型：X 軸＝價格，bid 固定用左半畫布（最佳價位在
`centerX`、第 20 檔剛好落在 `x-min`）、ask 固定用右半畫布（最佳價位在
`centerX`、第 20 檔剛好落在 `x-max`）；Y 軸＝累計深度，基準線（累計量 0，
最佳價位）在畫布底部（`y-max`），往上長到頂（`y-min`）——中間低、兩側高。
兩邊各自用自己的價差跟總量正規化到滿版寬高，不共用同一把尺，確保深度小的
那一側也不會縮在角落看不清楚。

**2026-09-05 查證：這個不能像原本想的那樣在瀏覽器端直接訂閱**——實測 Perpl 的
market-data WS（`wss://app.perpl.xyz/ws/v1/market-data`）會依 `Origin` header
擋非 `app.perpl.xyz` 的連線（帶假 Origin 連線直接收到 403；不帶或帶
`app.perpl.xyz` 自己的 Origin 才連得上）。瀏覽器發出的 WS 連線一定會帶頁面真實
的 Origin，且無法被頁面 JS 偽造或省略，所以只能跟幣安那條路一樣：由
`lib/perplOrderbook.ts`（這支後端，Node.js 的 WS client 預設不送 Origin header）
訂閱，`server.ts` 開 `/ws/orderbook` 每 500ms 轉播給前端。目前只做 BTC（Perpl
`market_id=1`、`price_decimals=1`、`size_decimals=5`，查
`GET /v1/pub/context` 得到後寫死，這個市場設定幾乎不會變）。

實作上 ladder 畫在**獨立的透明疊圖 canvas**（`ladderCanvasRef`），蓋在熱圖本體
上面，不管底下是 WebGPU（`renderGpu`，現代瀏覽器的主路徑）還是 canvas2D 備援
在畫都蓋得到——WebGPU 沒有現成的 2D `strokeStyle`/`lineTo`/`fill` API，硬要在
render pipeline 裡另外做線段幾何既複雜又難在沒有瀏覽器的環境驗證對不對，疊一張
透明 canvas2D 上去是業界常見、風險低很多的做法。副作用是 ladder 的重繪（跟著
`/ws/orderbook` 的 500ms 推播）完全獨立於熱圖本體那份較重的重新計算，兩者互不
拖累。

## 頁面

- `/` — Dashboard：可切換幣種/時間窗的 Perpl 熱圖（讀 DB）+ 全幣種動量比較面板（即時 Binance WS，不讀 DB）
- `/coin/[symbol]` — 單一幣種深度分析：更大的熱圖、collector 算好的 bias/basis 走勢、最近 20 筆明細表（讀 DB）

## API

- `GET /api/ticks?coin=BTC&minutes=30&limit=20000` — Perpl orderbook 逐筆快照（讀 DB，舊→新）
- `GET /api/coins?minutes=60` — 各幣種最新 Perpl 快照 + 過去 N 分鐘筆數（讀 DB）
- `GET /api/price-ref?coin=BTC&hoursAgo=24` — 最接近某個時間點之前的參考價（算漲跌幅用）
- `GET /api/momentum` — 全幣種即時指標拆解（讀 process 內存，不查 DB；手動除錯用，
  MomentumPanel.tsx 本身走 `/ws/momentum` 不呼叫這條）
- `WS /ws/momentum` — 每秒 broadcast 全幣種即時指標拆解，MomentumPanel.tsx 的真正資料來源
- `WS /ws/orderbook` — 每 500ms broadcast Perpl BTC 訂單簿前 20 檔 bid/ask，Heatmap.tsx
  的 orderbook ladder 疊圖用
