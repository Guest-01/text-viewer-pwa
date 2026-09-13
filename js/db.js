// IndexedDB 래퍼: books(메타데이터) / contents(원본 ArrayBuffer) / covers(표지 이미지 Blob)
const DB_NAME = 'text-viewer';
const DB_VERSION = 2; // 2: covers 저장소 추가
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const store = db.createObjectStore('books', { keyPath: 'id' });
        store.createIndex('lastOpenedAt', 'lastOpenedAt');
      }
      if (!db.objectStoreNames.contains('contents')) {
        db.createObjectStore('contents', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('covers')) {
        db.createObjectStore('covers', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function listBooks() {
  const db = await open();
  const tx = db.transaction('books', 'readonly');
  const books = await request(tx.objectStore('books').getAll());
  books.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
  return books;
}

export async function getBook(id) {
  const db = await open();
  return request(db.transaction('books', 'readonly').objectStore('books').get(id));
}

export async function putBook(book) {
  const db = await open();
  const tx = db.transaction('books', 'readwrite');
  tx.objectStore('books').put(book);
  return done(tx);
}

/** 책 메타와 원본 버퍼를 함께 저장한다. */
export async function saveBook(book, buffer) {
  const db = await open();
  const tx = db.transaction(['books', 'contents'], 'readwrite');
  tx.objectStore('books').put(book);
  tx.objectStore('contents').put({ id: book.id, buffer });
  return done(tx);
}

export async function getContent(id) {
  const db = await open();
  const row = await request(db.transaction('contents', 'readonly').objectStore('contents').get(id));
  return row ? row.buffer : null;
}

export async function deleteBook(id) {
  const db = await open();
  const tx = db.transaction(['books', 'contents', 'covers'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('contents').delete(id);
  tx.objectStore('covers').delete(id);
  return done(tx);
}

// ---------- 표지 이미지 (책 id당 Blob 하나) ----------
export async function putCover(id, blob) {
  const db = await open();
  const tx = db.transaction('covers', 'readwrite');
  tx.objectStore('covers').put({ id, blob });
  return done(tx);
}

export async function getCover(id) {
  const db = await open();
  const row = await request(db.transaction('covers', 'readonly').objectStore('covers').get(id));
  return row ? row.blob : null;
}

export async function deleteCover(id) {
  const db = await open();
  const tx = db.transaction('covers', 'readwrite');
  tx.objectStore('covers').delete(id);
  return done(tx);
}
