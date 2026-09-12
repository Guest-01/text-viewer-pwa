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
const APP_VERSION = '0.1.0'; // package.json의 version과 함께 올린다
const SPEED_KEY = 'tv.readSpeed'; // 분당 글자 수 (지수 이동 평균)
const DEFAULT_CPM = 600;
const THEME_COLORS = { light: '#fbfaf7', dark: '#121214' };
const MARGIN_STEP = 4; // 여백 1단계 = 4px
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const MAX_SEARCH_RESULTS = 300;
// 큰 파일: 원본, 디코딩 문자열, 검색 사본이 모두 메모리에 올라가므로 한 번 묻고, 너무 크면 거절한다.
const BIG_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const TEXT_EXT = /\.(txt|text|md|log)$/i;

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

// ---------- 저장 공간 ----------
// 책 원본은 브라우저 저장소(IndexedDB)에만 있다. 기본적으로 기기 공간이 부족하면 브라우저가 지울 수 있으므로
// 첫 책을 넣을 때 영구 저장을 요청하고, 서재 아래에 사용량과 보호 여부를 한 줄로 보여 준다.
const STORAGE_FULL_MSG = '저장 공간이 부족합니다. 기기 저장 공간을 비우거나 안 읽는 책을 지워 주세요';

function isStorageFull(err) {
  return err && (err.name === 'QuotaExceededError' || err.name === 'StorageFullError');
}

async function ensurePersisted() {
  const sm = navigator.storage;
  if (!sm || !sm.persist) return false;
  try {
    return (await sm.persisted()) || (await sm.persist());
  } catch {
    return false;
  }
}

/** 남은 저장 공간(바이트). 알 수 없으면 null. */
async function storageFree() {
  const sm = navigator.storage;
  if (!sm || !sm.estimate) return null;
  try {
    const { quota, usage } = await sm.estimate();
    return Number.isFinite(quota) && Number.isFinite(usage) ? Math.max(0, quota - usage) : null;
  } catch {
    return null;
  }
}

async function renderStorageNote(books) {
  const el = $('#library-storage');
  el.hidden = books.length === 0;
  if (el.hidden) return;
  const total = books.reduce((sum, b) => sum + (b.size || 0), 0);
  const parts = [`${books.length}권`, formatBytes(total)];
  const sm = navigator.storage;
  if (sm && sm.persisted) {
    const persisted = await sm.persisted().catch(() => false);
    parts.push(persisted ? '기기에 보호되어 저장됨' : '브라우저 데이터를 지우면 함께 사라집니다');
  }
  el.textContent = parts.join(' · ');
}

// ---------- 확인 시트 ----------
/** 제목·설명·버튼 두 개짜리 확인 시트. 확인이면 true, 취소나 바깥 탭이면 false. */
function ask({ title, message, ok = '확인', cancel = '취소' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    $('#ask-title').textContent = title;
    $('#ask-message').textContent = message;
    $('#ask-ok').textContent = ok;
    $('#ask-cancel').textContent = cancel;
    $('#ask-ok').onclick = () => { finish(true); closeOverlay(); };
    $('#ask-cancel').onclick = () => { finish(false); closeOverlay(); };
    openOverlay('ov-ask', () => finish(false));
  }).then(
    // 시트를 닫는 history.back()이 끝난 뒤에 다음 이동(pushState)을 하도록 잠깐 기다린다.
    (v) => new Promise((resolve) => setTimeout(() => resolve(v), 80)),
  );
}

