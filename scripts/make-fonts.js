// 동봉 글꼴 서브셋 woff2 생성 (고딕: Pretendard Regular/Bold, 명조: Noto Serif KR Regular/Bold)
// 범위: KS X 1001 완성형 한글 2,350자 + 호환 자모 + 라틴/Latin-1 + 구두점 + CJK 기호 + 전각 기호
// 한 번 만들어 커밋해 두고, 범위나 글꼴 버전을 바꿀 때만 다시 돌린다. 범위를 바꾸면 파일명의 버전도 올릴 것
// (fonts/ 는 서비스 워커가 캐시 우선·불변으로 다루므로 같은 이름에 다른 범위를 넣으면 옛 캐시가 남는다).
// 사용:
//   npm install                       (devDependency subset-font, 최초 1회)
//   node scripts/make-fonts.js        (원본 OTF를 임시 폴더로 내려받아 전부 생성)
//   node scripts/make-fonts.js --src <OTF 폴더> [--only serif|sans]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const subsetFont = require('subset-font');

const OUT_DIR = path.join(__dirname, '..', 'fonts');
const PRETENDARD = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9';
const NOTO = 'https://github.com/notofonts/noto-cjk/raw/main/Serif/SubsetOTF/KR';
const FONTS = [
  { kind: 'sans', file: 'Pretendard-Regular.otf', url: `${PRETENDARD}/packages/pretendard/dist/public/static/Pretendard-Regular.otf`, out: 'pretendard-2350-regular-v1.woff2' },
  { kind: 'sans', file: 'Pretendard-Bold.otf', url: `${PRETENDARD}/packages/pretendard/dist/public/static/Pretendard-Bold.otf`, out: 'pretendard-2350-bold-v1.woff2' },
  { kind: 'serif', file: 'NotoSerifKR-Regular.otf', url: `${NOTO}/NotoSerifKR-Regular.otf`, out: 'noto-serif-kr-2350-v1.woff2' },
  { kind: 'serif', file: 'NotoSerifKR-Bold.otf', url: `${NOTO}/NotoSerifKR-Bold.otf`, out: 'noto-serif-kr-2350-bold-v1.woff2' },
];
const LICENSES = [
  { url: `${PRETENDARD}/LICENSE`, out: 'LICENSE-Pretendard-OFL.txt' },
  { url: 'https://github.com/notofonts/noto-cjk/raw/main/Serif/LICENSE', out: 'LICENSE-OFL.txt' },
];

function unicodes() {
  const cps = new Set();
  // KS X 1001 완성형 한글 2,350자: 행 0xB0~0xC8, 열 0xA1~0xFE 를 EUC-KR로 디코딩
  const dec = new TextDecoder('euc-kr');
  for (let hi = 0xb0; hi <= 0xc8; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      const cp = dec.decode(new Uint8Array([hi, lo])).codePointAt(0);
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
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const only = arg('--only');
  const targets = FONTS.filter((f) => !only || f.kind === only);
  let srcDir = arg('--src');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!srcDir) {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-fonts-'));
    for (const f of targets) {
      console.log('내려받는 중:', f.url);
      await fetchTo(f.url, path.join(srcDir, f.file));
    }
    for (const l of LICENSES) await fetchTo(l.url, path.join(OUT_DIR, l.out));
  }
  const text = String.fromCodePoint(...unicodes());
  for (const f of targets) {
    const src = fs.readFileSync(path.join(srcDir, f.file));
    // 힌팅은 버리고(모바일 화면에서 무의미, 용량의 큰 몫) 레이아웃 기능은 본문에 필요한 것만 남긴다.
    // 세로쓰기 지표(vhea/vmtx/VORG)와 서명(DSIG)은 쓰지 않으므로 뺀다.
    const out = await subsetFont(src, text, {
      targetFormat: 'woff2',
      noHinting: true,
      keepFeatures: ['kern', 'palt', 'liga', 'ccmp', 'locl'],
      preserveNameIds: [0, 1, 2, 3, 4, 5, 6],
      dropTables: ['vhea', 'vmtx', 'VORG', 'DSIG'],
    });
    const dest = path.join(OUT_DIR, f.out);
    fs.writeFileSync(dest, out);
    console.log('생성:', path.relative(process.cwd(), dest), `${(out.length / 1024).toFixed(0)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
