// 뷰어 엔진: 페이지 모드(다단 레이아웃 + 가로 이동) / 스크롤 모드(청크 윈도우)
import { findBlock, chunkOfBlock, chunkRange, blockText } from './text.js';

const GAP = 40; // 페이지(컬럼) 사이 간격 px
const MAX_SCROLL_CHUNKS = 5;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export class Reader {
  constructor(viewport, handlers = {}) {
    this.viewport = viewport;
    this.onPosition = handlers.onPosition || (() => {});
    this.onEdge = handlers.onEdge || (() => {});
    this.onTap = handlers.onTap || (() => {});
    this.index = null;
    this.mode = 'page';
    this.position = 0;
    this._anchor = null; // 마지막 사용자 이동 지점 (재배치 기준)
    this.chunk = -1;
    this.page = 0;
    this.pageCount = 1;
    this.W = 0;
    this.H = 0;
    this._win = null; // 스크롤 모드에서 렌더된 청크 범위 [first, last]
    this._busy = false;
    this._scrollTimer = null;
    this._resizeTimer = null;
    this._lastSize = '';
    this._highlight = null;

    this._ro = new ResizeObserver(() => this._onResize());
    this._ro.observe(viewport);
    this._bindGestures();
  }

  // ---------- 공개 API ----------
  load(index, position = 0, mode = 'page') {
    this.index = index;
    this.mode = mode;
    this.position = clamp(position, 0, Math.max(0, index.length - 1));
    this._build();
    this.goTo(this.position);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const anchor = this._anchor != null ? this._anchor : this.getPosition();
    this.mode = mode;
    this._build();
    this.goTo(anchor);
    this._anchor = anchor;
  }

  /**
   * 글꼴/여백 등이 바뀐 뒤 현재 위치를 유지한 채 다시 배치한다.
   * 페이지 시작 위치가 아니라 마지막 사용자 이동 지점(앵커)을 기준으로 삼아
   * 설정을 여러 번 바꿔도 위치가 뒤로 밀리지 않게 한다.
   */
  relayout() {
    if (!this.index) return;
    const anchor = this._anchor != null ? this._anchor : this.getPosition();
    this._build();
    this.goTo(anchor);
    this._anchor = anchor;
  }

  getPosition() {
    if (!this.index) return 0;
    if (this.mode === 'scroll') {
      const p = this._computeScrollTop();
      if (p != null) this.position = p;
    }
    return this.position;
  }

  next() {
    if (!this.index) return;
    if (this.mode === 'scroll') {
      const s = this._scroller;
      if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2 && this._win[1] >= this.index.chunkCount - 1) {
        this.onEdge('end');
        return;
      }
      s.scrollBy({ top: s.clientHeight - 32, behavior: 'smooth' });
      return;
    }
    if (this.page < this.pageCount - 1) {
      this._showPage(this.page + 1, true);
    } else if (this.chunk < this.index.chunkCount - 1) {
      this._renderChunk(this.chunk + 1);
      this._showPage(0, false);
    } else {
      this.onEdge('end');
    }
  }

  prev() {
    if (!this.index) return;
    if (this.mode === 'scroll') {
      const s = this._scroller;
      if (s.scrollTop <= 0 && this._win[0] === 0) {
        this.onEdge('start');
        return;
      }
      s.scrollBy({ top: -(s.clientHeight - 32), behavior: 'smooth' });
      return;
    }
    if (this.page > 0) {
      this._showPage(this.page - 1, true);
    } else if (this.chunk > 0) {
      this._renderChunk(this.chunk - 1);
      this._showPage(this.pageCount - 1, false);
    } else {
      this.onEdge('start');
    }
  }

  /** 글자 오프셋으로 이동한다. */
  goTo(offset) {
    if (!this.index) return;
    offset = clamp(Math.floor(offset), 0, Math.max(0, this.index.length - 1));
    this._clearHighlight();
    const b = findBlock(this.index, offset);
    const c = chunkOfBlock(this.index, b);
    if (this.mode === 'page') {
      if (c !== this.chunk) this._renderChunk(c);
      const p = this._blockEl(b);
      const rect = this._rectAt(p, offset - this.index.starts[b]);
      const base = this.pages.getBoundingClientRect().left;
      let page = Math.floor((rect.left - base + 1) / (this.W + GAP));
      if (!Number.isFinite(page)) page = 0;
      this._showPage(clamp(page, 0, this.pageCount - 1), false);
      this._anchor = offset;
    } else {
      const last = this.index.chunkCount - 1;
      if (!this._win || c < this._win[0] || c > this._win[1]) {
        this._renderScrollWindow(Math.max(0, c - 1), Math.min(last, c + 1));
      }
      const p = this._blockEl(b);
      const rect = this._rectAt(p, offset - this.index.starts[b]);
      const sRect = this._scroller.getBoundingClientRect();
      this._scroller.scrollTop += rect.top - sRect.top - this._padTop;
      this.position = offset;
      this._anchor = offset;
      this.onPosition(this.position);
    }
  }

  /** 검색 결과 강조 (Custom Highlight API 지원 시) */
  highlight(offset, length) {
    this._clearHighlight();
    if (!('highlights' in CSS) || typeof Highlight === 'undefined') return;
    const b = findBlock(this.index, offset);
    const p = this._blockEl(b);
    if (!p || !p.firstChild || p.firstChild.nodeType !== 3) return;
    const t = p.firstChild;
    const k = offset - this.index.starts[b];
    if (k < 0 || k >= t.length) return;
    const range = document.createRange();
    range.setStart(t, k);
    range.setEnd(t, Math.min(t.length, k + length));
    this._highlight = new Highlight(range);
    CSS.highlights.set('tv-search', this._highlight);
  }

  destroy() {
    this._ro.disconnect();
    this._clearHighlight();
    this.viewport.innerHTML = '';
    this.index = null;
  }

  // ---------- 공통 ----------
  _clearHighlight() {
    if (this._highlight && 'highlights' in CSS) CSS.highlights.delete('tv-search');
    this._highlight = null;
  }

  _build() {
    this.viewport.innerHTML = '';
    this.chunk = -1;
    this._win = null;
    this._clearHighlight();
    if (this.mode === 'page') {
      this.viewport.className = 'viewport mode-page';
      const frame = el('div', 'frame');
      const stage = el('div', 'stage');
      const pages = el('div', 'pages');
      stage.appendChild(pages);
      frame.appendChild(stage);
      this.viewport.appendChild(frame);
      this.stage = stage;
      this.pages = pages;
      this._scroller = null;
      this._measure();
    } else {
      this.viewport.className = 'viewport mode-scroll';
      const scroller = el('div', 'scroller');
      const content = el('div', 'scroll-content');
      scroller.appendChild(content);
      this.viewport.appendChild(scroller);
      this._scroller = scroller;
      this._content = content;
      const cs = getComputedStyle(content);
      this._padTop = parseFloat(cs.paddingTop) || 0;
      this._padLeft = parseFloat(cs.paddingLeft) || 0;
      scroller.addEventListener('scroll', () => this._onScroll(), { passive: true });
    }
    this._lastSize = `${this.viewport.clientWidth}x${this.viewport.clientHeight}`;
  }

  _makeBlock(b) {
    const p = el('p');
    const text = blockText(this.index, b);
    p.dataset.block = b;
    p.dataset.start = this.index.starts[b];
    p.dataset.end = this.index.ends[b];
    if (text.length === 0) {
      p.className = 'blank';
    } else {
      if (this.index.conts[b]) p.className = 'cont';
      p.textContent = text;
    }
    return p;
  }

  _fragmentForChunk(c) {
    const [from, to] = chunkRange(this.index, c);
    const frag = document.createDocumentFragment();
    for (let b = from; b < to; b++) frag.appendChild(this._makeBlock(b));
    return frag;
  }

  _blockEl(b) {
    return this.viewport.querySelector(`p[data-block="${b}"]`);
  }

  /** 블록 p 안의 k번째 글자 위치 사각형 */
  _rectAt(p, k) {
    if (!p) return { left: 0, top: 0 };
    const t = p.firstChild;
    if (!t || t.nodeType !== 3 || k <= 0) {
      // 컬럼 경계에서 높이 0짜리 조각이 앞 컬럼에 남을 수 있으므로 실제 높이가 있는 첫 조각을 쓴다.
      const rects = Array.from(p.getClientRects());
      const solid = rects.find((r) => r.height > 0.5);
      return solid || rects[rects.length - 1] || p.getBoundingClientRect();
    }
    k = Math.min(k, t.length - 1);
    const range = document.createRange();
    range.setStart(t, k);
    range.setEnd(t, k + 1);
    const rects = range.getClientRects();
    return rects.length ? rects[0] : range.getBoundingClientRect();
  }

  /**
   * 블록 목록을 순서대로 훑어, 조건(inside)을 처음 만족하는 글자의 오프셋을 찾는다.
   * blockTest(rects) → -1(이전 영역), 0(걸침), 1(이후 영역), 2(블록 전체가 목표 영역에서 시작)
   * charTest(rect) → true면 목표 영역 안
   */
  _firstCharWhere(blocks, blockTest, charTest) {
    for (const p of blocks) {
      let rects = Array.from(p.getClientRects()).filter((r) => r.height > 0.5);
      if (!rects.length) rects = Array.from(p.getClientRects());
      if (!rects.length) continue;
      const r = blockTest(rects);
      if (r === 1) break;
      if (r === -1) continue;
      const start = Number(p.dataset.start);
      if (r === 2) return start;
      const t = p.firstChild;
      if (!t || t.nodeType !== 3) return start;
      const range = document.createRange();
      const rectOf = (k) => {
        range.setStart(t, k);
        range.setEnd(t, k + 1);
        const rs = range.getClientRects();
        return rs.length ? rs[0] : range.getBoundingClientRect();
      };
      let lo = 0;
      let hi = t.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (charTest(rectOf(mid))) hi = mid;
        else lo = mid + 1;
      }
      return start + lo;
    }
    return null;
  }

  // ---------- 페이지 모드 ----------
  _measure() {
    this.W = this.stage.clientWidth;
    this.H = this.stage.clientHeight;
    const s = this.pages.style;
    s.width = `${this.W}px`;
    s.height = `${this.H}px`;
    s.columnWidth = `${this.W}px`;
    s.columnGap = `${GAP}px`;
  }

  _renderChunk(c) {
    this.chunk = c;
    this._clearHighlight();
    this.pages.style.transition = 'none';
    this.pages.style.transform = 'translateX(0)';
    this.pages.replaceChildren(this._fragmentForChunk(c));
    this.pageCount = this._countPages();
    this.page = 0;
  }

  _countPages() {
    const ps = this.pages.children;
    if (!ps.length || this.W <= 0) return 1;
    const base = this.pages.getBoundingClientRect().left;
    let maxLeft = 0;
    // 마지막 몇 개 블록의 마지막 조각 위치로 총 페이지 수를 구한다.
    for (let i = ps.length - 1, n = 0; i >= 0 && n < 3; i--, n++) {
      const rects = ps[i].getClientRects();
      if (rects.length) maxLeft = Math.max(maxLeft, rects[rects.length - 1].left - base);
    }
    const byScroll = (this.pages.scrollWidth + GAP) / (this.W + GAP);
    const byRect = Math.floor((maxLeft + 1) / (this.W + GAP)) + 1;
    return Math.max(1, byRect, Math.round(byScroll));
  }

  _showPage(i, animate) {
    this.page = clamp(i, 0, this.pageCount - 1);
    this._clearHighlight();
    const x = -this.page * (this.W + GAP);
    this.pages.style.transition = animate ? 'transform .14s ease-out' : 'none';
    this.pages.style.transform = `translateX(${x}px)`;
    if (!animate) void this.pages.offsetWidth; // 강제 리플로우로 transition 무시
    this.position = this._computePageStart();
    this._anchor = this.position;
    this.onPosition(this.position);
  }

  /** 현재 페이지의 첫 글자 오프셋 (transform 애니메이션과 무관하게 기하학적으로 계산) */
  _computePageStart() {
    const base = this.pages.getBoundingClientRect().left;
    const pw = this.W + GAP;
    const pageOf = (left) => Math.floor((left - base + 1) / pw);
    const i = this.page;
    const found = this._firstCharWhere(
      this.pages.children,
      (rects) => {
        const first = pageOf(rects[0].left);
        const last = pageOf(rects[rects.length - 1].left);
        if (first > i) return 1;
        if (last < i) return -1;
        return first === i ? 2 : 0;
      },
      (rect) => pageOf(rect.left) >= i,
    );
    return found != null ? found : this.position;
  }

  // ---------- 스크롤 모드 ----------
  _chunkEl(c) {
    const d = el('div', 'chunk');
    d.dataset.chunk = c;
    d.appendChild(this._fragmentForChunk(c));
    return d;
  }

  _renderScrollWindow(first, last) {
    const frag = document.createDocumentFragment();
    for (let c = first; c <= last; c++) frag.appendChild(this._chunkEl(c));
    this._content.replaceChildren(frag);
    this._win = [first, last];
  }

  _onScroll() {
    if (!this.index || this.mode !== 'scroll') return;
    this._extendWindow();
    clearTimeout(this._scrollTimer);
    this._scrollTimer = setTimeout(() => {
      const p = this._computeScrollTop();
      if (p != null) {
        this.position = p;
        this._anchor = p;
        this.onPosition(p);
      }
    }, 150);
  }

  _extendWindow() {
    if (this._busy || !this._win) return;
    const s = this._scroller;
    const H = s.clientHeight;
    const last = this.index.chunkCount - 1;
    this._busy = true;
    try {
      if (s.scrollTop < H && this._win[0] > 0) {
        const c = this._win[0] - 1;
        const node = this._chunkEl(c);
        this._content.prepend(node);
        s.scrollTop += node.offsetHeight;
        this._win[0] = c;
        if (this._win[1] - this._win[0] + 1 > MAX_SCROLL_CHUNKS) {
          this._content.lastElementChild.remove();
          this._win[1]--;
        }
      } else if (s.scrollHeight - (s.scrollTop + H) < H && this._win[1] < last) {
        const c = this._win[1] + 1;
        this._content.appendChild(this._chunkEl(c));
        this._win[1] = c;
        if (this._win[1] - this._win[0] + 1 > MAX_SCROLL_CHUNKS) {
          const firstEl = this._content.firstElementChild;
          const h = firstEl.offsetHeight;
          firstEl.remove();
          s.scrollTop -= h;
          this._win[0]++;
        }
      }
    } finally {
      this._busy = false;
    }
  }

  /** 스크롤 모드: 뷰포트 상단에 걸친 첫 글자 오프셋 */
  _computeScrollTop() {
    if (!this._scroller) return null;
    const top = this._scroller.getBoundingClientRect().top + 1;
    return this._firstCharWhere(
      this._content.querySelectorAll('p'),
      (rects) => {
        const r = rects[0];
        if (r.bottom <= top) return -1;
        return r.top >= top ? 2 : 0;
      },
      (rect) => rect.bottom > top,
    );
  }

  // ---------- 크기 변화 ----------
  _onResize() {
    if (!this.index) return;
    const size = `${this.viewport.clientWidth}x${this.viewport.clientHeight}`;
    if (size === this._lastSize) return;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      if (!this.index) return;
      this._lastSize = size;
      this.relayout();
    }, 120);
  }

  // ---------- 제스처 ----------
  _bindGestures() {
    const v = this.viewport;
    let sx = 0;
    let sy = 0;
    let st = 0;
    let active = false;
    v.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      sx = e.clientX;
      sy = e.clientY;
      st = Date.now();
      active = true;
    });
    v.addEventListener('pointercancel', () => {
      active = false;
    });
    v.addEventListener('pointerup', (e) => {
      if (!active) return;
      active = false;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const dt = Date.now() - st;
      if (this.mode === 'page' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) this.next();
        else this.prev();
        return;
      }
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 500) {
        const w = v.clientWidth;
        const ratio = e.clientX / w;
        if (ratio < 0.3) this.prev();
        else if (ratio > 0.7) this.next();
        else this.onTap();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (!this.index || this.viewport.closest('[hidden]')) return;
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        this.next();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        this.prev();
      }
    });
  }
}
