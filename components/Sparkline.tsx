"use client";

import { useId } from "react";
import { COLORS } from "@/lib/theme";

interface SparklineProps {
  values: (number | null)[];
  width?: number;
  height?: number;
  zeroLine?: boolean;
  colorAbove?: string;
  colorBelow?: string;
}

/** 純 SVG 折線小圖，不拉額外的圖表 library——動能比較面板只需要輕量趨勢示意。 */
export default function Sparkline({
  values,
  width = 160,
  height = 40,
  zeroLine = true,
  colorAbove = COLORS.bull,
  colorBelow = COLORS.bear,
}: SparklineProps) {
  // SVG 漸層 id 要全頁唯一——同一頁會同時畫好幾個 Sparkline（MomentumPanel 一個
  // 幣種一個、CoinDetailClient 兩個），id 撞名的話後面定義的漸層會蓋掉前面的。
  const gradientId = useId();
  const clean = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (clean.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-30">
        <text x={4} y={height / 2} fill={COLORS.muted} fontSize="10">
          Not enough data
        </text>
      </svg>
    );
  }
  const min = Math.min(...clean, zeroLine ? 0 : Infinity);
  const max = Math.max(...clean, zeroLine ? 0 : -Infinity);
  const span = max - min || 1;
  const last = clean[clean.length - 1];
  const stroke = last >= 0 ? colorAbove : colorBelow;

  const coords = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * width;
    const y = height - ((v - min) / span) * height;
    return { x, y };
  });
  const points = coords.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`);

  // 折線下方的填色區域：從折線本身往下封到畫布底部（height），再沿底部走回
  // 起點封閉——搭配漸層，越靠近折線越實、越往下越透明。
  const areaPath =
    `M${coords[0].x.toFixed(1)},${coords[0].y.toFixed(1)} ` +
    coords
      .slice(1)
      .map(({ x, y }) => `L${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ") +
    ` L${coords[coords.length - 1].x.toFixed(1)},${height} L${coords[0].x.toFixed(1)},${height} Z`;

  const zeroY = height - ((0 - min) / span) * height;

  return (
    <svg width={width} height={height}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {zeroLine && min < 0 && max > 0 && (
        <line x1={0} x2={width} y1={zeroY} y2={zeroY} stroke="#1f2733" strokeWidth={1} />
      )}
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <polyline points={points.join(" ")} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}
