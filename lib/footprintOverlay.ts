/**
 * lib/footprintOverlay.ts — K 棒 + 掛單流 footprint 的疊圖繪製（純 canvas2D，
 * 不依賴 React/DOM 以外的東西）。
 *
 * 從 components/Heatmap.tsx 拆出來的原因有二：①元件檔已經很長，繪製邏輯跟
 * WebGPU pipeline 管理混在一起不好讀；②這個開發環境沒有瀏覽器可以看渲染結果，
 * 拆成純函式之後可以在 node 裡餵真實資料 + 一個記錄呼叫的假 ctx 實際跑一遍，
 * 驗證座標沒有 NaN、沒有畫到繪圖區外、文字有沒有被寬度門檻擋掉。
 *
 * ⚠️ 格子裡的數字是**掛單壓力**不是成交量，語意說明見 lib/footprint.ts 檔頭。
 */
import { COLORS, hexToRgb } from "./theme";
import { columnBox, compactUsd, makeScales, type FootprintModel } from "./footprint";
import type { Layout } from "./heatmapLayout";

const BULL_RGB = hexToRgb(COLORS.bull);
const BEAR_RGB = hexToRgb(COLORS.bear);

const rgba = (rgb: [number, number, number], a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

/** 選一個好看的價格刻度間距（1 / 2 / 2.5 / 5 × 10^k）。 */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function fmtPrice(p: number, step: number): string {
  const decimals = step >= 10 ? 0 : step >= 1 ? 1 : step >= 0.1 ? 2 : 4;
  return p.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/** 疊圖主繪製：價格刻度 → 每根 K 棒（格子 + OHLC）→ 底部 delta/時間帶 → 最新價線。 */
export function drawFootprintOverlay(ctx: CanvasRenderingContext2D, layout: Layout, model: FootprintModel) {
  const { dpr, cw, ch, plotW, plotH } = layout;
  const pSpan = model.priceMax - model.priceMin || 1;
  const { xOfMs, yOfPrice } = makeScales(model, plotW, plotH);
  const logMaxRow = Math.log10(model.maxRowUsd + 1) || 1;

  // ---- 價格刻度（水平虛線 + 右側刻度欄文字）----
  const step = niceStep(pSpan / 6);
  ctx.save();
  ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "middle";
  for (let p = Math.ceil(model.priceMin / step) * step; p <= model.priceMax; p += step) {
    const y = yOfPrice(p);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(187,227,229,0.55)";
    ctx.textAlign = "left";
    ctx.fillText(fmtPrice(p, step), plotW + 6 * dpr, y);
  }
  ctx.restore();

  // ---- 每根 K 棒 ----
  ctx.save();
  ctx.textBaseline = "middle";
  for (const b of model.buckets) {
    const x0 = xOfMs(b.startMs);
    const x1 = xOfMs(b.endMs);
    const colW = x1 - x0;
    if (colW <= 2) continue;

    // 欄位分隔線
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, plotH);
    ctx.stroke();

    const { candleCx, candleW, cellX0, cellW, cellCx } = columnBox(x0, x1, dpr);

    const up = b.close >= b.open;
    const sideRgb = up ? BULL_RGB : BEAR_RGB;

    // footprint 格子：每個價格列一格，左半 bid、右半 ask，深淺依該邊的掛單量
    // （log 正規化到全圖最大值）。跟 K 棒共用同一條價格軸。
    const rowPx = (plotH / model.rowCount);
    const showText = rowPx >= 9 * dpr && cellW >= 58 * dpr;
    if (showText) ctx.font = `${Math.min(11 * dpr, rowPx * 0.72)}px ui-monospace, SFMono-Regular, Menlo, monospace`;

    for (const [rowIdx, cell] of b.rows) {
      // 低於 $1 的殘值當作沒有——掛單簿的每一列天生大多只有單邊有量（該價位
      // 若在 mid 之上就只會有 ask、之下只會有 bid），另一邊的微量多半是這根
      // 棒子裡 mid 曾短暫越過這一列留下的尾巴，畫出來只會變成一排沒有意義的 0。
      const bidUsd = cell.bidUsd >= 1 ? cell.bidUsd : 0;
      const askUsd = cell.askUsd >= 1 ? cell.askUsd : 0;
      if (bidUsd === 0 && askUsd === 0) continue;

      const rowLow = model.priceMin + rowIdx * model.rowHeight;
      const yTop = yOfPrice(rowLow + model.rowHeight);
      const yBot = yOfPrice(rowLow);
      const h = Math.max(1, yBot - yTop);
      const bidK = Math.min(1, Math.log10(bidUsd + 1) / logMaxRow);
      const askK = Math.min(1, Math.log10(askUsd + 1) / logMaxRow);

      if (bidUsd > 0) {
        ctx.fillStyle = rgba(BULL_RGB, 0.06 + 0.34 * bidK);
        ctx.fillRect(cellX0, yTop + 0.5 * dpr, cellW / 2, h - 1 * dpr);
      }
      if (askUsd > 0) {
        ctx.fillStyle = rgba(BEAR_RGB, 0.06 + 0.34 * askK);
        ctx.fillRect(cellCx, yTop + 0.5 * dpr, cellW / 2, h - 1 * dpr);
      }

      if (showText) {
        const yMid = (yTop + yBot) / 2;
        // 兩邊都有量才排成「bid × ask」；只有單邊時就只印那一邊（位置仍固定
        // 在自己那一半，整欄的數字才會對齊成兩條直行）。
        if (bidUsd > 0) {
          ctx.textAlign = "right";
          ctx.fillStyle = rgba(BULL_RGB, 0.55 + 0.45 * bidK);
          ctx.fillText(compactUsd(bidUsd), cellCx - 4 * dpr, yMid);
        }
        if (bidUsd > 0 && askUsd > 0) {
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(187,227,229,0.35)";
          ctx.fillText("×", cellCx, yMid);
        }
        if (askUsd > 0) {
          ctx.textAlign = "left";
          ctx.fillStyle = rgba(BEAR_RGB, 0.55 + 0.45 * askK);
          ctx.fillText(compactUsd(askUsd), cellCx + 4 * dpr, yMid);
        }
      }
    }

    // 格子區外框，把「這一整塊屬於同一根 K 棒」框起來
    ctx.strokeStyle = rgba(sideRgb, 0.25);
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(cellX0, yOfPrice(b.high), cellW, Math.max(1, yOfPrice(b.low) - yOfPrice(b.high)));

    // OHLC K 棒：影線 high→low、實體 open→close（沒動時給 1.5px 的最小厚度）
    const yHigh = yOfPrice(b.high);
    const yLow = yOfPrice(b.low);
    const yOpen = yOfPrice(b.open);
    const yClose = yOfPrice(b.close);
    ctx.strokeStyle = rgba(sideRgb, 0.9);
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.beginPath();
    ctx.moveTo(candleCx, yHigh);
    ctx.lineTo(candleCx, yLow);
    ctx.stroke();
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1.5 * dpr, Math.abs(yClose - yOpen));
    ctx.fillStyle = rgba(sideRgb, 0.85);
    ctx.fillRect(candleCx - candleW / 2, bodyTop, candleW, bodyH);
  }
  ctx.restore();

  // ---- 底部：每根棒子的 delta（掛單簿失衡）+ 時間標籤 ----
  ctx.save();
  ctx.fillStyle = "rgba(10,13,18,0.82)";
  ctx.fillRect(0, plotH, cw, ch - plotH);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(0, plotH + 0.5 * dpr);
  ctx.lineTo(cw, plotH + 0.5 * dpr);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const deltaY = plotH + (ch - plotH) * 0.3;
  const timeY = plotH + (ch - plotH) * 0.74;
  for (const b of model.buckets) {
    const cx = (xOfMs(b.startMs) + xOfMs(b.endMs)) / 2;
    const colW = xOfMs(b.endMs) - xOfMs(b.startMs);
    if (colW < 34 * dpr) continue;
    ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = b.delta >= 0 ? COLORS.bull : COLORS.bear;
    ctx.fillText(`${b.delta >= 0 ? "+" : "-"}${compactUsd(Math.abs(b.delta))}`, cx, deltaY);
    ctx.font = `${9 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = "rgba(187,227,229,0.5)";
    ctx.fillText(fmtClock(b.startMs), cx, timeY);
  }
  // 右下角標示這條帶子是什麼
  ctx.textAlign = "left";
  ctx.font = `${9 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = "rgba(187,227,229,0.45)";
  ctx.fillText("Δ book", plotW + 6 * dpr, deltaY);
  ctx.restore();

  // ---- 最新價：橫跨繪圖區的虛線 + 右側刻度欄的價格籤 ----
  if (model.lastPrice != null) {
    const y = yOfPrice(model.lastPrice);
    ctx.save();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = fmtPrice(model.lastPrice, step);
    ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(plotW + 3 * dpr, y - 7 * dpr, tw + 8 * dpr, 14 * dpr);
    ctx.fillStyle = COLORS.bg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, plotW + 7 * dpr, y);
    ctx.restore();
  }
}

