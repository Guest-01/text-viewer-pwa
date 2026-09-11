// 본문/UI 고딕용 Pretendard 서브셋 woff2 생성 (Regular, Bold)
// 범위는 scripts/make-font.py(명조)와 같다: KS X 1001 완성형 한글 2,350자 + 호환 자모 + 라틴/Latin-1 + 구두점 + CJK 기호 + 전각 기호
// 사용:
//   npm install            (devDependency subset-font, 최초 1회)
//   node scripts/make-sans-font.js [--src <폴더>]
// --src 를 주지 않으면 Pretendard 저장소(v1.3.9)에서 OTF를 임시 폴더로 내려받는다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const subsetFont = require('subset-font');

const VERSION = 'v1';
const REPO = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9';
const SRC_URL = (w) => `${REPO}/packages/pretendard/dist/public/static/Pretendard-${w}.otf`;
const OUT_DIR = path.join(__dirname, '..', 'fonts');
const WEIGHTS = [
  ['Regular', `pretendard-2350-regular-${VERSION}.woff2`],
  ['Bold', `pretendard-2350-bold-${VERSION}.woff2`],
];

function unicodes() {
  const cps = new Set();
  // KS X 1001 완성형 한글 2,350자: 행 0xB0~0xC8, 열 0xA1~0xFE 를 EUC-KR로 디코딩
  const dec = new TextDecoder('euc-kr');
  for (let hi = 0xb0; hi <= 0xc8; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      const ch = dec.decode(new Uint8Array([hi, lo]));
      const cp = ch.codePointAt(0);
      if (cp >= 0xac00 && cp <= 0xd7a3) cps.add(cp);
    }
  }
  const ranges = [
    [0x0020, 0x007e], // ASCII
    [0x00a0, 0x00ff], // Latin-1 보충
    [0x02c6, 0x02dc],
    [0x2010, 0x2027], // 하이픈, 대시, 따옴표, 불릿, 말줄임표
    [0x2030, 0x205e],
    [0x20a9, 0x20a9], // ₩
    [0x2100, 0x214f],
    [0x2190, 0x2199], // 화살표
    [0x2200, 0x22ff], // 수학 기호
    [0x2460, 0x24ff], // 원문자
    [0x2500, 0x257f], // 괘선
    [0x25a0, 0x25ff], // 도형
    [0x2600, 0x2606], // ☆★
    [0x3000, 0x303f], // CJK 기호와 구두점
    [0x3131, 0x318e], // 한글 호환 자모
    [0xff01, 0xff5e], // 전각 기호와 영숫자
    [0xffe6, 0xffe6],
  ];
  for (const [lo, hi] of ranges) for (let c = lo; c <= hi; c++) cps.add(c);
  return cps;
}

async function fetchTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--src');
  let srcDir = i >= 0 ? argv[i + 1] : null;
  if (!srcDir) {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pretendard-'));
    for (const [w] of WEIGHTS) {
      console.log('내려받는 중:', SRC_URL(w));
      await fetchTo(SRC_URL(w), path.join(srcDir, `Pretendard-${w}.otf`));
    }
    await fetchTo(`${REPO}/LICENSE`, path.join(OUT_DIR, 'LICENSE-Pretendard-OFL.txt'));
  }
  const text = String.fromCodePoint(...unicodes());
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [w, name] of WEIGHTS) {
    const src = fs.readFileSync(path.join(srcDir, `Pretendard-${w}.otf`));
    const out = await subsetFont(src, text, { targetFormat: 'woff2' });
    const dest = path.join(OUT_DIR, name);
    fs.writeFileSync(dest, out);
    console.log('생성:', path.relative(process.cwd(), dest), `${(out.length / 1024).toFixed(0)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
