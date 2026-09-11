// 앱 진입점: 라우팅, 서재, 뷰어 화면, 설정/검색/책갈피 UI
import * as db from './db.js';
import { detectEncoding, decodeText, ENCODINGS, encodingLabel } from './encoding.js';
import { buildIndex, snippetAt, tocIndexAt } from './text.js';
import { Reader } from './reader.js';
import { toast, openOverlay, closeOverlay, onLongPress, formatBytes, formatDate, formatMinutes, escapeHtml, uid, haptic, hashHue } from './ui.js';

const SETTINGS_KEY = 'tv.settings';
const LAST_BOOK_KEY = 'tv.lastBook';
const DEFAULT_SETTINGS = {
  fontSize: 18, lineHeight: 1.7, margin: 16, font: 'sans', justify: false,
  theme: 'system', mode: 'page', spread: 'auto', keepAwake: false, leftNext: false, statusBar: true,
};
// 타이포그래피 프리셋: 세부 설정을 만지지 않아도 되는 세 가지 조합
const PRESETS = {
  comfort: { fontSize: 18, lineHeight: 1.7, margin: 16 },
  dense: { fontSize: 16, lineHeight: 1.5, margin: 12 },
  large: { fontSize: 22, lineHeight: 1.8, margin: 16 },
};
const GUIDE_KEY = 'tv.guideShown';
const SPEED_KEY = 'tv.readSpeed'; // 분당 글자 수 (지수 이동 평균)
const DEFAULT_CPM = 600;
const THEME_COLORS = { light: '#fbfaf7', dark: '#121214' };
const MARGIN_STEP = 4; // 여백 1단계 = 4px
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const MAX_SEARCH_RESULTS = 300;

const $ = (sel) => document.querySelector(sel);
const state = {
  settings: loadSettings(),
  book: null,
  buffer: null,
  index: null,
  reader: null,
  saveTimer: null,
  lowerText: null,
  installPrompt: null,
  wakeLock: null,
  search: null, // { results, q, idx } 결과로 이동한 뒤 탐색 바 상태
  speed: { cpm: loadSpeed(), lastPos: null, lastT: 0 }, // 읽기 속도 학습
};

// ---------- 설정 ----------
function loadSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    if (s.theme !== 'system' && !THEME_COLORS[s.theme]) s.theme = 'system'; // 없어진 테마(세피아)가 저장돼 있으면 기기 설정으로
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}
function loadSpeed() {
  const v = Number(localStorage.getItem(SPEED_KEY));
  return v >= 100 && v <= 3000 ? v : DEFAULT_CPM;
}
// 'system'은 기기 테마(prefers-color-scheme)를 따른다. index.html의 인라인 스크립트와 같은 규칙.
function resolveTheme() {
  const t = state.settings.theme;
  if (t === 'system' || !THEME_COLORS[t]) return darkQuery.matches ? 'dark' : 'light';
  return t;
}
function applyTheme() {
  const t = resolveTheme();
  document.documentElement.dataset.theme = t;
  $('#theme-color').setAttribute('content', THEME_COLORS[t]);
}
function applyReaderStyle() {
  const s = state.settings;
  const v = $('#viewport');
  v.style.setProperty('--font-size', `${s.fontSize}px`);
  v.style.setProperty('--line-height', String(s.lineHeight));
  v.style.setProperty('--margin', `${s.margin}px`);
  v.dataset.font = s.font;
  v.dataset.justify = s.justify ? '1' : '';
  v.dataset.status = s.statusBar ? '1' : '';
  $('#status-bar').hidden = !s.statusBar;
  if (state.reader) state.reader.leftNext = s.leftNext;
  $('#btn-mode span').textContent = s.mode === 'page' ? '스크롤 보기' : '페이지 보기';
}
function setSliderValue(input, value) {
  input.value = value;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--pct', `${(((value - min) / (max - min)) * 100).toFixed(2)}%`);
}
function bookDisplayTitle(book) {
  return book.displayTitle || book.title;
}
// 표지 모노그램: 제목의 앞 두 글자 (한글·한자는 그대로, 라틴은 대문자)
function coverLabel(title) {
  const t = title.replace(/^[^\p{L}\p{N}]+/u, '');
  return (t.slice(0, 2) || '?').toUpperCase();
}

