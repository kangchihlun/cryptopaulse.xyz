"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotTick } from "@/lib/db";
import { COLORS, hexToRgb } from "@/lib/theme";
import { HEATMAP_WGSL, HEATMAP_INSTANCE_STRIDE_FLOATS } from "@/lib/heatmapShader";
import { buildFootprint, type FootprintModel } from "@/lib/footprint";
import { BOTTOM_STRIP_PX, TARGET_ROW_PX, computeLayout, sizeCanvas, type Layout } from "@/lib/heatmapLayout";
import { drawFootprintOverlay } from "@/lib/footprintOverlay";

// 背景基準色（跟 --bg 一致）跟 bull/bear 目標色的 RGB 差值，canvas2D 備援路徑
// 逐像素上色時用 base + k*delta 線性插值——只算一次，不要在每個像素都重新
// parse hex。WebGPU 路徑則直接把 bull/bear 轉成 0..1 float RGB 傳進 shader。
const BG_RGB = hexToRgb(COLORS.bg);
const BULL_RGB = hexToRgb(COLORS.bull);
const BEAR_RGB = hexToRgb(COLORS.bear);
const BULL_DELTA: [number, number, number] = [
  BULL_RGB[0] - BG_RGB[0],
  BULL_RGB[1] - BG_RGB[1],
  BULL_RGB[2] - BG_RGB[2],
];
const BEAR_DELTA: [number, number, number] = [
  BEAR_RGB[0] - BG_RGB[0],
  BEAR_RGB[1] - BG_RGB[1],
  BEAR_RGB[2] - BG_RGB[2],
];
const BULL_RGB01: [number, number, number] = [BULL_RGB[0] / 255, BULL_RGB[1] / 255, BULL_RGB[2] / 255];
const BEAR_RGB01: [number, number, number] = [BEAR_RGB[0] / 255, BEAR_RGB[1] / 255, BEAR_RGB[2] / 255];
const BG_RGB01: [number, number, number] = [BG_RGB[0] / 255, BG_RGB[1] / 255, BG_RGB[2] / 255];

// 點的基準半徑（CSS px，會再乘上 dpr）；vgpu.sh 那組衰減常數（95/18）在 quad
// 局部座標裡衰減得很快，半徑要夠大才看得出「亮核心 + 柔和外暈」的形狀。
const POINT_RADIUS_PX = 22;

interface HeatmapProps {
  ticks: SnapshotTick[];
  height?: number;
  bucketMinutes?: number; // 一根 K 棒多長，預設 15 分鐘
}

interface OrderbookLevel {
  price: number;
  size: number;
}

