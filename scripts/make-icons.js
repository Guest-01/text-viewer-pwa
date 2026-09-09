// 외부 의존성 없이 PNG 아이콘을 생성한다. (zlib + 수동 PNG 인코딩)
// 사용: node scripts/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---------- PNG 인코더 ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 도형 (단위 좌표 0..1) ----------
function roundedRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

const BG = hex('#2F6FED');
const PAGE = hex('#FFFFFF');
const LINE = hex('#334155');
const RIBBON = hex('#F59E0B');

// 아이콘 콘텐츠: 페이지 + 텍스트 줄 + 책갈피 리본. scale로 안전 영역을 조절한다.
function colorAt(u, v, scale, bgRadius) {
  // 배경 (둥근 사각형, maskable은 꽉 찬 사각형)
  if (!roundedRect(u, v, 0, 0, 1, 1, bgRadius)) return null;
  // 콘텐츠 좌표 변환
  const cu = (u - 0.5) / scale + 0.5;
  const cv = (v - 0.5) / scale + 0.5;
  // 리본
  if (cu >= 0.6 && cu <= 0.7 && cv >= 0.16 && cv <= 0.42) {
    const notch = cv > 0.36 && Math.abs(cu - 0.65) < (cv - 0.36) * 0.9;
    if (!notch) return RIBBON;
  }
  // 텍스트 줄
  const lines = [
    [0.32, 0.34, 0.68],
    [0.32, 0.46, 0.68],
    [0.32, 0.58, 0.68],
    [0.32, 0.70, 0.54],
  ];
  for (const [x1, y, x2] of lines) {
    if (roundedRect(cu, cv, x1, y, x2 - x1, 0.05, 0.025)) return LINE;
  }
  // 페이지
  if (roundedRect(cu, cv, 0.24, 0.18, 0.52, 0.66, 0.04)) return PAGE;
  return BG;
}

function render(size, { scale, bgRadius, filename }) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // 슈퍼샘플링
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = colorAt(u, v, scale, bgRadius);
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const cov = a / n;
      // 프리멀티플라이 안 함: 커버리지 있는 픽셀만 평균색 사용
      const cnt = a / 255 || 1;
      buf[i] = Math.round(r / cnt);
      buf[i + 1] = Math.round(g / cnt);
      buf[i + 2] = Math.round(b / cnt);
      buf[i + 3] = Math.round(cov);
    }
  }
  const out = path.join(OUT, filename);
  fs.writeFileSync(out, encodePNG(size, size, buf));
  console.log('생성:', path.relative(process.cwd(), out));
}

render(192, { scale: 1, bgRadius: 0.2, filename: 'icon-192.png' });
render(512, { scale: 1, bgRadius: 0.2, filename: 'icon-512.png' });
render(512, { scale: 0.72, bgRadius: 0, filename: 'maskable-512.png' });
