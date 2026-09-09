// 본문을 블록(줄 단위, 너무 긴 줄은 분할)과 청크(렌더링 단위)로 색인한다.
const MAX_BLOCK = 3000; // 블록 최대 글자 수
const CHUNK_CHARS = 20000; // 청크 목표 글자 수

export function buildIndex(text) {
  const starts = [];
  const ends = [];
  const conts = []; // 1이면 앞 블록에서 이어지는 조각(긴 줄 분할)
  const len = text.length;
  let pos = 0;

  for (;;) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    if (nl - pos <= MAX_BLOCK) {
      starts.push(pos);
      ends.push(nl);
      conts.push(0);
    } else {
      let p = pos;
      while (p < nl) {
        let e = Math.min(p + MAX_BLOCK, nl);
        if (e < nl) {
          const sp = text.lastIndexOf(' ', e);
          if (sp > p + MAX_BLOCK - 400) e = sp + 1;
        }
        starts.push(p);
        ends.push(e);
        conts.push(p > pos ? 1 : 0);
        p = e;
      }
    }
    if (nl >= len) break;
    pos = nl + 1;
  }

  const chunkStarts = [0];
  let acc = 0;
  for (let i = 0; i < starts.length; i++) {
    acc += ends[i] - starts[i] + 1;
    if (acc >= CHUNK_CHARS && i + 1 < starts.length) {
      chunkStarts.push(i + 1);
      acc = 0;
    }
  }

  return {
    text,
    length: len,
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
    conts: Uint8Array.from(conts),
    blockCount: starts.length,
    chunkStarts,
    chunkCount: chunkStarts.length,
  };
}

/** offset을 포함하는 블록 인덱스 (이진 탐색) */
export function findBlock(index, offset) {
  const { starts } = index;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 블록 인덱스가 속한 청크 번호 */
export function chunkOfBlock(index, block) {
  const cs = index.chunkStarts;
  let lo = 0;
  let hi = cs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cs[mid] <= block) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 청크 c의 블록 범위 [from, to) */
export function chunkRange(index, c) {
  const from = index.chunkStarts[c];
  const to = c + 1 < index.chunkStarts.length ? index.chunkStarts[c + 1] : index.blockCount;
  return [from, to];
}

export function blockText(index, b) {
  return index.text.slice(index.starts[b], index.ends[b]);
}

/** 위치 주변 미리보기 문장 (책갈피/검색 결과용) */
export function snippetAt(index, offset, len = 60) {
  const s = index.text.slice(offset, offset + len * 2).replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len) + '…' : s;
}
