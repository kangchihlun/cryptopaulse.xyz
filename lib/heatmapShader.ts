/**
 * lib/heatmapShader.ts — WGSL 給 components/Heatmap.tsx 的 WebGPU 點狀 glow
 * render pipeline。
 *
 * 演算法出處：vgpu.sh 首頁展示的「halo ring」漸層渲染範例（2026-09 查證，該頁
 * fragment shader 原始碼）：
 *
 *   let ring  = exp(-95.0 * pow(abs(radius - 0.31), 2.0));   // 緊實的亮環核心
 *   let halo  = exp(-18.0 * pow(abs(radius - 0.31), 2.0));   // 較寬的柔和外暈
 *   let color = palette(angle + radius * 0.65);               // 彩虹色相盤
 *   return vec4f(color * (ring * bands * 2.0 + halo * 0.22), 1.0);
 *
 * 那是以「離某個固定環半徑(0.31)的距離」做兩層不同寬度的高斯衰減，疊加出
 * 「銳利核心 + 柔和外暈」的視覺——一個裝飾性的甜甜圈光環。訂單簿深度是一堆
 * 離散的點（每檔 bid/ask），不是環，所以這裡把「離環半徑的距離」換成「離點
 * 中心的距離」（等於把環半徑設為 0），公式的雙高斯疊加骨架、CORE_K=95/
 * HALO_K=18 兩個衰減常數、以及 2.0 / 0.22 的疊加權重都原封不動照抄——這樣
 * 「亮環」自然退化成「亮核心 + 柔和外暈」的點狀 glow，數學上是同一族函式。
 * 拿掉的只有 vgpu.sh 原本「環」專屬的兩處：`bands`（環上的角度分段紋理，
 * 對散點沒有意義）跟 `palette()` 彩虹配色（使用者要求多空基礎色不能換掉，
 * 這裡固定用 bull/bear 兩色，見 lib/theme.ts）。
 *
 * 疊色方式：色彩混合模式（blend state）設成 srcFactor/dstFactor 都是
 * `one`、operation `add`——真正的加法疊色（additive blending），每個點各自
 * 輸出「已預乘 alpha 的顏色（rgb*glow, glow）」，多個點重疊的地方直接加總、
 * 越密集的地方越亮，而不是後畫的蓋掉先畫的。
 */

export const HEATMAP_WGSL = /* wgsl */ `
struct Uniforms {
  resolution: vec2f,
  pointRadiusPx: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct InstanceIn {
  @location(0) centerNdc: vec2f,   // 資料點中心，clip space -1..1
  @location(1) color: vec3f,       // bull 或 bear，literal RGB 0..1（不用彩虹 palette）
  @location(2) intensity: f32,     // 0..1，log 正規化後的美金深度
  @location(3) radiusScale: f32,   // 依 intensity 微調點的視覺大小
};

struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0) localUV: vec2f,     // quad 內局部座標，-1..1，即「離點中心的距離」的基底
  @location(1) color: vec3f,
  @location(2) intensity: f32,
};

// 兩個三角形（6 頂點）組成一個 quad，不用額外的 vertex buffer——跟 instance
// buffer 一起用 instanced draw(6, N) 畫出 N 個點。
const CORNERS = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vIdx: u32, inst: InstanceIn) -> VertexOut {
  let corner = CORNERS[vIdx];
  let px = corner * uniforms.pointRadiusPx * inst.radiusScale;
  let ndcOffset = px / uniforms.resolution * 2.0;

  var out: VertexOut;
  out.pos = vec4f(inst.centerNdc + ndcOffset, 0.0, 1.0);
  out.localUV = corner;
  out.color = inst.color;
  out.intensity = inst.intensity;
  return out;
}

// vgpu.sh halo ring 的兩個衰減常數，原封不動沿用。
const CORE_K: f32 = 95.0;
const HALO_K: f32 = 18.0;
const CORE_WEIGHT: f32 = 1.0;
const HALO_WEIGHT: f32 = 0.22;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let radius = length(in.localUV); // 離點中心的距離（vgpu.sh 原式是離環半徑 0.31 的距離）
  let core = exp(-CORE_K * pow(radius, 2.0));
  let halo = exp(-HALO_K * pow(radius, 2.0));
  let glow = (core * CORE_WEIGHT + halo * HALO_WEIGHT) * in.intensity;
  // 預乘 alpha：additive blend 下多點重疊直接加總亮度，而不是互相蓋掉。
  return vec4f(in.color * glow, glow);
}
`;

/** 每個 instance 在 buffer 裡的 float 數（centerNdc.xy + color.rgb + intensity + radiusScale）。 */
export const HEATMAP_INSTANCE_STRIDE_FLOATS = 7;
