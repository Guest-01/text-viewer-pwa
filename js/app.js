// 앱 진입점: 라우팅, 서재, 뷰어 화면, 설정/검색/책갈피 UI
import * as db from './db.js';
import { detectEncoding, decodeText, ENCODINGS, encodingLabel } from './encoding.js';
import { buildIndex, snippetAt } from './text.js';
import { Reader } from './reader.js';
import { toast, openOverlay, closeOverlay, onLongPress, formatBytes, formatDate, escapeHtml, uid, isOverlayOpen } from './ui.js';

const SETTINGS_KEY = 'tv.settings';
const LAST_BOOK_KEY = 'tv.lastBook';
const DEFAULT_SETTINGS = { fontSize: 18, lineHeight: 1.7, margin: 16, font: 'sans', theme: 'system', mode: 'page', spread: 'auto' };
const THEME_COLORS = { light: '#ffffff', dark: '#121212', sepia: '#f4ecd8' };
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
  enteredFromLibrary: false,
  lowerText: null,
  installPrompt: null,
};

// ---------- 설정 ----------
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
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
  $('#btn-mode span').textContent = s.mode === 'page' ? '스크롤' : '페이지';
}

// ---------- 라우팅 ----------
function route() {
  const m = location.hash.match(/^#read\/(.+)$/);
  if (m) openReader(decodeURIComponent(m[1]));
  else showLibrary();
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
    li.innerHTML = `
      <div class="book-icon"><svg><use href="#i-file"/></svg></div>
      <div class="book-main">
        <div class="book-title">${escapeHtml(b.title)}</div>
        <div class="book-meta">${pct}% · ${formatBytes(b.size)} · ${formatDate(b.lastOpenedAt)}</div>
        <div class="book-progress"><span style="width:${pct}%"></span></div>
      </div>`;
    li.addEventListener('click', () => {
      state.enteredFromLibrary = true;
      location.hash = `read/${encodeURIComponent(b.id)}`;
    });
    onLongPress(li, () => confirmDelete(b));
    list.appendChild(li);
  }
}

function confirmDelete(book) {
  $('#confirm-title').textContent = book.title;
  $('#confirm-delete').onclick = async () => {
    closeOverlay();
    await db.deleteBook(book.id);
    if (localStorage.getItem(LAST_BOOK_KEY) === book.id) localStorage.removeItem(LAST_BOOK_KEY);
    toast('삭제했습니다');
    showLibrary();
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
    state.enteredFromLibrary = true;
    location.hash = `read/${encodeURIComponent(added[0].id)}`;
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
    state.enteredFromLibrary = true;
    location.hash = `read/${encodeURIComponent(book.id)}`;
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
    location.hash = '';
    return;
  }
  state.book = book;
  state.buffer = buffer;
  $('#library').hidden = true;
  $('#reader').hidden = false;
  document.body.dataset.screen = 'reader';
  $('#reader-title').textContent = book.title;
  setBarsVisible(false);
  applyReaderStyle();
  decodeAndLoad(book.position || 0);
  book.lastOpenedAt = Date.now();
  db.putBook(book);
  localStorage.setItem(LAST_BOOK_KEY, id);
}

function decodeAndLoad(position) {
  const { text, encoding } = decodeText(state.buffer, state.book.encoding);
  state.index = buildIndex(text);
  state.lowerText = null;
  state.book.detectedEncoding = encoding;
  state.book.length = text.length;
  if (!state.reader) {
    state.reader = new Reader($('#viewport'), {
      onPosition: handlePosition,
      onEdge: (edge) => toast(edge === 'end' ? '마지막입니다' : '처음입니다', 1000),
      onTap: () => setBarsVisible(!$('#reader').classList.contains('bars-visible')),
    });
  }
  state.reader.setSpread(state.settings.spread);
  state.reader.load(state.index, position, state.settings.mode);
}

function closeReaderScreen() {
  if (state.reader) {
    flushSave();
    state.reader.destroy();
    state.reader = null;
  }
  state.book = null;
  state.buffer = null;
  state.index = null;
  state.lowerText = null;
}

function handlePosition(offset) {
  if (!state.book || !state.index) return;
  const len = Math.max(1, state.index.length);
  const progress = Math.min(1, offset / len);
  state.book.position = offset;
  state.book.progress = progress;
  const pct = (progress * 100).toFixed(1);
  $('#progress').value = Math.round(progress * 10000);
  $('#progress-label').textContent = `${pct}%`;
  updateBookmarkIcon();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.book) db.putBook({ ...state.book }).catch(console.error);
}

function setBarsVisible(visible) {
  $('#reader').classList.toggle('bars-visible', visible);
}

function goLibrary() {
  if (state.enteredFromLibrary && history.length > 1) history.back();
  else location.hash = '';
  state.enteredFromLibrary = false;
}

