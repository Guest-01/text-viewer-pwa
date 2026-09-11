// 본문을 블록(줄 단위, 너무 긴 줄은 분할)과 청크(렌더링 단위)로 색인한다.
// 색인하면서 책 제목과 장 제목(목차)도 찾아 둔다.
const MAX_BLOCK = 3000; // 블록 최대 글자 수
const CHUNK_CHARS = 20000; // 청크 목표 글자 수
const MAX_INDENT_SKIP = 4; // 이 길이 이하의 앞 공백은 들여쓰기로 보고 떼어낸다 (더 길면 의도한 정렬로 두고 유지)
const MAX_HEADING_LEN = 40;
const MAX_TITLE_LEN = 40;
const MAX_TOC = 3000;

export const KIND_BODY = 0;
export const KIND_HEADING = 1;
export const KIND_TITLE = 2;

// 문맥 없이도 장 제목으로 볼 수 있는 패턴 (제1장, Chapter 3, 프롤로그 ...)
const HEADING_STRONG =
  /^(?:제\s*[0-9０-９一二三四五六七八九十百千]+\s*(?:장|편|부|회|화|절|권|막|章|話)(?![가-힣])|(?:chapter|part|book|section|prologue|epilogue|interlude)\b|(?:프롤로그|에필로그|서장|종장|막간|외전|서문|후기|작가의\s*말)(?![가-힣]))/i;
// 앞뒤가 빈 줄일 때만 장 제목으로 보는 패턴 (12화 제목). "1. 항목"처럼 번호만 있는 줄은
// 메모·매뉴얼의 목록과 구분할 수 없어 장 제목으로 보지 않는다.
const HEADING_WEAK = /^[0-9０-９]{1,4}\s*(?:장|화|회|편|부)(?![가-힣0-9０-９])/;
const SENTENCE_END = /[.。!?！？"”』」\]]$/;
const HAS_WORD = /[\p{L}\p{N}]/u;

function isBlankAt(starts, ends, i) {
  return i < 0 || i >= starts.length || ends[i] - starts[i] === 0;
}

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

  // 들여쓰기 공백, 블록 종류(본문/장 제목/책 제목), 목차
  const n = starts.length;
  const skips = new Uint8Array(n);
  const kinds = new Uint8Array(n);
  const toc = [];
  let title = null;
  let firstText = -1;
  for (let i = 0; i < n; i++) {
    const s = starts[i];
    const e = ends[i];
    if (e === s) continue;
    if (!conts[i]) {
      let k = 0;
      while (k < e - s && k <= MAX_INDENT_SKIP && (text.charCodeAt(s + k) === 0x20 || text.charCodeAt(s + k) === 0x09 || text.charCodeAt(s + k) === 0x3000)) k++;
      if (k <= MAX_INDENT_SKIP && k < e - s) skips[i] = k;
    }
    if (firstText < 0) firstText = i;
    const bodyLen = e - s - skips[i];
    if (conts[i] || bodyLen > MAX_HEADING_LEN || toc.length >= MAX_TOC) continue;
    const line = text.slice(s + skips[i], e).trim();
    if (!line || !HAS_WORD.test(line)) continue;
    let heading = HEADING_STRONG.test(line);
    if (!heading && HEADING_WEAK.test(line) && isBlankAt(starts, ends, i - 1) && isBlankAt(starts, ends, i + 1)) heading = true;
    if (heading) {
      kinds[i] = KIND_HEADING;
      toc.push({ block: i, offset: s + skips[i], text: line });
    }
  }
  // 책 제목: 첫 글줄이 짧고 문장 부호로 끝나지 않으며 다음 줄이 비어 있을 때
  if (firstText >= 0 && kinds[firstText] !== KIND_HEADING) {
    const line = text.slice(starts[firstText] + skips[firstText], ends[firstText]).trim();
    if (line.length <= MAX_TITLE_LEN && HAS_WORD.test(line) && !SENTENCE_END.test(line) && isBlankAt(starts, ends, firstText + 1)) {
      kinds[firstText] = KIND_TITLE;
      title = line;
    }
  }

  return {
    text,
    length: len,
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
    conts: Uint8Array.from(conts),
    skips,
    kinds,
    toc,
    title,
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

/** 블록 본문 (들여쓰기 공백 제외). 반환 문자열의 k번째 글자 오프셋은 starts[b] + skips[b] + k */
export function blockText(index, b) {
  return index.text.slice(index.starts[b] + index.skips[b], index.ends[b]);
}

/** 위치 주변 미리보기 문장 (책갈피/검색 결과용) */
export function snippetAt(index, offset, len = 60) {
  const s = index.text.slice(offset, offset + len * 2).replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/** offset이 속한 목차 항목 번호 (-1이면 첫 장 제목 앞) */
export function tocIndexAt(index, offset) {
  const toc = index.toc;
  let lo = 0;
  let hi = toc.length - 1;
  if (hi < 0 || toc[0].offset > offset) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (toc[mid].offset <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