/** 파일 크기 문턱: 너무 크면 안내 후 false, 크면 한 번 묻고, 아니면 true. */
async function checkFileSize(bytes, name) {
  if (bytes > MAX_FILE_BYTES) {
    toast(`${name}: ${formatBytes(bytes)}는 너무 커서 열 수 없습니다 (최대 ${formatBytes(MAX_FILE_BYTES)})`, 5000);
    return false;
  }
  if (bytes > BIG_FILE_BYTES) {
    return ask({
      title: name,
      message: `${formatBytes(bytes)}의 큰 파일입니다. 여는 데 시간이 걸리고 검색이 느릴 수 있으며, 기기에 따라 메모리가 부족할 수 있습니다.`,
      ok: '그래도 열기',
    });
  }
  return true;
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
  renderStorageNote(books);
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
  $('#item-rename').onclick = () => {
    closeOverlay();
    setTimeout(() => openRename(book), 30);
  };
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

// 제목 바꾸기: 사용자가 정한 제목은 customTitle로 표시해 첫 줄에서 찾은 제목이 덮어쓰지 않게 한다.
// 비워서 저장하면 다시 자동(첫 줄 제목, 없으면 파일 이름)으로 돌아간다.
function openRename(book) {
  const input = $('#rename-input');
  input.value = bookDisplayTitle(book);
  $('#rename-hint').textContent = `파일 이름: ${book.title}. 비우면 첫 줄에서 찾은 제목이나 파일 이름을 씁니다.`;
  $('#rename-form').onsubmit = async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    closeOverlay();
    const next = value
      ? { ...book, displayTitle: value, customTitle: true }
      : { ...book, displayTitle: '', customTitle: false };
    await db.putBook(next);
    if (state.book && state.book.id === book.id) {
      Object.assign(state.book, { displayTitle: next.displayTitle, customTitle: next.customTitle });
      $('#reader-title').textContent = bookDisplayTitle(state.book);
    }
    showLibrary();
  };
  openOverlay('ov-rename');
  setTimeout(() => { input.focus(); input.select(); }, 60);
}

function confirmDelete(book) {
  $('#confirm-title').textContent = bookDisplayTitle(book);
  $('#confirm-delete').onclick = async () => {
    closeOverlay();
    // 뷰어에서 지우는 경우: 서재로 돌아가며 뷰어를 닫을 때 읽던 위치 저장(flushSave)이 실행돼
    // 방금 지운 책을 되살리므로, 삭제 전에 현재 책과 예약된 저장을 먼저 비운다.
    const fromReader = state.book && state.book.id === book.id;
    if (fromReader) {
      clearTimeout(state.saveTimer);
      state.book = null;
    }
    await db.deleteBook(book.id);
    if (localStorage.getItem(LAST_BOOK_KEY) === book.id) localStorage.removeItem(LAST_BOOK_KEY);
    toast('삭제했습니다');
    if (fromReader) goLibrary();
    else showLibrary();
  };
  openOverlay('ov-confirm');
}