// 화면 꺼짐 방지: 뷰어가 보이고 설정이 켜져 있을 때만 잠금을 잡는다.
// 탭 전환·화면 끄기 등으로 잠금이 풀리면 브라우저가 알아서 놓으므로 돌아올 때 다시 잡는다.
async function syncWakeLock() {
  const want = state.settings.keepAwake && state.book && document.visibilityState === 'visible';
  if (want && !state.wakeLock) {
    if (!('wakeLock' in navigator)) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
      state.wakeLock = lock;
    } catch (err) {
      console.warn('wake lock 실패', err);
    }
  } else if (!want && state.wakeLock) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    lock.release().catch(() => {});
  }
}

// ---------- 라우팅 ----------
// 서재 ↔ 뷰어는 해시(#read/id)로 표현한다.
//  - 사용자가 눌러서 들어가는 이동은 history 항목을 쌓아 안드로이드 뒤로가기로 서재에 돌아올 수 있게 한다.
//  - 자동 이어읽기·공유처럼 사용자 조작 없이 일어나는 이동은 항목을 바꿔치기(replace)한다.
//    Chrome은 사용자 조작 없이 쌓인 항목을 뒤로가기에서 건너뛰므로, 그런 항목을 되감으면 앱 밖으로 나가 버린다.
//  - 상단 뒤로가기 버튼도 같은 이유로 history.back()을 쓰지 않고 현재 항목을 서재로 바꿔치기한다.
function route() {
  const m = location.hash.match(/^#read\/(.+)$/);
  if (m) openReader(decodeURIComponent(m[1]));
  else showLibrary();
}
function goBook(id, { replace = false } = {}) {
  const url = `${location.pathname}#read/${encodeURIComponent(id)}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  route();
}
function goLibrary() {
  history.replaceState(null, '', location.pathname);
  route();
}

// ---------- 서재 ----------
async function showLibrary() {
  closeReaderScreen();
  $('#reader').hidden = true;
  $('#library').hidden = false;
  document.body.dataset.screen = 'library';
  const books = await db.listBooks();
  const list = $('#book-list');
  list.innerHTML = '';
  $('#library-empty').hidden = books.length > 0;
  for (const b of books) {
    const li = document.createElement('li');
    li.className = 'book';
    li.dataset.id = b.id;
    const pct = Math.round((b.progress || 0) * 1000) / 10;
    const title = bookDisplayTitle(b);
    const hue = hashHue(b.title);
    li.innerHTML = `
      <div class="book-cover" style="--c1: hsl(${hue} 42% 40%); --c2: hsl(${(hue + 28) % 360} 48% 26%)"><span>${escapeHtml(coverLabel(title))}</span></div>
      <div class="book-main">
        <div class="book-title">${escapeHtml(title)}</div>
        <div class="book-meta">${pct}% · ${formatBytes(b.size)} · ${formatDate(b.lastOpenedAt)}</div>
        <div class="book-progress"><span style="width:${pct}%"></span></div>
      </div>
      <button class="icon-btn book-more" aria-label="파일 메뉴"><svg><use href="#i-more"/></svg></button>`;
    li.addEventListener('click', () => goBook(b.id));
    li.querySelector('.book-more').addEventListener('click', (e) => {
      e.stopPropagation();
      openItemMenu(b);
    });
    onLongPress(li, () => openItemMenu(b));
    list.appendChild(li);
  }
}

// 서재 항목 메뉴 (⋮ 또는 길게 누르기)
function openItemMenu(book) {
  $('#item-title').textContent = bookDisplayTitle(book);
  const pct = Math.round((book.progress || 0) * 1000) / 10;
  const file = book.displayTitle && book.displayTitle !== book.title ? `${book.title}.txt · ` : '';
  $('#item-meta').textContent = `${file}${pct}% 읽음 · ${formatBytes(book.size)} · ${encodingLabel(book.encoding)}`;
  $('#item-restart').onclick = async () => {
    closeOverlay();
    await db.putBook({ ...book, position: 0, progress: 0 });
    goBook(book.id);
  };
  $('#item-delete').onclick = () => {
    closeOverlay();
    setTimeout(() => confirmDelete(book), 30);
  };
  openOverlay('ov-item');
}

function confirmDelete(book) {
  $('#confirm-title').textContent = bookDisplayTitle(book);
  $('#confirm-delete').onclick = async () => {
    closeOverlay();
    await db.deleteBook(book.id);
    if (localStorage.getItem(LAST_BOOK_KEY) === book.id) localStorage.removeItem(LAST_BOOK_KEY);
    toast('삭제했습니다');
    // 뷰어에서 지운 경우 서재로 돌아간다
    if (state.book && state.book.id === book.id) goLibrary();
    else showLibrary();
  };
  openOverlay('ov-confirm');
}

async function importFiles(files) {
  const added = [];
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      added.push(await importBuffer(buffer, file.name));
    } catch (err) {
      console.error(err);
      toast(`열기 실패: ${file.name}`);
    }
  }
  if (added.length === 1) {
    goBook(added[0].id);
  } else if (added.length > 1) {
    toast(`${added.length}개 파일을 추가했습니다`);
    showLibrary();
  }
}

async function importBuffer(buffer, name) {
  const encoding = detectEncoding(buffer);
  const { text } = decodeText(buffer, encoding);
  const title = (name || '제목 없음').replace(/\.txt$/i, '');
  const existing = (await db.listBooks()).find((b) => b.title === title && b.size === buffer.byteLength);
  const book = existing
    ? { ...existing, lastOpenedAt: Date.now() }
    : {
        id: uid(),
        title,
        displayTitle: buildIndex(text).title || '',
        size: buffer.byteLength,
        encoding: 'auto',
        detectedEncoding: encoding,
        length: text.length,
        position: 0,
        progress: 0,
        bookmarks: [],
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
      };
  await db.saveBook(book, buffer);
  return book;
}

async function importDemo(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const buffer = await res.arrayBuffer();
    const name = decodeURIComponent(url.split('/').pop());
    const book = await importBuffer(buffer, name);
    goBook(book.id);
  } catch (err) {
    console.error(err);
    toast('데모 파일을 불러오지 못했습니다 (온라인 필요)');
  }
}

// ---------- 뷰어 ----------
async function openReader(id) {
  const book = await db.getBook(id);
  const buffer = book ? await db.getContent(id) : null;
  if (!book || !buffer) {
    toast('파일을 찾을 수 없습니다');
    goLibrary();
    return;
  }
  state.book = book;
  state.buffer = buffer;
  $('#library').hidden = true;
  $('#reader').hidden = false;
  document.body.dataset.screen = 'reader';
  $('#reader-title').textContent = bookDisplayTitle(book);
  $('#reader-chapter').textContent = '';
  state.speed.lastPos = null;
  setBarsVisible(false);
  applyReaderStyle();
  decodeAndLoad(book.position || 0);
  book.lastOpenedAt = Date.now();
  db.putBook(book);
  localStorage.setItem(LAST_BOOK_KEY, id);
  syncWakeLock();
}

function decodeAndLoad(position) {
  const { text, encoding } = decodeText(state.buffer, state.book.encoding);
  state.index = buildIndex(text);
  state.lowerText = null;
  state.book.detectedEncoding = encoding;
  state.book.length = text.length;
  // 첫 줄에서 찾은 책 제목은 서재와 상단 바에서 파일명 대신 쓴다
  if (state.index.title && state.index.title !== state.book.displayTitle) {
    state.book.displayTitle = state.index.title;
    $('#reader-title').textContent = state.index.title;
  }
  if (!state.reader) {
    state.reader = new Reader($('#viewport'), {
      onPosition: handlePosition,
      onEdge: (edge) => {
        haptic(20);
        toast(edge === 'end' ? '마지막입니다' : '처음입니다', 1000);
      },
      onTap: () => setBarsVisible(!$('#reader').classList.contains('bars-visible')),
    });
  }
  state.reader.setSpread(state.settings.spread);
  state.reader.leftNext = state.settings.leftNext;
  state.reader.load(state.index, position, state.settings.mode);
  if (!localStorage.getItem(GUIDE_KEY)) showGuide();
}

// ---------- 탭 영역 안내 ----------
function showGuide() {
  const s = state.settings;
  const page = s.mode === 'page';
  $('#guide-left-text').textContent = page ? (s.leftNext ? '다음 페이지' : '이전 페이지') : '한 화면 위로';
  $('#guide-right-text').textContent = page ? '다음 페이지' : '한 화면 아래로';
  $('#guide-note').textContent = page ? '좌우로 끌어서 넘길 수도 있습니다.' : '스크롤 모드입니다. 위아래로 밀어 읽습니다.';
  $('#guide').hidden = false;
  localStorage.setItem(GUIDE_KEY, '1');
}

function closeReaderScreen() {
  closeSearchNav();
  if (state.reader) {
    flushSave();
    state.reader.destroy();
    state.reader = null;
  }
  state.book = null;
  state.buffer = null;
  state.index = null;
  state.lowerText = null;
  syncWakeLock();
}

function handlePosition(offset) {
  if (!state.book || !state.index) return;
  const len = Math.max(1, state.index.length);
  const progress = Math.min(1, offset / len);
  state.book.position = offset;
  state.book.progress = progress;
  const pct = (progress * 100).toFixed(1);
  setSliderValue($('#progress'), Math.round(progress * 10000));
  $('#progress-label').textContent = `${pct}%`;
  trackSpeed(offset);
  const toc = state.index.toc;
  const ti = tocIndexAt(state.index, offset);
  $('#reader-chapter').textContent = ti >= 0 ? toc[ti].text : '';
  if (state.settings.statusBar) {
    const parts = [];
    const info = state.reader.getPageInfo();
    if (info) parts.push(`${info.page} / ${info.total}`);
    parts.push(`${pct}%`);
    parts.push(`${formatMinutes((len - offset) / state.speed.cpm)} 남음`);
    $('#status-bar').innerHTML = parts.join('<span class="sep">·</span>');
  }
  updateBookmarkIcon();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.book) db.putBook({ ...state.book }).catch(console.error);
  localStorage.setItem(SPEED_KEY, String(Math.round(state.speed.cpm)));
}

// 읽기 속도 학습: 앞으로 한두 화면 분량을 몇 초~몇 분에 걸쳐 읽었을 때만 표본으로 삼는다.
// 점프·뒤로 넘김·오래 자리를 비운 경우는 제외한다.
function trackSpeed(offset) {
  const sp = state.speed;
  const now = performance.now();
  if (sp.lastPos != null) {
    const dc = offset - sp.lastPos;
    const dt = (now - sp.lastT) / 60000;
    if (dc > 0 && dc < 4000 && dt > 0.05 && dt < 4) {
      const cpm = Math.min(3000, Math.max(100, dc / dt));
      sp.cpm = sp.cpm * 0.8 + cpm * 0.2;
    }
  }
  sp.lastPos = offset;
  sp.lastT = now;
}

function setBarsVisible(visible) {
  $('#reader').classList.toggle('bars-visible', visible);
}

// ---------- 점프와 되돌리기 ----------
// 슬라이더·검색·책갈피로 멀리 이동한 뒤 원래 자리로 돌아올 수 있게 한다.
function jumpTo(offset) {
  if (!state.reader || !state.index) return;
  const from = state.reader.getPosition();
  state.speed.lastPos = null;
  state.reader.goTo(offset);
  const pct = (o) => `${((Math.min(o, state.index.length) / Math.max(1, state.index.length)) * 100).toFixed(1)}%`;
  toast(`${pct(from)} → ${pct(offset)} 이동`, 5000, { label: '이전 위치로', onClick: () => jumpTo(from) });
}

// ---------- 검색 결과 탐색 ----------
function openSearchNav(results, q, idx) {
  state.search = { results, q, idx: -1 };
  jumpTo(results[idx]);
  gotoSearchResult(idx);
}
function gotoSearchResult(i) {
  const s = state.search;
  if (!s || !state.reader) return;
  const n = s.results.length;
  const idx = ((i % n) + n) % n;
  const off = s.results[idx];
  if (idx !== s.idx) {
    s.idx = idx;
    if (state.reader.getPosition() !== off) state.reader.goTo(off);
  }
  state.reader.highlight(off, s.q.length);
  $('#sn-label').innerHTML = `${idx + 1} / ${n}<span class="q">${escapeHtml(s.q)}</span>`;
  $('#search-nav').hidden = false;
}
function closeSearchNav() {
  state.search = null;
  $('#search-nav').hidden = true;
  if (state.reader) state.reader.clearHighlight();
}


// ---------- 책갈피 ----------
// "현재 화면 안에 있는 책갈피"를 기준으로 판단한다. 오프셋이 정확히 같아야만 인식하면
// 스크롤 모드에서 한 줄만 움직여도 빈 아이콘이 되어 쓸모가 없다.
function visibleBookmarkIndex() {
  if (!state.book || !state.reader) return -1;
  const [start, end] = state.reader.getVisibleRange();
  return state.book.bookmarks.findIndex((b) => b.offset >= start && b.offset < end);
}
function updateBookmarkIcon() {
  const has = visibleBookmarkIndex() >= 0;
  $('#btn-bookmark use').setAttribute('href', has ? '#i-bookmark-on' : '#i-bookmark');
  $('#btn-bookmark').setAttribute('aria-label', has ? '책갈피 삭제' : '책갈피 추가');
}
function addBookmarkHere() {
  const pos = state.reader.getPosition();
  if (state.book.bookmarks.some((b) => b.offset === pos)) {
    toast('이미 이 위치에 책갈피가 있습니다');
    return;
  }
  state.book.bookmarks.push({ offset: pos, snippet: snippetAt(state.index, pos), createdAt: Date.now() });
  state.book.bookmarks.sort((a, b) => a.offset - b.offset);
  haptic(12);
  toast('책갈피를 추가했습니다');
  updateBookmarkIcon();
  flushSave();
}
// 삭제는 확인 대신 "실행 취소"로 되돌릴 수 있게 한다.
function removeBookmark(i) {
  const [removed] = state.book.bookmarks.splice(i, 1);
  const book = state.book;
  haptic(12);
  updateBookmarkIcon();
  flushSave();
  if (!$('#ov-bookmarks').hidden) renderBookmarks();
  toast('책갈피를 삭제했습니다', 4000, { label: '실행 취소', onClick: restore });
  function restore() {
    if (state.book !== book) return;
    book.bookmarks.push(removed);
    book.bookmarks.sort((a, b) => a.offset - b.offset);
    updateBookmarkIcon();
    flushSave();
    if (!$('#ov-bookmarks').hidden) renderBookmarks();
  }
}
function toggleBookmark() {
  if (!state.book || !state.reader) return;
  const i = visibleBookmarkIndex();
  if (i >= 0) removeBookmark(i);
  else addBookmarkHere();
}
function renderBookmarks() {
  const list = $('#bookmark-list');
  list.innerHTML = '';
  const bms = state.book ? state.book.bookmarks : [];
  $('#bookmark-empty').hidden = bms.length > 0;
  const len = Math.max(1, state.index.length);
  bms.forEach((bm, i) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `
      <button class="row-main">
        <div class="row-title">${((bm.offset / len) * 100).toFixed(1)}% <span class="muted">· ${formatDate(bm.createdAt)}</span></div>
        <div class="row-sub">${escapeHtml(bm.snippet || '')}</div>
      </button>
      <button class="icon-btn row-del" aria-label="삭제"><svg><use href="#i-delete"/></svg></button>`;
    li.querySelector('.row-main').addEventListener('click', () => {
      closeOverlay();
      jumpTo(bm.offset);
      setBarsVisible(false);
    });
    li.querySelector('.row-del').addEventListener('click', () => removeBookmark(i));
    list.appendChild(li);
  });
}

// ---------- 목차 ----------
function renderToc() {
  const list = $('#toc-list');
  list.innerHTML = '';
  const toc = state.index ? state.index.toc : [];
  $('#toc-empty').hidden = toc.length > 0;
  if (!toc.length) return;
  const len = Math.max(1, state.index.length);
  const cur = tocIndexAt(state.index, state.reader.getPosition());
  const frag = document.createDocumentFragment();
  toc.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<button class="row-main toc-row ${i === cur ? 'active' : ''}">
      <div class="row-sub">${escapeHtml(item.text)}</div>
      <span class="toc-pct">${((item.offset / len) * 100).toFixed(1)}%</span>
    </button>`;
    li.querySelector('button').addEventListener('click', () => {
      closeOverlay();
      jumpTo(item.offset);
      setBarsVisible(false);
    });
    frag.appendChild(li);
  });
  list.appendChild(frag);
  const active = list.querySelector('.active');
  if (active) active.scrollIntoView({ block: 'center' });
}

