// 뷰어 엔진
//  - 페이지 모드: CSS 다단 레이아웃 + 가로 이동. 현재 청크 앞뒤를 같은 컨테이너에 이어 붙여
//    청크 경계 없이 넘기고, 1쪽/2쪽 보기와 손가락을 따라오는 드래그 넘김을 지원한다.
//  - 스크롤 모드: 청크 윈도우
import { findBlock, chunkOfBlock, chunkRange, blockText } from './text.js';

const GAP = 40; // 컬럼(페이지) 사이 간격 px. 2쪽 보기에서는 가운데 여백이 된다.
const MAX_SCROLL_CHUNKS = 5;
const SPREAD_MIN_WIDTH = 600; // 자동 모드에서 2쪽 보기로 전환하는 최소 너비 px
const TURN_MS = 280; // 탭/키보드 페이지 넘김 시간
const TURN_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
const DRAG_START_PX = 8; // 이 이상 움직여야 드래그로 인식
const FLICK_VELOCITY = 0.3; // px/ms. 이보다 빠르면 거리와 무관하게 넘긴다
const COMMIT_RATIO = 0.25; // 화면 너비 대비 이 비율 이상 끌면 넘긴다
const RUBBER = 0.3; // 처음/끝에서 끌 때 저항

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
    this.spread = 'auto'; // 'auto' | '1' | '2'
    this.leftNext = false; // 한 손 읽기: 왼쪽 탭도 다음으로
    this.position = 0;
    this._anchor = null; // 마지막 사용자 이동 지점 (재배치 기준)
    this.W = 0;
    this.H = 0;
    this._win = null; // 렌더된 청크 범위 [first, last]
    this._busy = false;
    this._scrollTimer = null;
    this._resizeTimer = null;
    this._lastSize = '';
    this._highlight = null;

    // 페이지 모드 상태
    this.cols = 1; // 한 화면의 페이지(컬럼) 수
    this.colW = 0; // 컬럼 너비
    this.screen = 0; // 현재 화면 번호 (cols개 컬럼 묶음)
    this.screenCount = 1;
    this._chunkEls = new Map(); // 청크 번호 → 래퍼 요소
    this._colRange = new Map(); // 청크 번호 → [첫 컬럼, 마지막 컬럼]
    this._colsSeen = new Map(); // 이번 배치에서 측정된 청크 → 컬럼 수 (쪽수 추정용)
    this._spacer = 0; // 앞쪽 빈 컬럼 수 (2쪽 보기 좌우 짝 유지용)
    this._x = 0; // pages의 현재 translateX
    this._anim = null;
    this._drag = null;
    this._maintainTimer = null;

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

  /** 2쪽 보기 설정: 'auto' | '1' | '2' */
  setSpread(spread) {
    this.spread = spread;
    if (this.mode === 'page' && this.index && this._resolveCols() !== this.cols) this.relayout();
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

  /**
   * 페이지 모드의 쪽수 { page, total }. 전체를 배치하지 않으므로 추정치다.
   * 렌더된 범위는 실제 컬럼 수를 쓰고, 그 앞뒤는 지금까지 측정된 청크들의 "컬럼당 글자 수" 평균으로 환산한다.
   */
  getPageInfo() {
    if (!this.index || this.mode !== 'page' || !this._win || !this._colsSeen.size) return null;
    let chars = 0;
    let cols = 0;
    for (const [c, n] of this._colsSeen) {
      chars += this._chunkCharEnd(c) - this._chunkCharStart(c);
      cols += n;
    }
    const perCol = Math.max(1, chars / Math.max(1, cols));
    const [w0, w1] = this._win;
    const before = Math.round(this._chunkCharStart(w0) / perCol);
    const after = Math.round((this.index.length - this._chunkCharEnd(w1)) / perCol);
    let winCols = 0;
    for (let c = w0; c <= w1; c++) {
      const r = this._colRange.get(c);
      if (r) winCols += r[1] - r[0] + 1;
    }
    const cur = before + this.screen * this.cols - this._spacer; // 현재 화면 첫 컬럼의 전체 기준 번호
    const total = Math.max(1, Math.ceil((before + winCols + after) / this.cols));
    const page = Math.min(total, Math.floor(Math.max(0, cur) / this.cols) + 1);
    return { page, total };
  }

  _chunkCharStart(c) {
    return this.index.starts[this.index.chunkStarts[c]];
  }

  _chunkCharEnd(c) {
    return c + 1 < this.index.chunkCount ? this.index.starts[this.index.chunkStarts[c + 1]] : this.index.length;
  }

  /** 지금 화면에 보이는 글자 범위 [start, end). end는 화면 아래로 벗어난 첫 글자. */
  getVisibleRange() {
    if (!this.index) return [0, 0];
    const start = this.getPosition();
    let end = null;
    if (this.mode === 'scroll') {
      if (this._scroller) {
        const bottom = this._scroller.getBoundingClientRect().bottom - 1;
        end = this._firstCharWhere(
          this._content.querySelectorAll('p'),
          (rects) => {
            if (rects[0].top >= bottom) return 2;
            if (rects[rects.length - 1].bottom <= bottom) return -1;
            return 0;
          },
          (rect) => rect.top >= bottom,
        );
      }
    } else if (this.screen + 1 < this.screenCount) {
      end = this._screenStart(this.screen + 1);
      if (end <= start) end = null; // 다음 화면이 아직 렌더되지 않은 경우
    }
    return [start, end == null ? this.index.length : end];
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
    if (this._drag && this._drag.moved) return;
    if (this.screen >= this.screenCount - 1) {
      this._maintain();
      if (this.screen >= this.screenCount - 1) {
        this.onEdge('end');
        return;
      }
    }
    this._showScreen(this.screen + 1, TURN_MS);
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
    if (this._drag && this._drag.moved) return;
    if (this.screen <= 0) {
      this._maintain();
      if (this.screen <= 0) {
        this.onEdge('start');
        return;
      }
    }
    this._showScreen(this.screen - 1, TURN_MS);
  }

  /** 글자 오프셋으로 이동한다. */
  goTo(offset) {
    if (!this.index) return;
    offset = clamp(Math.floor(offset), 0, Math.max(0, this.index.length - 1));
    this._clearHighlight();
    const b = findBlock(this.index, offset);
    const c = chunkOfBlock(this.index, b);
    if (this.mode === 'page') {
      // 첫 화면은 해당 청크만 그려 빠르게 보여주고, 앞뒤 청크는 다음 프레임에 붙인다.
      if (!this._win || c < this._win[0] || c > this._win[1]) this._renderWindow(c, c);
      this._showScreen(this._screenOfOffset(offset), 0);
      this._anchor = offset;
      this._scheduleMaintain();
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
    this._cancelAnim();
    clearTimeout(this._maintainTimer);
    clearTimeout(this._resizeTimer);
    clearTimeout(this._scrollTimer);
    this._drag = null;
    this._clearHighlight();
    this.viewport.innerHTML = '';
    this.index = null;
  }

  // ---------- 공통 ----------
  clearHighlight() {
    this._clearHighlight();
  }

  _clearHighlight() {
    if (this._highlight && 'highlights' in CSS) CSS.highlights.delete('tv-search');
    this._highlight = null;
  }

  _build() {
    this._cancelAnim();
    clearTimeout(this._maintainTimer);
    this._drag = null;
    this.viewport.innerHTML = '';
    this._win = null;
    this._chunkEls = new Map();
    this._colRange = new Map();
    this._spacer = 0;
    this._x = 0;
    this.screen = 0;
    this.screenCount = 1;
    this._clearHighlight();
    if (this.mode === 'page') {
      this.viewport.className = 'viewport mode-page';
      const frame = el('div', 'frame');
      const stage = el('div', 'stage');
      const track = el('div', 'track'); // 이동(transform) 대상. 2쪽 보기 접힘선도 여기에 그려 함께 움직인다.
      const pages = el('div', 'pages');
      track.appendChild(pages);
      stage.appendChild(track);
      frame.appendChild(stage);
      this.viewport.appendChild(frame);
      this.stage = stage;
      this.track = track;
      this.pages = pages;
      this._scroller = null;
      this._measure();
    } else {
      this.viewport.className = 'viewport mode-scroll';
      delete this.viewport.dataset.cols;
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

  /** 높이가 있는 조각 사각형만 (컬럼 경계에 남는 높이 0 조각 제외) */
  _solidRects(node) {
    const all = Array.from(node.getClientRects());
    const solid = all.filter((r) => r.height > 0.5);
    return solid.length ? solid : all;
  }

  /** 블록 p 안의 k번째 글자 위치 사각형 */
  _rectAt(p, k) {
    if (!p) return { left: 0, top: 0 };
    const t = p.firstChild;
    if (!t || t.nodeType !== 3 || k <= 0) {
      const rects = this._solidRects(p);
      return rects[0] || p.getBoundingClientRect();
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
   * blockTest(rects) → -1(이전 영역), 0(걸침), 1(이후 영역, 중단), 2(블록 전체가 목표 영역에서 시작)
   * charTest(rect) → true면 목표 영역 안
   */
  _firstCharWhere(blocks, blockTest, charTest) {
    for (const p of blocks) {
      const rects = this._solidRects(p);
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

  // ---------- 페이지 모드: 배치 ----------
  _resolveCols() {
    if (this.spread === '1') return 1;
    if (this.spread === '2') return 2;
    return this.W >= SPREAD_MIN_WIDTH ? 2 : 1;
  }

  _measure() {
    this.W = this.stage.clientWidth;
    this.H = this.stage.clientHeight;
    this.cols = this._resolveCols();
    this._colsSeen = new Map(); // 배치 조건이 바뀌면 쪽수 추정도 처음부터
    this.colW = (this.W - (this.cols - 1) * GAP) / this.cols;
    const s = this.pages.style;
    s.width = `${this.W}px`;
    s.height = `${this.H}px`;
    // column-width를 실제 컬럼 너비보다 살짝 작게 주면 브라우저가 정확히 cols개 컬럼으로 채운다.
    s.columnWidth = `${this.cols > 1 ? this.colW - 1 : this.W}px`;
    s.columnGap = `${GAP}px`;
    this.viewport.dataset.cols = String(this.cols);
    // 2쪽 보기 접힘선: 화면 간격(stride)마다 가운데에 1px 선을 반복해 그린다.
    const t = this.track.style;
    if (this.cols === 2) {
      const mid = this.W / 2;
      const stride = this._screenStride();
      t.backgroundImage = `repeating-linear-gradient(to right, transparent 0, transparent ${mid - 0.5}px, var(--border) ${mid - 0.5}px, var(--border) ${mid + 0.5}px, transparent ${mid + 0.5}px, transparent ${stride}px)`;
    } else {
      t.backgroundImage = 'none';
    }
  }

  _colStride() {
    return this.colW + GAP;
  }

  _screenStride() {
    return this.W + GAP;
  }

  /** 좌표 → 컬럼 번호. base는 pages의 왼쪽 좌표(transform 포함) */
  _colOf(left, base) {
    return Math.floor((left - base + 1) / this._colStride());
  }

  _pageChunkEl(c) {
    const d = el('div', 'chunk');
    d.dataset.chunk = c;
    d.appendChild(this._fragmentForChunk(c));
    this._chunkEls.set(c, d);
    return d;
  }

  /** 청크 [first, last]만으로 처음부터 다시 그린다. */
  _renderWindow(first, last) {
    this._cancelAnim();
    this._chunkEls = new Map();
    const frag = document.createDocumentFragment();
    for (let c = first; c <= last; c++) frag.appendChild(this._pageChunkEl(c));
    this.pages.replaceChildren(frag);
    this._spacer = 0;
    this._win = [first, last];
    this._measureChunks();
  }

  _setSpacer(n) {
    const cur = this.pages.querySelectorAll(':scope > .spacer');
    for (let i = cur.length; i > n; i--) cur[i - 1].remove();
    for (let i = cur.length; i < n; i++) this.pages.prepend(el('div', 'spacer'));
    this._spacer = n;
  }

  /** 각 청크가 차지하는 컬럼 범위와 전체 컬럼 수를 잰다. */
  _measureChunks() {
    const base = this.pages.getBoundingClientRect().left;
    const col = (left) => this._colOf(left, base);
    this._colRange = new Map();
    let N = 0;
    for (const [c, d] of this._chunkEls) {
      const ps = d.children;
      if (!ps.length) continue;
      const firstRects = this._solidRects(ps[0]);
      const start = col(firstRects.length ? firstRects[0].left : d.getBoundingClientRect().left);
      let end = start;
      const wrap = this._solidRects(d);
      if (wrap.length) end = Math.max(end, col(wrap[wrap.length - 1].left));
      // 래퍼 조각이 컬럼별로 나오지 않는 브라우저를 대비해 마지막 블록들로도 확인한다.
      for (let i = ps.length - 1, n = 0; i >= 0 && n < 3; i--, n++) {
        const rs = this._solidRects(ps[i]);
        if (rs.length) end = Math.max(end, col(rs[rs.length - 1].left));
      }
      this._colRange.set(c, [start, end]);
      this._colsSeen.set(c, end - start + 1);
      N = Math.max(N, end + 1);
    }
    N = Math.max(N, Math.round((this.pages.scrollWidth + GAP) / this._colStride()));
    this._N = Math.max(1, N);
    this.screenCount = Math.max(1, Math.ceil(this._N / this.cols));
    this.track.style.width = `${this.screenCount * this._screenStride() - GAP}px`;
  }

  /** 컬럼 c0를 포함하거나 그 뒤에서 시작하는 첫 청크 */
  _chunkAtCol(c0) {
    for (let c = this._win[0]; c <= this._win[1]; c++) {
      const r = this._colRange.get(c);
      if (r && r[1] >= c0) return c;
    }
    return this._win[1];
  }

  /** 화면 s의 첫 글자 오프셋 (transform과 무관하게 기하학적으로 계산) */
  _screenStart(s) {
    const c0 = s * this.cols;
    const base = this.pages.getBoundingClientRect().left;
    const col = (left) => this._colOf(left, base);
    for (let c = this._win[0]; c <= this._win[1]; c++) {
      const r = this._colRange.get(c);
      if (!r || r[1] < c0) continue;
      const found = this._firstCharWhere(
        this._chunkEls.get(c).children,
        (rects) => {
          if (col(rects[rects.length - 1].left) < c0) return -1;
          return col(rects[0].left) >= c0 ? 2 : 0;
        },
        (rect) => col(rect.left) >= c0,
      );
      if (found != null) return found;
    }
    return this.position;
  }

  /** 오프셋이 놓인 화면 번호 */
  _screenOfOffset(offset) {
    const b = findBlock(this.index, offset);
    const p = this._blockEl(b);
    if (!p) return 0;
    const rect = this._rectAt(p, offset - this.index.starts[b]);
    const base = this.pages.getBoundingClientRect().left;
    return clamp(Math.floor(this._colOf(rect.left, base) / this.cols), 0, this.screenCount - 1);
  }

  // ---------- 페이지 모드: 이동 ----------
  _setX(x) {
    this.track.style.transition = 'none';
    this.track.style.transform = `translateX(${x}px)`;
    this._x = x;
  }

  /** 애니메이션 중이면 실제 그려진 위치를 읽는다. */
  _currentX() {
    if (!this._anim) return this._x;
    const m = getComputedStyle(this.track).transform;
    const mm = m && m.match(/matrix\((.+)\)/);
    if (mm) {
      const v = mm[1].split(',').map(Number);
      if (Number.isFinite(v[4])) return v[4];
    }
    return this._x;
  }

  _cancelAnim() {
    if (!this._anim) return;
    this.track.removeEventListener('transitionend', this._anim.onEnd);
    clearTimeout(this._anim.timer);
    this._anim = null;
  }

  _animateTo(x, ms, done) {
    const from = this._currentX();
    this._cancelAnim();
    if (Math.abs(from - x) < 0.5) {
      this._setX(x);
      done();
      return;
    }
    const track = this.track;
    this._setX(from);
    void track.offsetWidth; // 시작 위치를 확정한 뒤 전환 시작
    track.style.transition = `transform ${ms}ms ${TURN_EASE}`;
    track.style.transform = `translateX(${x}px)`;
    this._x = x;
    const finish = () => {
      this._cancelAnim();
      track.style.transition = 'none';
      done();
    };
    const onEnd = (e) => {
      if (e.target === track && e.propertyName === 'transform') finish();
    };
    track.addEventListener('transitionend', onEnd);
    this._anim = { onEnd, timer: setTimeout(finish, ms + 100) };
  }

  /** 화면 s로 이동. ms가 0이면 즉시, 아니면 해당 시간 동안 애니메이션 */
  _showScreen(s, ms) {
    s = clamp(s, 0, this.screenCount - 1);
    this._clearHighlight();
    this.screen = s;
    this.position = this._screenStart(s);
    this._anchor = this.position;
    this.onPosition(this.position);
    const x = -s * this._screenStride();
    if (ms > 0) {
      this._animateTo(x, ms, () => this._maintain());
    } else {
      this._cancelAnim();
      this._setX(x);
    }
  }

  _scheduleMaintain() {
    clearTimeout(this._maintainTimer);
    // 첫 화면이 그려진 뒤에 앞뒤 청크를 붙인다.
    this._maintainTimer = setTimeout(() => this._maintain(), 16);
  }

  /**
   * 현재 화면이 속한 청크의 앞뒤 하나씩만 남기도록 청크를 붙이고 뗀다.
   * 청크는 모두 컬럼 맨 위에서 시작하므로(break-before: column) 앞쪽 청크를 떼어도
   * 나머지 배치는 통째로 왼쪽으로 옮겨질 뿐이며, 2쪽 보기의 좌우 짝은 spacer로 유지한다.
   */
  _maintain() {
    clearTimeout(this._maintainTimer);
    this._maintainTimer = null;
    if (!this.index || this.mode !== 'page' || !this._win) return;
    if (this._drag && this._drag.moved) return;
    const total = this.index.chunkCount;
    const cc = this._chunkAtCol(this.screen * this.cols);
    const lo = Math.max(0, cc - 1);
    const hi = Math.min(total - 1, cc + 1);
    let changed = false;
    while (this._win[1] < hi && this._appendChunk()) changed = true;
    while (this._win[0] > lo && this._prependChunk()) changed = true;
    while (this._win[1] > hi && this._removeLast()) changed = true;
    while (this._win[0] < lo && this._removeFirst()) changed = true;
    if (!changed) return;
    this._measureChunks();
    this.screen = this._screenOfOffset(this.position);
    this._setX(-this.screen * this._screenStride());
    this.onPosition(this.position); // 청크가 늘어 쪽수 추정이 바뀌었을 수 있다
  }

  _appendChunk() {
    const c = this._win[1] + 1;
    if (c >= this.index.chunkCount) return false;
    this.pages.appendChild(this._pageChunkEl(c));
    this._win[1] = c;
    return true;
  }

  _prependChunk() {
    const c = this._win[0] - 1;
    if (c < 0) return false;
    const d = this._pageChunkEl(c);
    this.pages.insertBefore(d, this._chunkEls.get(this._win[0]));
    this._win[0] = c;
    this._measureChunks();
    const r = this._colRange.get(c);
    const P = r[1] - r[0] + 1;
    // 앞에 P개 컬럼이 생겼으므로 spacer를 줄여 뒤 청크들의 짝(홀짝)을 유지한다.
    // 책의 맨 앞(청크 0)에는 빈 페이지를 두지 않는다.
    const np = c === 0 ? 0 : (((this._spacer - P) % this.cols) + this.cols) % this.cols;
    if (np !== this._spacer) this._setSpacer(np);
    return true;
  }

  _removeLast() {
    const c = this._win[1];
    if (c <= this._win[0]) return false;
    this._chunkEls.get(c).remove();
    this._chunkEls.delete(c);
    this._colRange.delete(c);
    this._win[1] = c - 1;
    return true;
  }

  _removeFirst() {
    const c = this._win[0];
    if (c >= this._win[1]) return false;
    const r = this._colRange.get(c);
    const R = r ? r[1] - r[0] + 1 : 0;
    this._chunkEls.get(c).remove();
    this._chunkEls.delete(c);
    this._colRange.delete(c);
    this._win[0] = c + 1;
    const np = (this._spacer + R) % this.cols;
    if (np !== this._spacer) this._setSpacer(np);
    return true;
  }

  // ---------- 페이지 모드: 드래그 ----------
  _rubber(x) {
    const minX = -(this.screenCount - 1) * this._screenStride();
    if (x > 0) return x * RUBBER;
    if (x < minX) return minX + (x - minX) * RUBBER;
    return x;
  }

  _endDrag(d, e, cancelled) {
    const stride = this._screenStride();
    const x = this._x;
    const t = -x / stride; // 현재 위치를 화면 단위로
    const stale = e.timeStamp - d.lastT > 80; // 멈춘 뒤 뗐으면 속도 무시
    const vx = cancelled || stale ? 0 : d.vx;
    const baseScreen = Math.round(-d.baseX / stride);
    let target;
    if (vx < -FLICK_VELOCITY) target = Math.ceil(t - 0.01);
    else if (vx > FLICK_VELOCITY) target = Math.floor(t + 0.01);
    else {
      const moved = t - baseScreen;
      target = baseScreen + (moved > COMMIT_RATIO ? 1 : moved < -COMMIT_RATIO ? -1 : 0);
    }
    const max = this.screenCount - 1;
    if (target > max || target < 0) {
      if (Math.abs(t - baseScreen) > 0.08) this.onEdge(target > max ? 'end' : 'start');
      target = clamp(target, 0, max);
    }
    const remain = Math.abs(-target * stride - x);
    const ms = clamp(Math.round((remain / stride) * 320), 140, 320);
    if (target === this.screen) this._animateTo(-target * stride, ms, () => this._maintain());
    else this._showScreen(target, ms);
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

    v.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const old = this._drag;
      if (old) {
        // 같은 포인터가 아직 눌려 있으면 두 번째 손가락으로 보고 무시한다.
        // 다른 포인터면 up/cancel을 놓친 낡은 상태이므로 정리하고 새로 시작한다.
        if (old.id !== e.pointerId && old.moved) this._endDrag(old, e, true);
        else if (old.id !== e.pointerId) this._drag = null;
        else return;
      }
      this._drag = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        st: e.timeStamp,
        moved: false,
        vertical: false,
        baseX: 0,
        lastX: e.clientX,
        lastT: e.timeStamp,
        vx: 0,
      };
    });

    // move/up/cancel은 window에서 받는다. 뷰포트 밖에서 손을 떼거나 대상 요소가
    // 교체된 경우에도 드래그 상태가 남지 않게 하기 위해서다.
    window.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id || d.vertical || this.mode !== 'page' || !this.index) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved) {
        if (Math.abs(dx) >= DRAG_START_PX && Math.abs(dx) > Math.abs(dy)) {
          d.moved = true;
          d.baseX = this._currentX();
          this._cancelAnim();
          this.track.style.transition = 'none';
          try {
            v.setPointerCapture(e.pointerId);
          } catch {
            /* 무시 */
          }
        } else if (Math.abs(dy) >= DRAG_START_PX) {
          d.vertical = true;
          return;
        } else {
          return;
        }
      }
      const dt = e.timeStamp - d.lastT;
      if (dt > 0) d.vx = d.vx * 0.5 + ((e.clientX - d.lastX) / dt) * 0.5;
      d.lastX = e.clientX;
      d.lastT = e.timeStamp;
      this._setX(this._rubber(d.baseX + dx));
    });

    const release = (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      this._drag = null;
      if (d.moved) {
        this._endDrag(d, e, false);
        return;
      }
      if (d.vertical || !this.index) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      const dt = e.timeStamp - d.st;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 500 && v.contains(e.target)) {
        const ratio = e.clientX / v.clientWidth;
        if (ratio < 0.3) this.leftNext ? this.next() : this.prev();
        else if (ratio > 0.7) this.next();
        else this.onTap();
      }
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      this._drag = null;
      if (d.moved) this._endDrag(d, e, true);
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
