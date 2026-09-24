// 共通ユーティリティ: 保存・表示フォーマット・DOM

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('sb.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('sb.' + key, JSON.stringify(value)); } catch { /* 保存不可の環境 */ }
  },
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const nf = {};
function fmtNum(v, digits) {
  const k = digits;
  nf[k] ||= new Intl.NumberFormat('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return nf[k].format(v);
}

// 銘柄ごとの小数桁
export function priceDigits(q) {
  if (!q) return 2;
  const p = Math.abs(q.price ?? 0);
  if (q.type === 'fund') return 0;
  if (q.type === 'fx') return p < 10 ? 4 : 2;
  if (q.type === 'rate') return 3;
  if (q.currency === 'JPY') return p >= 10000 ? 0 : (q.type === 'stock' ? 1 : 2);
  if (p >= 10000) return 0;
  return 2;
}

export function fmtPrice(v, q, { cur = false } = {}) {
  if (v == null || !isFinite(v)) return '—';
  let s = fmtNum(v, priceDigits(q));
  if (q?.type === 'stock' && q.currency === 'JPY' && s.endsWith('.0')) s = s.slice(0, -2);
  if (!cur) return s;
  if (q?.currency === 'USD') return '$' + s;
  if (q?.currency === 'JPY') return s + '円';
  return s;
}

export function fmtChange(v, q) {
  if (v == null || !isFinite(v)) return '—';
  const s = fmtPrice(Math.abs(v), q);
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + s;
}

export function fmtPct(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtNum(Math.abs(v), digits) + '%';
}

export function fmtYen(v, { sign = false } = {}) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v);
  const s = fmtNum(Math.abs(r), 0);
  if (!sign) return (r < 0 ? '−' : '') + '¥' + s;
  return (r > 0 ? '+' : r < 0 ? '−' : '±') + '¥' + s;
}

export function fmtBig(v, currency) {
  if (v == null || !isFinite(v)) return '—';
  if (currency === 'JPY') {
    if (v >= 1e12) return fmtNum(v / 1e12, 2) + '兆円';
    if (v >= 1e8) return fmtNum(v / 1e8, 0) + '億円';
    return fmtNum(v, 0) + '円';
  }
  const pre = currency === 'USD' ? '$' : '';
  if (v >= 1e12) return pre + fmtNum(v / 1e12, 2) + '兆';
  if (v >= 1e8) return pre + fmtNum(v / 1e8, 1) + '億';
  if (v >= 1e4) return pre + fmtNum(v / 1e4, 1) + '万';
  return pre + fmtNum(v, 0);
}

export function fmtVol(v) {
  if (v == null) return '—';
  if (v >= 1e8) return fmtNum(v / 1e8, 2) + '億';
  if (v >= 1e4) return fmtNum(v / 1e4, 1) + '万';
  return fmtNum(v, 0);
}

export const fmtN = (v, d = 2) => (v == null || !isFinite(v) ? '—' : fmtNum(v, d));

export const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

const jstFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const jstDate = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' });
const jstTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (sec) => jstFmt.format(new Date(sec * 1000));
export const fmtDate = (sec) => jstDate.format(new Date(sec * 1000));
export const fmtTime = (sec) => jstTime.format(new Date(sec * 1000));

export function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'たった今';
  if (d < 3600) return Math.floor(d / 60) + '分前';
  if (d < 86400) return Math.floor(d / 3600) + '時間前';
  return Math.floor(d / 86400) + '日前';
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Yahoo のシンボルを入力から推測: 7203 → 7203.T, 0331418A → 0331418A.T
export function normalizeSymbol(input) {
  let s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (/^\d{4}$/.test(s) || /^\d{3}[A-Z]$/.test(s)) return s + '.T';
  if (/^[0-9A-Z]{8}$/.test(s) && /\d/.test(s)) return s + '.T';
  return s;
}

export function guessType(sym) {
  if (/^[0-9A-Z]{8}\.T$/.test(sym)) return 'fund';
  if (sym.startsWith('^')) return 'index';
  if (sym.endsWith('=X')) return 'fx';
  if (sym.endsWith('=F')) return 'future';
  if (/-(JPY|USD)$/.test(sym)) return 'crypto';
  return 'stock';
}
