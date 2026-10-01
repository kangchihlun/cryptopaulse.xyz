/**
 * lib/heatmapLayout.ts — components/Heatmap.tsx 的畫布版面算式（純函式，不依賴
 * React）。熱圖本體（WebGPU / canvas2D）、K 棒 footprint 疊圖、orderbook ladder
 * 疊圖三張 canvas 全部共用這一份，三者才會像素級對齊。
 */

// 版面：右側留給價格刻度、底部留給 delta + 時間標籤。熱圖本體（GPU/canvas2D）
// 也只畫在扣掉這兩塊之後的繪圖區，散點才不會跑到刻度底下。
export const RIGHT_GUTTER_PX = 58;
export const BOTTOM_STRIP_PX = 32;

// 價格列的目標高度（CSS px）——列數由畫布高度回推，太細就放不下 footprint 的數字。
export const TARGET_ROW_PX = 14;

/** 畫布尺寸 + 繪圖區（扣掉右側刻度、底部標籤）的共用算式。 */
export interface Layout {
  dpr: number;
  cw: number; // 實體畫素寬
  ch: number;
  plotW: number; // 繪圖區寬（不含右側刻度欄）
  plotH: number; // 繪圖區高（不含底部標籤帶）
}

export function computeLayout(displayW: number, height: number): Layout {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.max(1, Math.floor(displayW * dpr));
  const ch = Math.max(1, Math.floor(height * dpr));
  return {
    dpr,
    cw,
    ch,
    plotW: Math.max(1, cw - RIGHT_GUTTER_PX * dpr),
    plotH: Math.max(1, ch - BOTTOM_STRIP_PX * dpr),
  };
}

export function sizeCanvas(canvas: HTMLCanvasElement, displayW: number, height: number, layout: Layout) {
  canvas.width = layout.cw;
  canvas.height = layout.ch;
  canvas.style.width = `${displayW}px`;
  canvas.style.height = `${height}px`;
}