async function importFiles(files) {
  const added = [];
  for (const file of files) {
    try {
      if (!(await checkFileSize(file.size, file.name))) continue;
      const buffer = await file.arrayBuffer();
      added.push(await importBuffer(buffer, file.name));
    } catch (err) {
      console.error(err);
      if (isStorageFull(err)) {
        toast(STORAGE_FULL_MSG, 5000);
        break;
      }
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
  const title = (name || '제목 없음').replace(TEXT_EXT, '');
  const books = await db.listBooks();
  let existing = books.find((b) => b.title === title && b.size === buffer.byteLength);
  let replaced = false;
  if (!existing) {
    // 같은 이름에 내용만 다른 파일(연재물 갱신 등)은 새 책으로 늘리지 않고 원본만 바꿀지 묻는다.
    const same = books.find((b) => b.title === title);
    if (same && (await ask({
      title: bookDisplayTitle(same),
      message: `같은 이름의 책이 서재에 있습니다 (${formatBytes(same.size)} → ${formatBytes(buffer.byteLength)}). 새 파일로 바꾸면 읽던 위치와 책갈피는 유지됩니다.`,
      ok: '새 파일로 바꾸기',
      cancel: '따로 추가',
    }))) {
      existing = same;
      replaced = true;
    }
  }
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
  if (replaced) {
    // 원본 교체: 크기·길이·감지 인코딩은 새 파일 기준으로, 위치와 책갈피는 새 길이 안으로 맞춘다.
    book.size = buffer.byteLength;
    book.detectedEncoding = encoding;
    book.length = text.length;
    book.position = Math.min(book.position || 0, Math.max(0, text.length - 1));
    book.progress = text.length ? book.position / text.length : 0;
    book.bookmarks = (book.bookmarks || []).filter((bm) => bm.offset < text.length);
    if (!book.customTitle) book.displayTitle = buildIndex(text).title || '';
  }
  if (!existing || replaced) {
    // 저장 전에 남은 공간을 확인한다. IndexedDB는 원본보다 조금 더 차지하므로 여유를 둔다.
    const free = await storageFree();
    if (free !== null && free < buffer.byteLength * 1.5) {
      const err = new Error(STORAGE_FULL_MSG);
      err.name = 'StorageFullError';
      throw err;
    }
  }
  await db.saveBook(book, buffer);
  if (!existing) ensurePersisted();
  if (replaced) toast('새 파일로 바꿨습니다');
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
    toast(isStorageFull(err) ? STORAGE_FULL_MSG : '데모 파일을 불러오지 못했습니다 (온라인 필요)', 5000);
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
  // 첫 줄에서 찾은 책 제목은 서재와 상단 바에서 파일명 대신 쓴다 (사용자가 직접 정한 제목은 건드리지 않는다)
  if (!state.book.customTitle && state.index.title && state.index.title !== state.book.displayTitle) {
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
      const oldLen = Math.max(1, state.index.length);
      state.book.encoding = enc.id;
      decodeAndLoad(Math.floor(ratio * state.index.length));
      // 인코딩이 바뀌면 글자 수가 달라지므로 책갈피도 읽던 위치처럼 비율로 옮기고 미리보기를 다시 뽑는다.
      const newLen = state.index.length;
      for (const bm of state.book.bookmarks || []) {
        bm.offset = Math.min(Math.max(0, newLen - 1), Math.round((bm.offset / oldLen) * newLen));
        bm.snippet = snippetAt(state.index, bm.offset);
      }
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
    let added = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('X-File-Name') || '공유된 텍스트.txt');
      const buffer = await res.arrayBuffer();
      if (await checkFileSize(buffer.byteLength, name)) {
        last = await importBuffer(buffer, name);
        added++;
      }
      await cache.delete(req);
    }
    if (added === 1) {
      goBook(last.id, { replace: true });
      return true;
    }
    if (added > 1) toast(`${added}개 파일을 추가했습니다`);
  } catch (err) {
    console.error(err);
    // 공간 부족이면 공유 캐시에 파일이 남아 있어 다음 실행에 다시 시도한다.
    if (isStorageFull(err)) toast(STORAGE_FULL_MSG, 5000);
  }
  return false;
}

// ---------- 초기화 ----------
async function init() {
  applyTheme();
  applyReaderStyle();
  // 저장소(IndexedDB)를 못 열면(일부 브라우저의 시크릿 모드, 저장소 차단 등) 아무것도 할 수 없으니 이유를 보여주고 멈춘다.
  try {
    await db.listBooks();
  } catch (err) {
    console.error('IndexedDB 사용 불가', err);
    $('#library-empty').hidden = true;
    $('#library-fatal').hidden = false;
    $('#library-about').hidden = true;
    $('#btn-open').hidden = true;
    return;
  }
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
    else {
      syncWakeLock();
      // 설치 앱과 브라우저 탭처럼 두 창이 같은 서재를 쓸 수 있으므로 돌아올 때 목록을 다시 읽는다.
      if (document.body.dataset.screen === 'library') showLibrary();
    }
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

  // 정보 시트: 상단 로고와 서재 맨 아래 줄 두 곳에서 연다
  $('#about-version').textContent = 'v' + APP_VERSION;
  $('#about-version-footer').textContent = 'v' + APP_VERSION;
  $('#btn-about').addEventListener('click', () => openOverlay('ov-about'));
  $('#library-about').addEventListener('click', () => openOverlay('ov-about'));

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

init().catch((err) => console.error('초기화 실패', err));

// 디버그/테스트용 노출
window.__tv = { state, db };
