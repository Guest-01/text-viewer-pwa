// 오버레이(시트/패널) 스택, 토스트, 롱프레스, 포맷 유틸
const stack = [];

export function isOverlayOpen() {
  return stack.length > 0;
}

/** 오버레이를 열고 history 항목을 추가해 안드로이드 뒤로가기로 닫을 수 있게 한다. */
export function openOverlay(id, onClose) {
  const el = document.getElementById(id);
  if (!el || stack.some((s) => s.el === el)) return;
  hideToast(); // 시트 위에 이전 토스트가 겹쳐 보이지 않게
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('open'));
  stack.push({ el, onClose });
  try {
    history.pushState({ overlay: id }, '');
  } catch {
    // history 사용 불가 환경은 무시
  }
}

function hide(entry) {
  entry.el.classList.remove('open');
  const el = entry.el;
  setTimeout(() => {
    if (!el.classList.contains('open')) el.hidden = true;
  }, 200);
  if (entry.onClose) entry.onClose();
}

export function closeOverlay() {
  if (!stack.length) return;
  const entry = stack.pop();
  hide(entry);
  if (history.state && history.state.overlay === entry.el.id) history.back();
}

window.addEventListener('popstate', () => {
  if (stack.length) hide(stack.pop());
});

// 배경 탭으로 닫기
document.addEventListener('click', (e) => {
  const overlay = e.target.closest('.overlay');
  if (overlay && e.target === overlay) closeOverlay();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeOverlay();
});

let toastTimer = null;
/** 토스트. action = { label, onClick } 을 주면 버튼이 달린 토스트가 된다 (실행 취소, 이전 위치로 등). */
export function toast(message, ms = 1800, action = null) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      hideToast();
      action.onClick();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
export function hideToast() {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.classList.remove('show');
  setTimeout(() => {
    if (!el.classList.contains('show')) el.hidden = true;
  }, 200);
}

/** 롱프레스 감지. 롱프레스 후 발생하는 click은 억제한다. */
export function onLongPress(el, handler, ms = 550) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;
  el.addEventListener('pointerdown', (e) => {
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      fired = true;
      handler(e);
    }, ms);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) cancel();
  });
  el.addEventListener(
    'click',
    (e) => {
      if (fired) {
        e.stopPropagation();
        e.preventDefault();
        fired = false;
      }
    },
    true,
  );
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60 * 1000) return '방금 전';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}분 전`;
  if (diff < 24 * 60 * 60 * 1000 && d.getDate() === now.getDate()) return `${Math.floor(diff / 3600000)}시간 전`;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y === now.getFullYear() ? `${m}.${day}` : `${y}.${m}.${day}`;
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
