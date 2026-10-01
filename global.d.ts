/**
 * TS 5.6 的 lib.dom.d.ts 還沒內建 WebGPU 型別（Navigator.gpu / GPUDevice /
 * GPUCanvasContext ...），只有 components/Heatmap.tsx 用到，用 triple-slash
 * reference 局部補上，不動 tsconfig 的 "types" 陣列（那會連帶關掉 @types/node
 * 等套件的自動 ambient include，範圍太大）。
 */
/// <reference types="@webgpu/types" />
