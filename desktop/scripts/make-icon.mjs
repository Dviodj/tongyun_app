// 生成 通韵 TongYun 应用图标（512×512 PNG，纯 Node 实现，无外部依赖）。
// 设计：蓝色渐变圆角方块 + 三条脑电波形（点/划摩斯元素）。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "icon.png");

// ---- 极简 PNG 编码 ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 绘制 ----
const px = Buffer.alloc(SIZE * SIZE * 4);
const setPixel = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const blend = a / 255;
  px[i] = Math.round(px[i] * (1 - blend) + r * blend);
  px[i + 1] = Math.round(px[i + 1] * (1 - blend) + g * blend);
  px[i + 2] = Math.round(px[i + 2] * (1 - blend) + b * blend);
  px[i + 3] = Math.min(255, px[i + 3] + a);
};

const RADIUS = 116;
const insideRoundRect = (x, y) => {
  const left = 8;
  const top = 8;
  const right = SIZE - 8;
  const bottom = SIZE - 8;
  const cx = Math.min(Math.max(x, left + RADIUS), right - RADIUS);
  const cy = Math.min(Math.max(y, top + RADIUS), bottom - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
};

// 背景渐变（上蓝下紫）
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (!insideRoundRect(x, y)) continue;
    const t = Math.min(1, Math.max(0, (x + y) / (2 * SIZE) * 0.55 + y / SIZE * 0.45));
    const r = Math.round(10 + (122 - 10) * t);
    const g = Math.round(132 + (58 - 132) * t);
    const b = Math.round(255 + (239 - 255) * t);
    let a = 255;
    // 顶部高光
    if (y < 190) a = 235;
    setPixel(x, y, r, g, b, a);
  }
}

// 圆角外沿描边
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (!insideRoundRect(x, y)) continue;
    const left = 8;
    const top = 8;
    const right = SIZE - 8;
    const bottom = SIZE - 8;
    const cx = Math.min(Math.max(x, left + RADIUS), right - RADIUS);
    const cy = Math.min(Math.max(y, top + RADIUS), bottom - RADIUS);
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    if (d > RADIUS - 3 && d <= RADIUS) setPixel(x, y, 255, 255, 255, 70);
  }
}

// 三条脑电波形
const waves = [
  { cy: 268, amp: 52, freq: 0.052, phase: 0.6, width: 7 },
  { cy: 316, amp: 40, freq: 0.071, phase: 2.1, width: 7 },
  { cy: 364, amp: 46, freq: 0.06, phase: 4.2, width: 7 },
];
for (const wave of waves) {
  for (let x = 0; x < SIZE; x += 1) {
    const value = Math.sin(x * wave.freq + wave.phase) + 0.35 * Math.sin(x * wave.freq * 3.1 + wave.phase * 2);
    const y = wave.cy + value * wave.amp;
    for (let dy = -6; dy <= 6; dy += 1) {
      const dist = Math.abs(y + dy - Math.round(y));
      const alpha = dist <= wave.width / 2 ? 235 : dist <= wave.width ? 110 : 0;
      if (alpha > 0) setPixel(x, Math.round(y) + dy, 255, 255, 255, alpha);
    }
  }
}

// 摩斯「点」与「划」
const dot = (cx, cy, r) => {
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPixel(x, y, 255, 255, 255, 245);
    }
  }
};
const dash = (x0, x1, cy, halfH) => {
  for (let y = cy - halfH; y <= cy + halfH; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      let inside = x >= x0 + halfH && x <= x1 - halfH;
      if (!inside) {
        const cx = x < x0 + halfH ? x0 + halfH : x1 - halfH;
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= halfH * halfH;
      }
      if (inside) setPixel(x, y, 255, 255, 255, 245);
    }
  }
};
dot(128, 434, 13);
dash(186, 254, 434, 13);
dash(292, 400, 434, 13);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(SIZE, SIZE, px));
console.log(`icon written: ${out}`);
