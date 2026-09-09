// 문자 인코딩 감지 및 디코딩
export const ENCODINGS = [
  { id: 'auto', label: '자동 감지' },
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'euc-kr', label: 'EUC-KR (CP949)' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
];

export function encodingLabel(id) {
  const found = ENCODINGS.find((e) => e.id === id);
  return found ? found.label : id;
}

/** BOM → UTF-8 엄격 검사 → UTF-16 휴리스틱 → EUC-KR 순으로 판별한다. */
export function detectEncoding(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return 'utf-8';
  } catch {
    // UTF-8이 아님
  }

  // BOM 없는 UTF-16: 짝수/홀수 위치의 0 바이트 분포로 추정
  const n = Math.min(b.length, 4096);
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < n; i++) {
    if (b[i] === 0) {
      if (i % 2 === 0) zeroEven++;
      else zeroOdd++;
    }
  }
  if (n > 16) {
    if (zeroOdd > n / 8 && zeroEven < zeroOdd / 4) return 'utf-16le';
    if (zeroEven > n / 8 && zeroOdd < zeroEven / 4) return 'utf-16be';
  }
  return 'euc-kr';
}

/** 줄바꿈을 \n으로 통일하고 BOM을 제거한다. */
function normalize(text) {
  return text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
}

/** encoding이 'auto'면 감지한다. 반환: { text, encoding } */
export function decodeText(buffer, encoding = 'auto') {
  const enc = !encoding || encoding === 'auto' ? detectEncoding(buffer) : encoding;
  let text;
  try {
    text = new TextDecoder(enc).decode(buffer);
  } catch {
    text = new TextDecoder('utf-8').decode(buffer);
  }
  return { text: normalize(text), encoding: enc };
}