// ---------- 검색 ----------
function runSearch() {
  const q = $('#search-input').value.trim();
  const list = $('#search-results');
  list.innerHTML = '';
  $('#search-status').textContent = '';
  if (!q || !state.index) return;
  if (!state.lowerText) state.lowerText = state.index.text.toLowerCase();
  const lq = q.toLowerCase();
  const text = state.index.text;
  const results = [];
  let i = -1;
  while (results.length < MAX_SEARCH_RESULTS && (i = state.lowerText.indexOf(lq, i + 1)) !== -1) results.push(i);
  if (!results.length) {
    $('#search-status').textContent = '결과가 없습니다';
    return;
  }
  $('#search-status').textContent = results.length >= MAX_SEARCH_RESULTS ? `${MAX_SEARCH_RESULTS}개 이상` : `${results.length}개`;
  const len = Math.max(1, text.length);
  const frag = document.createDocumentFragment();
  results.forEach((off, idx) => {
    const s = Math.max(0, off - 28);
    const e = Math.min(text.length, off + q.length + 40);
    const before = escapeHtml(text.slice(s, off).replace(/\s+/g, ' '));
    const match = escapeHtml(text.slice(off, off + q.length));
    const after = escapeHtml(text.slice(off + q.length, e).replace(/\s+/g, ' '));
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<button class="row-main">
      <div class="row-title muted">${((off / len) * 100).toFixed(1)}%</div>
      <div class="row-sub">${s > 0 ? '…' : ''}${before}<mark>${match}</mark>${after}${e < text.length ? '…' : ''}</div>
    </button>`;
    li.querySelector('button').addEventListener('click', () => {
      closeOverlay();
      openSearchNav(results, q, idx);
      setBarsVisible(false);
    });
    frag.appendChild(li);
  });
  list.appendChild(frag);
}

// ---------- 설정 시트 ----------
// 설정 변경 진입점. 하단 바의 읽기 방식 버튼도 이 함수를 쓴다.
function updateSetting(key, value) {
  const s = state.settings;
  s[key] = value;
  saveSettings();
  refreshSettingsSheet();
  if (key === 'theme') applyTheme();
  else if (key === 'keepAwake') syncWakeLock();
  else if (key === 'mode') {
    applyReaderStyle();
    if (state.reader) state.reader.setMode(value);
  } else if (key === 'spread') {
    if (state.reader) state.reader.setSpread(value);
  } else {
    applyReaderStyle();
    if (state.reader) state.reader.relayout();
  }
}
function refreshSettingsSheet() {
  const s = state.settings;
  $('#val-font-size').textContent = s.fontSize;
  $('#val-line-height').textContent = s.lineHeight.toFixed(1);
  $('#val-margin').textContent = Math.round(s.margin / MARGIN_STEP); // px 대신 0~12 단계로 표시
  let presetActive = false;
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    const p = PRESETS[btn.dataset.preset];
    const active = Object.keys(p).every((k) => s[k] === p[k]);
    presetActive = presetActive || active;
    btn.classList.toggle('active', active);
  });
  $('#detail-summary').textContent = `크기 ${s.fontSize} · 줄간격 ${s.lineHeight.toFixed(1)} · 여백 ${Math.round(s.margin / MARGIN_STEP)}`;
  // 프리셋에서 벗어난 값이면 사용자가 손댄 상태를 숨기지 않도록 세부 조정을 펼쳐 둔다
  if (!presetActive) setDetailOpen(true);
  document.querySelectorAll('[data-set]').forEach((btn) => {
    btn.classList.toggle('active', String(s[btn.dataset.set]) === btn.dataset.value);
  });
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.setAttribute('aria-checked', s[btn.dataset.toggle] ? 'true' : 'false');
  });
  // 2쪽 보기·한 손 읽기는 페이지 모드에서만 의미가 있다
  $('#row-spread').classList.toggle('disabled', s.mode !== 'page');
  $('#row-left-next').classList.toggle('disabled', s.mode !== 'page');
}
function setDetailOpen(open) {
  $('#detail-rows').hidden = !open;
  $('#btn-detail').setAttribute('aria-expanded', open ? 'true' : 'false');
}
function bindSettings() {
  const s = state.settings;
  $('#btn-detail').addEventListener('click', () => setDetailOpen($('#detail-rows').hidden));
  const stepper = (key, delta, min, max, round = (v) => v) => {
    updateSetting(key, round(Math.min(max, Math.max(min, s[key] + delta))));
  };
  $('#font-size-dec').addEventListener('click', () => stepper('fontSize', -1, 12, 32));
  $('#font-size-inc').addEventListener('click', () => stepper('fontSize', 1, 12, 32));
  $('#line-height-dec').addEventListener('click', () => stepper('lineHeight', -0.1, 1.2, 2.4, (v) => Math.round(v * 10) / 10));
  $('#line-height-inc').addEventListener('click', () => stepper('lineHeight', 0.1, 1.2, 2.4, (v) => Math.round(v * 10) / 10));
  $('#margin-dec').addEventListener('click', () => stepper('margin', -MARGIN_STEP, 0, MARGIN_STEP * 12));
  $('#margin-inc').addEventListener('click', () => stepper('margin', MARGIN_STEP, 0, MARGIN_STEP * 12));
  document.querySelectorAll('[data-set]').forEach((btn) => {
    btn.addEventListener('click', () => updateSetting(btn.dataset.set, btn.dataset.value));
  });
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Object.assign(s, PRESETS[btn.dataset.preset]);
      saveSettings();
      refreshSettingsSheet();
      applyReaderStyle();
      if (state.reader) state.reader.relayout();
    });
  });
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => updateSetting(btn.dataset.toggle, !s[btn.dataset.toggle]));
  });
  $('#btn-reset-settings').addEventListener('click', () => {
    Object.assign(s, DEFAULT_SETTINGS);
    saveSettings();
    refreshSettingsSheet();
    applyTheme();
    applyReaderStyle();
    syncWakeLock();
    if (state.reader) {
      state.reader.setSpread(s.spread);
      state.reader.setMode(s.mode);
      state.reader.relayout();
    }
    toast('설정을 기본값으로 되돌렸습니다');
  });
  refreshSettingsSheet();
}

// ---------- 인코딩 ----------
function renderEncodingSheet() {
  const list = $('#encoding-list');
  list.innerHTML = '';
  for (const enc of ENCODINGS) {
    const li = document.createElement('li');
    const active = state.book.encoding === enc.id;
    const detected = enc.id === 'auto' ? ` (${encodingLabel(state.book.detectedEncoding)})` : '';
    li.innerHTML = `<button class="row-main ${active ? 'active' : ''}">${enc.label}${detected}</button>`;
    li.querySelector('button').addEventListener('click', () => {
      closeOverlay();
      if (state.book.encoding === enc.id) return;
      const ratio = state.book.progress || 0;
      state.book.encoding = enc.id;
      decodeAndLoad(Math.floor(ratio * state.index.length));
      flushSave();
      toast(`인코딩: ${encodingLabel(state.book.detectedEncoding)}`);
    });
    list.appendChild(li);
  }
}

// ---------- 공유 받은 파일 ----------
async function importSharedFiles() {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open('tv-shared');
    const keys = await cache.keys();
    if (!keys.length) return false;
    let last = null;
    for (const req of keys) {
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('X-File-Name') || '공유된 텍스트.txt');
      last = await importBuffer(await res.arrayBuffer(), name);
      await cache.delete(req);
    }
    if (last && keys.length === 1) {
      goBook(last.id, { replace: true });
      return true;
    }
    toast(`${keys.length}개 파일을 추가했습니다`);
  } catch (err) {
    console.error(err);
  }
  return false;
}

// ---------- 초기화 ----------
async function init() {
  applyTheme();
  applyReaderStyle();
  bindSettings();
  darkQuery.addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme(); });

  // 서재
  $('#btn-open').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) importFiles(files);
  });
  document.querySelectorAll('[data-demo]').forEach((btn) => btn.addEventListener('click', () => importDemo(btn.dataset.demo)));

  // 뷰어 상단 바
  $('#btn-back').addEventListener('click', goLibrary);
  $('#btn-bookmark').addEventListener('click', toggleBookmark);
  $('#btn-search').addEventListener('click', () => {
    openOverlay('ov-search');
    setTimeout(() => $('#search-input').focus(), 50);
  });
  $('#btn-more').addEventListener('click', () => {
    const b = state.book;
    $('#info-encoding').textContent = `${encodingLabel(b.encoding)}${b.encoding === 'auto' ? ` → ${encodingLabel(b.detectedEncoding)}` : ''}`;
    $('#info-size').textContent = `${formatBytes(b.size)} · ${b.length.toLocaleString()}자`;
    openOverlay('ov-more');
  });
  $('#menu-encoding').addEventListener('click', () => {
    closeOverlay();
    renderEncodingSheet();
    setTimeout(() => openOverlay('ov-encoding'), 30);
  });
  $('#menu-start').addEventListener('click', () => {
    closeOverlay();
    jumpTo(0);
    setBarsVisible(false);
  });
  $('#menu-guide').addEventListener('click', () => {
    closeOverlay();
    setBarsVisible(false);
    setTimeout(showGuide, 30);
  });
  $('#guide').addEventListener('click', () => { $('#guide').hidden = true; });
  $('#menu-delete').addEventListener('click', () => {
    const book = state.book;
    closeOverlay();
    setTimeout(() => confirmDelete(book), 30);
  });

  // 뷰어 하단 바
  const progress = $('#progress');
  progress.addEventListener('input', () => {
    setSliderValue(progress, Number(progress.value));
    $('#progress-label').textContent = `${(progress.value / 100).toFixed(1)}%`;
  });
  progress.addEventListener('change', () => {
    if (state.reader) jumpTo((progress.value / 10000) * state.index.length);
  });

  // 검색 결과 탐색 바
  $('#sn-prev').addEventListener('click', () => gotoSearchResult(state.search ? state.search.idx - 1 : 0));
  $('#sn-next').addEventListener('click', () => gotoSearchResult(state.search ? state.search.idx + 1 : 0));
  $('#sn-close').addEventListener('click', closeSearchNav);
  $('#sn-label').addEventListener('click', () => openOverlay('ov-search'));
  $('#btn-toc').addEventListener('click', () => {
    renderToc();
    openOverlay('ov-toc');
  });
  $('#btn-bookmarks').addEventListener('click', () => {
    renderBookmarks();
    openOverlay('ov-bookmarks');
  });
  $('#btn-add-bookmark').addEventListener('click', () => {
    if (!state.book || !state.reader) return;
    addBookmarkHere();
    renderBookmarks();
  });
  $('#btn-mode').addEventListener('click', () => {
    const mode = state.settings.mode === 'page' ? 'scroll' : 'page';
    updateSetting('mode', mode);
    toast(mode === 'page' ? '페이지 모드' : '스크롤 모드', 900);
  });
  // 설정은 본문을 보면서 바꿀 수 있게 바를 내리고 연다
  $('#btn-settings').addEventListener('click', () => {
    setBarsVisible(false);
    setDetailOpen(false);
    refreshSettingsSheet(); // 프리셋에서 벗어난 값이면 여기서 세부 조정이 다시 펼쳐진다
    openOverlay('ov-settings');
  });

  // 검색
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
    $('#search-input').blur();
  });

  // 저장 보장
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
    else syncWakeLock();
  });
  window.addEventListener('pagehide', flushSave);

  // 설치 버튼
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('#btn-install').hidden = false;
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $('#btn-install').hidden = true;
  });

  // 웹폰트(명조)가 늦게 도착하면 글자 폭이 바뀌므로 페이지를 다시 배치한다.
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', () => {
      if (state.reader) state.reader.relayout();
    });
  }

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW 등록 실패', err));
  }

  window.addEventListener('hashchange', route);

  // 공유 받은 파일 처리
  const params = new URLSearchParams(location.search);
  if (params.has('shared')) {
    history.replaceState(null, '', location.pathname);
    if (await importSharedFiles()) return;
  }

  // 마지막 책 이어읽기
  if (!location.hash) {
    const lastId = localStorage.getItem(LAST_BOOK_KEY);
    if (lastId && (await db.getBook(lastId))) {
      goBook(lastId, { replace: true });
      return;
    }
  }
  route();
}

init();

// 디버그/테스트용 노출
window.__tv = { state, db };
