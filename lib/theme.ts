/**
 * 單一色票來源——bull/bear 語意色只在這裡定義一次。tailwind.config.ts、
 * components/Sparkline.tsx（SVG stroke）、components/Heatmap.tsx（canvas 逐像素
 * 繪製）、components/MomentumPanel.tsx（漸層 CSS）全部從這裡讀，不各自硬編一份
 * hex——2026-09-05 web/design/ 的設計稿先調了色，app 這邊沒同步過，兩邊顏色
 * 一度不一致；集中成單一來源後之後改色只要動這裡。
 *
 * 2026-09-05：依設計稿把 bull 從綠(#3ddc84)換成青(#0bcff2)、bear 從紅(#ff5470)
 * 換成紫(#ad50fa)、muted 從 #7b8794 換成 rgb(187 227 229)。
 */
export const COLORS = {
  bg: "#0a0d12",
  panel: "#12161d",
  border: "#1f2733",
  bull: "#0bcff2",
  bear: "#ad50fa",
  muted: "#bbe3e5",
} as const;

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