// ---------- 책갈피 ----------
function currentBookmarkIndex() {
  if (!state.book) return -1;
  const pos = state.book.position;
  return state.book.bookmarks.findIndex((b) => b.offset === pos);
}
function updateBookmarkIcon() {
  const has = currentBookmarkIndex() >= 0;
  $('#btn-bookmark use').setAttribute('href', has ? '#i-bookmark-on' : '#i-bookmark');
}
function toggleBookmark() {
  if (!state.book || !state.reader) return;
  const pos = state.reader.getPosition();
  const i = state.book.bookmarks.findIndex((b) => b.offset === pos);
  if (i >= 0) {
    state.book.bookmarks.splice(i, 1);
    toast('책갈피를 삭제했습니다');
  } else {
    state.book.bookmarks.push({ offset: pos, snippet: snippetAt(state.index, pos), createdAt: Date.now() });
    state.book.bookmarks.sort((a, b) => a.offset - b.offset);
    toast('책갈피를 추가했습니다');
  }
  updateBookmarkIcon();
  flushSave();
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
      state.reader.goTo(bm.offset);
      setBarsVisible(false);
    });
    li.querySelector('.row-del').addEventListener('click', () => {
      state.book.bookmarks.splice(i, 1);
      flushSave();
      updateBookmarkIcon();
      renderBookmarks();
    });
    list.appendChild(li);
  });
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
  for (const off of results) {
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
      state.reader.goTo(off);
      state.reader.highlight(off, q.length);
      setBarsVisible(false);
    });
    frag.appendChild(li);
  }
  list.appendChild(frag);
}

// ---------- 설정 시트 ----------
function bindSettings() {
  const s = state.settings;
  const refresh = () => {
    $('#val-font-size').textContent = s.fontSize;
    $('#val-line-height').textContent = s.lineHeight.toFixed(1);
    $('#val-margin').textContent = s.margin;
    document.querySelectorAll('[data-set]').forEach((btn) => {
      btn.classList.toggle('active', String(s[btn.dataset.set]) === btn.dataset.value);
    });
  };
  const update = (key, value) => {
    s[key] = value;
    saveSettings();
    refresh();
    if (key === 'theme') applyTheme();
    else if (key === 'mode') {
      applyReaderStyle();
      if (state.reader) state.reader.setMode(value);
    } else if (key === 'spread') {
      if (state.reader) state.reader.setSpread(value);
    } else {
      applyReaderStyle();
      if (state.reader) state.reader.relayout();
    }
  };
  const stepper = (key, delta, min, max, round = (v) => v) => {
    update(key, round(Math.min(max, Math.max(min, s[key] + delta))));
  };
  $('#font-size-dec').addEventListener('click', () => stepper('fontSize', -1, 12, 32));
  $('#font-size-inc').addEventListener('click', () => stepper('fontSize', 1, 12, 32));
  $('#line-height-dec').addEventListener('click', () => stepper('lineHeight', -0.1, 1.2, 2.4, (v) => Math.round(v * 10) / 10));
  $('#line-height-inc').addEventListener('click', () => stepper('lineHeight', 0.1, 1.2, 2.4, (v) => Math.round(v * 10) / 10));
  $('#margin-dec').addEventListener('click', () => stepper('margin', -4, 0, 48));
  $('#margin-inc').addEventListener('click', () => stepper('margin', 4, 0, 48));
  document.querySelectorAll('[data-set]').forEach((btn) => {
    btn.addEventListener('click', () => update(btn.dataset.set, btn.dataset.value));
  });
  refresh();
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
      state.enteredFromLibrary = true;
      location.hash = `read/${encodeURIComponent(last.id)}`;
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
  $('#menu-library').addEventListener('click', () => {
    closeOverlay();
    setTimeout(goLibrary, 30);
  });

  // 뷰어 하단 바
  const progress = $('#progress');
  progress.addEventListener('input', () => {
    $('#progress-label').textContent = `${(progress.value / 100).toFixed(1)}%`;
  });
  progress.addEventListener('change', () => {
    if (state.reader) state.reader.goTo((progress.value / 10000) * state.index.length);
  });
  $('#btn-bookmarks').addEventListener('click', () => {
    renderBookmarks();
    openOverlay('ov-bookmarks');
  });
  $('#btn-mode').addEventListener('click', () => {
    const mode = state.settings.mode === 'page' ? 'scroll' : 'page';
    state.settings.mode = mode;
    saveSettings();
    applyReaderStyle();
    document.querySelectorAll('[data-set="mode"]').forEach((b) => b.classList.toggle('active', b.dataset.value === mode));
    if (state.reader) state.reader.setMode(mode);
    toast(mode === 'page' ? '페이지 모드' : '스크롤 모드', 900);
  });
  $('#btn-settings').addEventListener('click', () => openOverlay('ov-settings'));

  // 검색
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
    $('#search-input').blur();
  });

  // 저장 보장
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
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
      state.enteredFromLibrary = true;
      location.hash = `read/${encodeURIComponent(lastId)}`;
      return;
    }
  }
  route();
}

init();

// 디버그/테스트용 노출
window.__tv = { state, db };