/** server.ts 的 /ws/orderbook 轉播（見 lib/perplOrderbook.ts）。bids 高到低、asks 低到高。 */
interface OrderbookLadder {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

interface GpuState {
  context: GPUCanvasContext;
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer;
  format: GPUTextureFormat;
  instanceBuffer: GPUBuffer | null;
  instanceCapacity: number;
}

/**
 * 買賣壓熱圖 + 15 分鐘 K 棒 footprint：X 軸=時間（依 bucketMinutes 分欄）、
 * Y 軸=**絕對價格**。
 *
 * 熱圖本體（背景層）逐點用 WebGPU 點狀 glow render pipeline 畫（見
 * lib/heatmapShader.ts，演算法借用 vgpu.sh 首頁的 halo ring 雙高斯疊色手法），
 * additive blending：每個 bid/ask 檔位都各自畫一個點，重疊的地方直接加總亮度。
 * WebGPU 不支援/初始化失敗時整段退回 canvas2D 分桶繪製（renderCanvas2D()）。
 *
 * 疊在上面的是 lib/footprint.ts 聚合出來的 K 棒（perpl_mid 的 OHLC，真實價格
 * 走勢）以及每根棒子矩形內的掛單流格子（每個價格列的 bid × ask 掛單停駐量）。
 * ⚠️ 格子數字是**掛單壓力**不是成交量——collector 沒有落地逐筆成交，詳見
 * lib/footprint.ts 檔頭。
 *
 * 2026-09-12：Y 軸從「相對各自 mid 的 bps」換成絕對價格。舊畫法每筆快照都以
 * 自己的 mid 重新置中，價格走勢在圖上是隱形的，也就沒有辦法把 K 棒疊到同一個
 * 座標系；改成全視窗共用一把價格尺之後，散點會沿著價格走成一條流動性帶。
 */
export default function Heatmap({ ticks, height = 200, bucketMinutes = 15 }: HeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const ladderCanvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const deviceRef = useRef<GPUDevice | null>(null);
  const gpuRef = useRef<GpuState | null>(null);
  const [mode, setMode] = useState<"fallback" | "gpu">("fallback");
  const [ladder, setLadder] = useState<OrderbookLadder | null>(null);

  // Perpl 的 orderbook WS 只能由後端訂閱再轉播（見 lib/perplOrderbook.ts 檔頭
  // 說明：對方依 Origin header 擋非 app.perpl.xyz 的連線，瀏覽器連不上）。這裡
  // 開頁面就連 server.ts 開的 /ws/orderbook，斷線 3 秒自動重連——跟
  // MomentumPanel.tsx 連 /ws/momentum 同一套模式。目前後端只轉播 BTC。
  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (stopped) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/orderbook`);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "orderbook") setLadder({ bids: msg.bids ?? [], asks: msg.asks ?? [] });
        } catch {
          // 收到壞掉的 frame 就略過，等下一筆 broadcast。
        }
      };
      ws.onclose = () => {
        if (!stopped) retryTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  const bucketMs = bucketMinutes * 60_000;
  const model = useMemo(() => {
    const rowCount = Math.max(10, Math.min(48, Math.round((height - BOTTOM_STRIP_PX) / TARGET_ROW_PX)));
    return buildFootprint(ticks, bucketMs, rowCount);
  }, [ticks, bucketMs, height]);

  // 偵測 + 初始化 WebGPU 裝置——只做一次，不需要 canvas（device 建立跟畫布無關）。
  // 成功才把 mode 切到 "gpu"（觸發下面 render effect 換一顆全新的 <canvas> 掛
  // getContext('webgpu')；同一個 canvas 元素一旦 getContext('2d') 過就不能再
  // 拿去configure webgpu，所以兩種 mode 用 key 讓 React 各自掛一顆新 canvas）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!("gpu" in navigator)) return;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter || cancelled) return;
        const device = await adapter.requestDevice();
        if (cancelled) {
          device.destroy();
          return;
        }
        deviceRef.current = device;
        setMode("gpu");
      } catch (err) {
        console.warn("[Heatmap] WebGPU init failed, falling back to canvas2D:", err);
      }
    })();
    return () => {
      cancelled = true;
      deviceRef.current?.destroy();
      deviceRef.current = null;
      gpuRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || ticks.length === 0 || model.buckets.length === 0) return;
    const layout = computeLayout(wrap.clientWidth || 800, height);

    if (mode === "gpu" && deviceRef.current) {
      try {
        renderGpu(canvas, wrap.clientWidth || 800, height, layout, ticks, model, deviceRef.current, gpuRef);
        return;
      } catch (err) {
        console.warn("[Heatmap] WebGPU render failed, falling back to canvas2D:", err);
        setMode("fallback");
        return;
      }
    }
    renderCanvas2D(canvas, wrap.clientWidth || 800, height, layout, ticks, model);
  }, [ticks, height, model, mode]);

  // K 棒 + footprint 疊圖：畫在獨立的透明 canvas 上（不管底下是 WebGPU 還是
  // canvas2D 在畫熱圖都蓋得到）。WebGPU 沒有現成的 2D 畫線/填字 API，硬要在
  // render pipeline 裡做文字幾何既複雜又難驗證；疊一張透明 canvas2D 是業界
  // 常見做法，也讓疊圖重繪完全不用碰熱圖本身那份較重的重新計算。
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const displayW = wrap.clientWidth || 800;
    const layout = computeLayout(displayW, height);
    sizeCanvas(canvas, displayW, height, layout);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (model.buckets.length === 0) return;
    drawFootprintOverlay(ctx, layout, model);
  }, [model, height]);

  // orderbook ladder 疊圖——另一張透明 canvas，畫即時盤口的累計深度剖面
  // （X=價格、Y=累計深度，跟熱圖本體的座標系不同，是獨立的輔助視圖）。
  useEffect(() => {
    const canvas = ladderCanvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const displayW = wrap.clientWidth || 800;
    const layout = computeLayout(displayW, height);
    sizeCanvas(canvas, displayW, height, layout);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 只有目前顯示的是 BTC 時才畫——後端 lib/perplOrderbook.ts 目前只訂閱
    // BTC，畫在別的幣種的熱圖上沒有意義。
    const coin = ticks[ticks.length - 1]?.coin;
    if (coin === "BTC" && ladder) {
      drawOrderbookLadder(ctx, layout, ladder);
    }
  }, [ticks, height, ladder]);

  const spanBps =
    model.priceMin > 0 ? ((model.priceMax - model.priceMin) / model.priceMin) * 1e4 : 0;

  return (
    <div ref={wrapRef} className="relative w-full">
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted mb-1">
        <span>
          {bucketMinutes}m candles · {model.buckets.length} bars
        </span>
        <span className="text-bull">Bid depth ■</span>
        <span className="text-bear">Ask depth ■</span>
        <span>Y: price ({spanBps.toFixed(0)} bps span)</span>
      </div>
      <div className="relative">
        <canvas
          key={mode}
          ref={canvasRef}
          height={height}
          className="w-full rounded-md border border-border block"
        />
        {/* K 棒 + footprint 疊圖（見上面的 overlay 專用 effect）。 */}
        <canvas ref={overlayCanvasRef} height={height} className="pointer-events-none absolute inset-0 w-full" />
        {/* orderbook ladder 疊圖——即時盤口累計深度剖面，獨立座標系。 */}
        <canvas ref={ladderCanvasRef} height={height} className="pointer-events-none absolute inset-0 w-full" />
      </div>
      <div className="flex items-center justify-between text-xs text-muted mt-1">
        <span>Cells: avg resting bid × ask (USD) per price row</span>
        <span>{mode === "gpu" ? "WebGPU" : "canvas2D"}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WebGPU 路徑
// ---------------------------------------------------------------------------

/** 把 ticks 攤平成 (centerNdc.xy, color.rgb, intensity, radiusScale) 的 instance 陣列。 */
function buildPointBuffer(ticks: SnapshotTick[], model: FootprintModel, layout: Layout): Float32Array {
  let maxUsd = 1;
  for (const t of ticks) {
    for (const [, size] of t.bids_detail) maxUsd = Math.max(maxUsd, size * t.perpl_mid);
    for (const [, size] of t.asks_detail) maxUsd = Math.max(maxUsd, size * t.perpl_mid);
  }
  const logMax = Math.log10(maxUsd + 1);

  let totalPoints = 0;
  for (const t of ticks) totalPoints += t.bids_detail.length + t.asks_detail.length;

  const stride = HEATMAP_INSTANCE_STRIDE_FLOATS;
  const out = new Float32Array(totalPoints * stride);
  let cursor = 0;

  // 繪圖區佔畫布的比例——右側刻度欄/底部標籤帶不畫散點。
  const fracX = layout.plotW / layout.cw;
  const fracY = layout.plotH / layout.ch;
  const tSpan = model.tEndMs - model.tStartMs || 1;
  const pSpan = model.priceMax - model.priceMin || 1;

  for (const t of ticks) {
    if (!t.perpl_mid) continue;
    // X：絕對時間（對齊 bucket 邊界的時間軸），不是 tick 索引——資料有缺口時
    // 圖上就真的會是缺口，不會被擠壓成連續的。
    const xFrac = (t.ts * 1000 - model.tStartMs) / tSpan;
    if (xFrac < 0 || xFrac > 1) continue;
    const xNdc = xFrac * fracX * 2 - 1;

    const push = (price: number, size: number, color: [number, number, number]) => {
      const yFrac = (price - model.priceMin) / pSpan;
      if (yFrac < 0 || yFrac > 1) return;
      // clip space y+ 朝上；繪圖區靠上（底部那條帶留給 delta/時間標籤）。
      const yNdc = 1 - 2 * fracY * (1 - yFrac);
      const usd = price * size;
      const intensity = (Math.log10(usd + 1) / logMax) * 0.3;
      const radiusScale = 0.55 + 0.45 * Math.sqrt(Math.max(0, Math.min(1, intensity)));
      out[cursor++] = xNdc;
      out[cursor++] = yNdc;
      out[cursor++] = color[0];
      out[cursor++] = color[1];
      out[cursor++] = color[2];
      out[cursor++] = intensity;
      out[cursor++] = radiusScale;
    };
    for (const [price, size] of t.bids_detail) push(price, size, BULL_RGB01);
    for (const [price, size] of t.asks_detail) push(price, size, BEAR_RGB01);
  }

  // push() 可能因超出範圍而略過一些點，實際寫入的 float 數會少於配置的 buffer
  // 大小——回傳一個精準裁切過的 view，呼叫端才知道真正的 instance 數。
  return out.subarray(0, cursor);
}

function ensureGpuState(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  gpuRef: React.MutableRefObject<GpuState | null>
): GpuState {
  if (gpuRef.current) return gpuRef.current;

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("canvas.getContext('webgpu') returned null");
  const format = navigator.gpu.getPreferredCanvasFormat();

  const module = device.createShaderModule({ code: HEATMAP_WGSL });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: HEATMAP_INSTANCE_STRIDE_FLOATS * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" }, // centerNdc
            { shaderLocation: 1, offset: 8, format: "float32x3" }, // color
            { shaderLocation: 2, offset: 20, format: "float32" }, // intensity
            { shaderLocation: 3, offset: 24, format: "float32" }, // radiusScale
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [
        {
          format,
          // 真正的 additive blending：重疊的點直接加總亮度，不是後畫蓋掉先畫的。
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  const uniformBuffer = device.createBuffer({
    size: 16, // vec2f resolution + f32 pointRadiusPx + f32 padding
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const state: GpuState = { context, pipeline, bindGroupLayout, uniformBuffer, format, instanceBuffer: null, instanceCapacity: 0 };
  gpuRef.current = state;
  return state;
}

function renderGpu(
  canvas: HTMLCanvasElement,
  displayW: number,
  height: number,
  layout: Layout,
  ticks: SnapshotTick[],
  model: FootprintModel,
  device: GPUDevice,
  gpuRef: React.MutableRefObject<GpuState | null>
) {
  sizeCanvas(canvas, displayW, height, layout);

  const state = ensureGpuState(canvas, device, gpuRef);
  state.context.configure({ device, format: state.format, alphaMode: "premultiplied" });

  const points = buildPointBuffer(ticks, model, layout);
  const instanceCount = points.length / HEATMAP_INSTANCE_STRIDE_FLOATS;

  if (!state.instanceBuffer || state.instanceCapacity < points.byteLength) {
    state.instanceBuffer?.destroy();
    // 抓寬一點的容量（+25%），避免資料量小幅波動時每次都重新配置 buffer。
    const capacity = Math.max(points.byteLength, Math.ceil(points.byteLength * 1.25));
    state.instanceBuffer = device.createBuffer({
      size: capacity,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    state.instanceCapacity = capacity;
  }
  if (instanceCount > 0) {
    device.queue.writeBuffer(state.instanceBuffer!, 0, points.buffer, points.byteOffset, points.byteLength);
  }

  device.queue.writeBuffer(
    state.uniformBuffer,
    0,
    new Float32Array([canvas.width, canvas.height, POINT_RADIUS_PX * layout.dpr, 0])
  );

  const bindGroup = device.createBindGroup({
    layout: state.bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: state.uniformBuffer } }],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: state.context.getCurrentTexture().createView(),
        clearValue: { r: BG_RGB01[0], g: BG_RGB01[1], b: BG_RGB01[2], a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  if (instanceCount > 0) {
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, state.instanceBuffer!);
    pass.draw(6, instanceCount);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
}

// ---------------------------------------------------------------------------
// canvas2D 備援路徑（WebGPU 不支援/初始化失敗時）——分桶取最大值的畫法。
// ---------------------------------------------------------------------------

function renderCanvas2D(
  canvas: HTMLCanvasElement,
  displayW: number,
  height: number,
  layout: Layout,
  ticks: SnapshotTick[],
  model: FootprintModel
) {
  const cols = Math.max(1, Math.min(ticks.length * 2, Math.floor(layout.plotW)));
  const rows = 200;
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const octx = off.getContext("2d", { willReadFrequently: true });
  if (!octx) return;
  const img = octx.createImageData(cols, rows);
  const data = img.data;

  let maxUsd = 1;
  for (const t of ticks) {
    for (const [, size] of t.bids_detail) maxUsd = Math.max(maxUsd, size * t.perpl_mid);
    for (const [, size] of t.asks_detail) maxUsd = Math.max(maxUsd, size * t.perpl_mid);
  }
  const logMax = Math.log10(maxUsd + 1);

  const bidGrid = new Float32Array(cols * rows);
  const askGrid = new Float32Array(cols * rows);

  const tSpan = model.tEndMs - model.tStartMs || 1;
  const pSpan = model.priceMax - model.priceMin || 1;

  for (const t of ticks) {
    if (!t.perpl_mid) continue;
    // GPU 路徑同一套座標：X=絕對時間、Y=絕對價格。
    const xFrac = (t.ts * 1000 - model.tStartMs) / tSpan;
    if (xFrac < 0 || xFrac > 1) continue;
    const c = Math.min(cols - 1, Math.max(0, Math.floor(xFrac * cols)));
    const bucket = (price: number, size: number, grid: Float32Array) => {
      const yFrac = (price - model.priceMin) / pSpan;
      if (yFrac < 0 || yFrac > 1) return;
      const row = Math.min(rows - 1, Math.max(0, Math.floor((1 - yFrac) * rows)));
      const usd = price * size;
      const intensity = Math.log10(usd + 1) / logMax;
      const idx = row * cols + c;
      grid[idx] = Math.max(grid[idx], intensity);
    };
    for (const [price, size] of t.bids_detail) bucket(price, size, bidGrid);
    for (const [price, size] of t.asks_detail) bucket(price, size, askGrid);
  }

  for (let i = 0; i < cols * rows; i++) {
    const bid = bidGrid[i];
    const ask = askGrid[i];
    const o = i * 4;
    if (bid <= 0.02 && ask <= 0.02) {
      data[o] = BG_RGB[0];
      data[o + 1] = BG_RGB[1];
      data[o + 2] = BG_RGB[2];
      data[o + 3] = 255;
    } else if (bid >= ask) {
      const k = bid;
      data[o] = BG_RGB[0] + k * BULL_DELTA[0];
      data[o + 1] = BG_RGB[1] + k * BULL_DELTA[1];
      data[o + 2] = BG_RGB[2] + k * BULL_DELTA[2];
      data[o + 3] = 255;
    } else {
      const k = ask;
      data[o] = BG_RGB[0] + k * BEAR_DELTA[0];
      data[o + 1] = BG_RGB[1] + k * BEAR_DELTA[1];
      data[o + 2] = BG_RGB[2] + k * BEAR_DELTA[2];
      data[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  sizeCanvas(canvas, displayW, height, layout);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  // 整塊先鋪底色（右側刻度欄/底部標籤帶也要有底），再把繪圖區的熱圖貼上去。
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, cols, rows, 0, 0, layout.plotW, layout.plotH);
}

// ---------------------------------------------------------------------------
// K 棒 + footprint 疊圖
// ---------------------------------------------------------------------------

/**
 * orderbook ladder：每檔 bid/ask 畫成階梯狀線段，畫在獨立的透明疊圖 canvas 上
 * （見 Heatmap() 元件裡的 ladderCanvasRef 專用 effect）。這是即時盤口的累計
 * 深度剖面，X 軸=價格（bid 在左半、ask 在右半）、Y 軸=累計深度（基準線在
 * 繪圖區底部往上長），跟熱圖本體的時間/價格座標系不同，是獨立的輔助視圖。
 */
function drawOrderbookLadder(ctx: CanvasRenderingContext2D, layout: Layout, ladder: OrderbookLadder) {
  const { bids, asks } = ladder;
  if (bids.length === 0 || asks.length === 0) return; // 還沒收到完整盤口，這輪不畫

  const { plotW, plotH, dpr } = layout;
  const centerX = plotW / 2;
  // 高度＝累計深度，基準線（cum=0，最佳價位）在繪圖區底部，往上長——中間
  // （最佳價位附近）低、兩側（最後一檔，目前是 server.ts 轉播的第 20 檔）高，
  // 經典 depth chart 的形狀。每邊各自用自己的總量正規化到滿版高度。這裡
  // 沒有寫死檔數，用 levels.length 動態算，之後 server.ts 要調檔數不用改這裡。
  const yOf = (cum: number, total: number) => plotH - (cum / (total || 1e-9)) * plotH;

  // 寬度＝價格，每邊各自用「最佳價位→最後一檔價位」的實際價差正規化，最後一檔
  // 剛好落在 x-min（bid）或 x-max（ask）——所以兩邊的價格刻度不共用同一把尺，
  // 各自撐滿自己那一半繪圖區。
  const xOfBid = (price: number, bestPrice: number, worstPrice: number) => {
    const span = bestPrice - worstPrice || 1e-9;
    const frac = Math.max(0, Math.min(1, (bestPrice - price) / span));
    return centerX - frac * centerX;
  };
  const xOfAsk = (price: number, bestPrice: number, worstPrice: number) => {
    const span = worstPrice - bestPrice || 1e-9;
    const frac = Math.max(0, Math.min(1, (price - bestPrice) / span));
    return centerX + frac * (plotW - centerX);
  };

  const drawSide = (levels: OrderbookLevel[], xOf: (price: number) => number, color: string) => {
    const total = levels.reduce((s, l) => s + l.size, 0);
    ctx.beginPath();
    ctx.moveTo(centerX, plotH); // 基準線：最佳價位、累計量 0
    let cum = 0;
    let lastX = centerX;
    for (let i = 0; i < levels.length; i++) {
      cum += levels[i].size;
      const x = xOf(levels[i].price);
      const y = yOf(cum, total);
      ctx.lineTo(x, y); // 在這一檔的價位上，垂直長到新的累計高度
      const nextX = i + 1 < levels.length ? xOf(levels[i + 1].price) : x;
      ctx.lineTo(nextX, y); // 水平接到下一檔的價位，高度維持不變（階梯的橫段）
      lastX = nextX;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    // 沿著底部走回起點，把「階梯線 vs 底部」之間圍出來的區域淡淡填色——經典
    // depth chart 的畫法。
    ctx.lineTo(lastX, plotH);
    ctx.lineTo(centerX, plotH);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  const bestBid = bids[0].price;
  const worstBid = bids[bids.length - 1].price;
  const bestAsk = asks[0].price;
  const worstAsk = asks[asks.length - 1].price;

  drawSide(bids, (p) => xOfBid(p, bestBid, worstBid), COLORS.bull); // 左側固定 bid
  drawSide(asks, (p) => xOfAsk(p, bestAsk, worstAsk), COLORS.bear); // 右側固定 ask
}
