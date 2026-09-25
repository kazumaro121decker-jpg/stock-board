import {
  store, esc, $, $$, fmtPrice, fmtChange, fmtPct, fmtYen, fmtBig, fmtVol, fmtN, cls,
  fmtDateTime, fmtDate, fmtTime, ago, toast, normalizeSymbol, guessType,
} from './util.js';
import { analyze, signalsFor, smaSeries, RECO } from './indicators.js';
import { sparkline, mountChart } from './chart.js';
import * as gh from './github.js';
import { searchSymbols, setUniverse, universeEntry, universeSize, STARTER } from './symbols.js';

// ===================== 状態 =====================
// 銘柄の一覧・保有数・目標買値はすべて「この端末のブラウザ」に保存する(人ごとに別々)
const DEFAULT_SETTINGS = { theme: 'auto', colors: 'jp', refreshMin: 5, pillMode: 'pct', holdSort: 'value', watchSort: 'change', chartMA: true, startTab: 'home' };
const cachedDoc = store.get('lastDoc', null);
const S = {
  doc: cachedDoc?.v === 2 ? cachedDoc : null,
  served: store.get('lastWatchlist', null),  // data/watchlist.json (マーケット指標・作者のサンプル)
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  my: store.get('my', null),               // {items: [{symbol, list:'hold'|'watch', name}]}
  holdings: store.get('holdings', {}),     // {sym: {qty, cost, fx}}
  targets: store.get('targets', {}),       // {sym: {target, memo}}
  details: new Map(),                      // 詳細チャート用データのキャッシュ
  newsDoc: null,
  tab: 'home',
  newsFilter: 'all',
  loading: false,
  lastFetch: 0,
  installEvt: null,
};
const saveSettings = () => store.set('settings', S.settings);
const saveMy = () => store.set('my', S.my);

const TABS = { home: 'ホーム', hold: '保有銘柄', watch: 'ウォッチ', news: 'ニュース', settings: '設定' };
const PALETTE = ['#5b8def', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b'];

// ===================== データ =====================
const Q = (sym) => S.doc?.quotes?.[sym] || null;
const nameOf = (sym) => universeEntry(sym)?.n || (S.served?.symbols || []).find((x) => x.symbol === sym)?.name || Q(sym)?.name || sym;

function allItems() {
  return (S.my?.items || []).map((it) => {
    const q = Q(it.symbol);
    return { ...it, name: it.name || nameOf(it.symbol), pending: !q || !!q.error, q };
  });
}
const items = (list) => allItems().filter((i) => i.list === list);
const inMyList = (sym) => (S.my?.items || []).some((i) => i.symbol === sym);

// 初回: 旧バージョンで使っていた端末(保有数の入力あり)は、作者の銘柄一覧を引き継ぐ
function initMyList() {
  if (S.my) return;
  const old = store.get('localEdits', null);
  const used = Object.keys(S.holdings).length || Object.keys(S.targets).length || old;
  if (!used) { S.my = { items: [] }; saveMy(); return; }
  if (!S.served) return; // watchlist の読み込み待ち
  const list = (S.served.symbols || []).map((x) => ({ symbol: x.symbol, list: x.list || 'watch', name: x.name }));
  if (old) {
    for (const [sym, it] of Object.entries(old.adds || {})) if (!list.some((x) => x.symbol === sym)) list.push({ symbol: sym, list: it.list || 'watch', name: it.name });
    for (const x of list) if (old.lists?.[x.symbol]) x.list = old.lists[x.symbol];
  }
  S.my = { items: list.filter((x) => !(old?.removes || []).includes(x.symbol)) };
  saveMy();
}

function addToMy(sym, list, name) {
  S.my ||= { items: [] };
  const cur = S.my.items.find((i) => i.symbol === sym);
  if (cur) cur.list = list;
  else S.my.items.push({ symbol: sym, list, ...(name ? { name } : {}) });
  saveMy();
}

function usdjpy() { return Q('JPY=X')?.price || null; }
function fxRate(cur) {
  if (!cur || cur === 'JPY') return 1;
  if (cur === 'USD') return usdjpy();
  if (cur === 'EUR') return Q('EURJPY=X')?.price || null;
  return null;
}
const unitDiv = (q) => (q?.type === 'fund' ? 10000 : 1); // 投信は1万口あたりの基準価額

function position(sym) {
  const h = S.holdings[sym];
  const q = Q(sym);
  if (!h || !(h.qty > 0) || !q || q.price == null) return null;
  const rate = fxRate(q.currency);
  if (rate == null) return null;
  const div = unitDiv(q);
  const valueLocal = (q.price * h.qty) / div;
  const value = valueLocal * rate;
  const dayPL = q.change != null ? ((q.change * h.qty) / div) * rate : 0;
  let cost = null, pl = null, plPct = null;
  if (h.cost > 0) {
    const costLocal = (h.cost * h.qty) / div;
    cost = costLocal * (q.currency === 'USD' && h.fx > 0 ? h.fx : rate);
    pl = value - cost;
    plPct = (pl / cost) * 100;
  }
  return { qty: h.qty, valueLocal, value, dayPL, cost, pl, plPct, rate };
}

function portfolio() {
  let value = 0, dayPL = 0, cost = 0, plValue = 0, n = 0;
  const parts = [];
  for (const it of items('hold')) {
    const p = position(it.symbol);
    if (!p) continue;
    n++; value += p.value; dayPL += p.dayPL;
    if (p.cost != null) { cost += p.cost; plValue += p.value; }
    parts.push({ sym: it.symbol, name: it.name, value: p.value });
  }
  parts.sort((a, b) => b.value - a.value);
  const prev = value - dayPL;
  return { n, value, dayPL, dayPct: prev > 0 ? (dayPL / prev) * 100 : null, pl: cost ? plValue - cost : null, plPct: cost ? ((plValue - cost) / cost) * 100 : null, parts };
}

// ===================== データ取得 =====================
const bust = () => `?_=${Date.now()}`;
async function getJSON(path, fresh = true) {
  const r = await fetch(path + (fresh ? bust() : ''), { cache: fresh ? 'no-store' : 'default' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function refresh({ silent = false } = {}) {
  if (S.loading) return;
  S.loading = true;
  $('#refresh-btn').classList.add('spin');
  try {
    const [doc, wl, uni] = await Promise.allSettled([
      getJSON('data/quotes.json'),
      getJSON('data/watchlist.json'),
      universeSize() ? Promise.resolve(null) : getJSON('data/universe.json'),
    ]);
    if (wl.status === 'fulfilled') { S.served = wl.value; store.set('lastWatchlist', S.served); }
    if (uni.status === 'fulfilled' && uni.value) { setUniverse(uni.value); store.set('universe', uni.value); }
    if (doc.status === 'fulfilled' && doc.value?.v === 2) {
      const changed = doc.value.generatedAt !== S.doc?.generatedAt;
      S.doc = doc.value;
      if (changed) { S.details.clear(); S.newsDoc = null; }
      store.set('lastDoc', S.doc);
      if (!silent && !changed) toast('最新のデータです');
    } else if (!silent) toast('通信できませんでした。前回のデータを表示しています');
    initMyList();
    S.lastFetch = Date.now();
  } finally {
    S.loading = false;
    $('#refresh-btn').classList.remove('spin');
    render();
  }
}

const fileKey = (sym) => sym.replace(/[^A-Za-z0-9.\-]/g, '_');
async function loadDetail(sym) {
  if (S.details.has(sym)) return S.details.get(sym);
  const d = await getJSON(`data/detail/${fileKey(sym)}.json`).catch(() => null);
  if (d) S.details.set(sym, d);
  return d;
}
async function loadNews() {
  if (!S.newsDoc) S.newsDoc = await getJSON('data/news.json').catch(() => ({ news: {} }));
  return S.newsDoc;
}

let timer;
function scheduleAuto() {
  clearInterval(timer);
  const m = +S.settings.refreshMin;
  if (m > 0) timer = setInterval(() => { if (document.visibilityState === 'visible') refresh({ silent: true }); }, m * 60000);
}

// ===================== 市場の開閉 =====================
function zoned(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute };
}
function marketStatus() {
  const out = [];
  const jp = zoned('Asia/Tokyo');
  const jpWeek = !['Sat', 'Sun'].includes(jp.wd);
  let jpS = { k: 'closed', t: '取引時間外' };
  if (jpWeek) {
    if (jp.min >= 540 && jp.min < 690) jpS = { k: 'open', t: '前場 取引中' };
    else if (jp.min >= 690 && jp.min < 750) jpS = { k: 'pre', t: '昼休み' };
    else if (jp.min >= 750 && jp.min < 930) jpS = { k: 'open', t: '後場 取引中' };
  }
  const n225 = Q('^N225');
  if (jpS.k !== 'closed' && n225?.marketTime && Date.now() / 1000 - n225.marketTime > 3 * 3600) jpS = { k: 'closed', t: '休場日' };
  out.push({ name: '東証', ...jpS });

  const us = zoned('America/New_York');
  const usWeek = !['Sat', 'Sun'].includes(us.wd);
  let usS = { k: 'closed', t: '取引時間外' };
  if (usWeek) {
    if (us.min >= 570 && us.min < 960) usS = { k: 'open', t: '取引中' };
    else if (us.min >= 240 && us.min < 570) usS = { k: 'pre', t: 'プレマーケット' };
    else if (us.min >= 960 && us.min < 1200) usS = { k: 'pre', t: 'アフター' };
  }
  const spx = Q('^GSPC');
  if (usS.k === 'open' && spx?.marketTime && Date.now() / 1000 - spx.marketTime > 3 * 3600) usS = { k: 'closed', t: '休場日' };
  out.push({ name: 'NY', ...usS });
  return out;
}

// ===================== 部品 =====================
function lastSession(series) {
  if (!series?.t?.length) return null;
  const t = series.t, c = series.c;
  let i = t.length - 1;
  while (i > 0 && t[i] - t[i - 1] < 3 * 3600 && t[t.length - 1] - t[i - 1] < 24 * 3600) i--;
  return { t: t.slice(i), c: c.slice(i) };
}

function sparkFor(q, w = 64, h = 30) {
  if (!q?.spark) return '';
  const c = q.spark;
  if (q.sparkBase != null) return sparkline(c, { base: q.sparkBase, dir: cls(q.change), w, h });
  return sparkline(c, { dir: cls((c[c.length - 1] ?? 0) - (c[0] ?? 0)), w, h });
}

function pillText(it, mode) {
  const q = it.q;
  if (mode === 'chg') return fmtChange(q.change, q);
  if (mode === 'pl') {
    const p = position(it.symbol);
    return p?.pl != null ? fmtPct(p.plPct, 1) : '損益 —';
  }
  if (mode === 'day') {
    const p = position(it.symbol);
    return p ? fmtYen(p.dayPL, { sign: true }) : fmtPct(q.changePct);
  }
  return fmtPct(q.changePct);
}
const PILL_MODES = { hold: ['pct', 'chg', 'day', 'pl'], watch: ['pct', 'chg'] };
const PILL_LABEL = { pct: '前日比(%)', chg: '前日比(値幅)', day: '本日の損益', pl: '含み損益(%)' };

function pillClass(it, mode) {
  if (mode === 'pl') { const p = position(it.symbol); return cls(p?.pl ?? 0); }
  return cls(it.q.change);
}

function rowHTML(it, { list, extra = true } = {}) {
  const q = it.q;
  const name = esc(it.name || q?.name || it.symbol);
  const code = esc(it.symbol.replace(/\.T$/, ''));
  if (it.pending) {
    return `<button class="row row-pending" data-sym="${esc(it.symbol)}">
      <div class="row-main"><div class="row-name">${name}</div><div class="row-sub">${code}・${q?.error ? '取得できませんでした(コードを確認)' : S.doc ? '株価の取得対象外' : 'データ取得待ち'}</div></div>
      <div class="row-spark"></div><div class="row-right"><span class="pill flat">—</span></div></button>`;
  }
  const mode = PILL_MODES[list]?.includes(S.settings.pillMode) ? S.settings.pillMode : 'pct';
  let extraHTML = '';
  if (extra && list === 'hold') {
    const p = position(it.symbol);
    extraHTML = p
      ? `<div class="row-extra"><span>評価額 <b class="num">${fmtYen(p.value)}</b></span>${p.pl != null ? `<span>損益 <b class="num ${cls(p.pl)}">${fmtYen(p.pl, { sign: true })}</b> <span class="num ${cls(p.pl)}">(${fmtPct(p.plPct, 1)})</span></span>` : ''}</div>`
      : `<div class="row-extra"><span class="muted">タップして保有数・取得単価を入力</span></div>`;
  }
  if (extra && list === 'watch') {
    const a = analyze(q);
    const t = S.targets[it.symbol]?.target;
    const bits = [];
    if (t) {
      const gap = (q.price / t - 1) * 100;
      bits.push(gap <= 0 ? `<span class="chip good">🎯 目標買値 到達</span>` : `<span>目標買値まで <b class="num">あと${gap.toFixed(1)}%</b></span>`);
    }
    if (a?.pos52 != null) bits.push(`<span class="range52">52週 <span class="bar"><i style="left:${Math.max(0, Math.min(100, a.pos52))}%"></i></span></span>`);
    if (a?.rsi != null) bits.push(`<span>RSI <b class="num ${a.rsi <= 30 ? 'up' : a.rsi >= 70 ? 'down' : ''}">${a.rsi.toFixed(0)}</b></span>`);
    if (bits.length) extraHTML = `<div class="row-extra">${bits.join('')}</div>`;
  }
  const tag = q.currency === 'USD' ? 'US' : q.type === 'fund' ? '投信' : q.currency === 'JPY' ? 'JP' : '';
  return `<button class="row" data-sym="${esc(it.symbol)}">
    <div class="row-main"><div class="row-name">${name}</div>
      <div class="row-sub">${tag ? `<span class="tag">${tag}</span>` : ''}<span>${code}</span>${q.stale ? '<span class="chip warn">更新停止</span>' : ''}</div></div>
    <div class="row-spark">${sparkFor(q)}</div>
    <div class="row-right"><span class="row-price num">${fmtPrice(q.price, q)}</span>
      <span class="pill num ${pillClass(it, mode)}" data-pill="${list}">${pillText(it, mode)}</span></div>
    ${extraHTML}
  </button>`;
}

function tileHTML(sym) {
  const q = Q(sym);
  if (!q || q.error) return '';
  const name = (S.served?.markets || []).find((m) => m.symbol === sym)?.name || q.name;
  const pct = q.type === 'rate' ? `${fmtChange(q.change, q)}` : fmtPct(q.changePct);
  return `<button class="tile ${cls(q.change)}" data-sym="${esc(sym)}">
    <span class="t-name">${esc(name)}</span>
    <span class="t-price num">${fmtPrice(q.price, q)}${q.type === 'rate' ? '%' : ''}</span>
    <span class="t-chg num ${cls(q.change)}">${q.type === 'rate' ? pct : `${fmtChange(q.change, q)} (${pct})`}</span>
    <span class="t-spark">${sparkFor(q, 120, 26)}</span>
  </button>`;
}

function newsHTML(n, sym) {
  return `<a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener">
    <div class="news-title">${esc(n.title)}</div>
    <div class="news-meta">${sym ? `<span class="sym">${esc(sym)}</span>` : ''}<span>${esc(n.source || '')}</span>${n.t ? `<span>${ago(n.t)}</span>` : ''}</div></a>`;
}

function allSignals() {
  const out = [];
  for (const it of allItems()) {
    if (it.pending) continue;
    const a = analyze(it.q);
    for (const s of signalsFor(it.q, a, { target: S.targets[it.symbol]?.target })) out.push({ ...s, it });
  }
  const order = { good: 0, warn: 1, bad: 2, info: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

const signalHTML = (s) => `<button class="signal" data-sym="${esc(s.it.symbol)}">
  <span class="s-ico">${s.icon}</span>
  <span class="s-text"><b>${esc(s.it.name || s.it.q?.name)}</b> <span class="chip ${s.level}">${esc(s.label)}</span>${s.desc ? `<div>${esc(s.desc)}</div>` : ''}</span></button>`;

const icoInfo = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>';

// ===================== 画面 =====================
function render() {
  document.title = S.tab === 'home' ? 'マイ株ボード' : `${TABS[S.tab]} | マイ株ボード`;
  $('#page-title').textContent = TABS[S.tab];
  $$('.nav-btn').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === S.tab ? 'page' : 'false'));
  renderHeader();
  const v = $('#view');
  v.innerHTML = ({ home: viewHome, hold: viewHold, watch: viewWatch, news: viewNews, settings: viewSettings })[S.tab]();
  if (S.tab === 'settings') bindSettings();
  const fab = document.querySelector('.fab');
  if (fab) fab.remove();
  if (S.tab === 'hold' || S.tab === 'watch') {
    document.body.insertAdjacentHTML('beforeend', `<button class="fab" data-action="add" aria-label="銘柄を追加"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`);
  }
}

function renderHeader() {
  const el = $('#updated');
  if (S.doc?.generatedAt) {
    const t = Date.parse(S.doc.generatedAt) / 1000;
    el.textContent = `${fmtDateTime(t)} 更新・${ago(t)}`;
    el.classList.toggle('stale', Date.now() / 1000 - t > 2 * 3600);
  } else el.textContent = 'データ未取得';
  $('#market-status').innerHTML = marketStatus().map((m) => `<span class="mstat ${m.k}"><i></i><b>${m.name}</b>${m.t}</span>`).join('')
    + (usdjpy() ? `<span class="mstat"><b>USD/JPY</b><span class="num">${fmtN(usdjpy(), 2)}</span></span>` : '');
}

function setupNotice() {
  if (S.doc) return '';
  return `<div class="notice warn section">${icoInfo}<div><b>まだ株価データがありません。</b><br>
    GitHub Actions の初回実行が終わると、ここに表示されます(数分かかります)。セットアップ手順は README をご覧ください。</div></div>`;
}

function installBanner() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || store.get('installDismissed', false) || !matchMedia('(max-width: 900px)').matches) return '';
  return `<div class="card install-banner"><img src="icons/icon-192.png" alt="">
    <div class="ib-text"><b>ホーム画面に追加</b>アプリのように1タップで毎日すぐ開けます</div>
    <button class="btn primary" data-action="install-help">方法</button>
    <button class="icon-btn" data-action="install-dismiss" aria-label="閉じる"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
}

// はじめて開いた人向け: 銘柄を選んでもらう
function welcomeHTML() {
  const n = S.my?.items?.length || 0;
  if (!S.doc || n >= 5 || (n && store.get('welcomeDone', false))) return '';
  const chips = STARTER.filter((s) => Q(s) && !Q(s).error && !inMyList(s)).map((s) => `<button class="chip info" data-quick="${esc(s)}">＋ ${esc(nameOf(s))}</button>`).join('');
  const sample = (S.served?.symbols || []).length;
  return `<div class="card card-pad section">
    <div class="d-head"><h2 style="margin:0 0 4px;font-size:18px">ようこそ 👋</h2>${n ? '<button class="icon-btn" data-action="welcome-done" aria-label="閉じる"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : ''}</div>
    <p style="margin:0 0 12px" class="small">気になる銘柄を追加すると、値動き・損益・売買シグナルを一目で確認できます。銘柄の一覧や保有数は<b>この端末の中だけ</b>に保存され、他の人には見えません。</p>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn primary" data-action="add" data-list="watch">銘柄を探して追加</button>
      ${sample ? `<button class="btn" data-action="load-sample">サンプル(${sample}銘柄)を読み込む</button>` : ''}
    </div>
    <div class="small muted" style="margin-bottom:6px">人気の銘柄をワンタップで追加(ウォッチに入ります)</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
  </div>`;
}

function summaryHTML() {
  const p = portfolio();
  const holdCount = items('hold').length;
  if (!p.n) {
    return `<div class="card summary"><div class="summary-label">保有資産</div>
      <div class="summary-total">—</div>
      <div class="muted small">保有銘柄(${holdCount})をタップして保有数・取得単価を入力すると、評価額と損益が表示されます。</div>
      <div style="margin-top:10px"><button class="btn" data-tab-go="hold">保有銘柄を開く</button></div></div>`;
  }
  const legend = p.parts.slice(0, 6).map((x, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(x.name)} ${((x.value / p.value) * 100).toFixed(0)}%</span>`).join('');
  return `<div class="card summary">
    <div class="summary-label">保有資産 評価額(円換算)</div>
    <div class="summary-total num">${fmtYen(p.value)}</div>
    <div class="summary-row">
      <div class="summary-item"><span>本日の損益</span><b class="num ${cls(p.dayPL)}">${fmtYen(p.dayPL, { sign: true })} <small>(${fmtPct(p.dayPct)})</small></b></div>
      ${p.pl != null ? `<div class="summary-item"><span>含み損益</span><b class="num ${cls(p.pl)}">${fmtYen(p.pl, { sign: true })} <small>(${fmtPct(p.plPct)})</small></b></div>` : ''}
    </div>
    <div class="alloc" aria-label="資産構成">${p.parts.map((x, i) => `<i style="width:${(x.value / p.value) * 100}%;background:${PALETTE[i % PALETTE.length]}"></i>`).join('')}</div>
    <div class="alloc-legend">${legend}</div>
  </div>`;
}

function viewHome() {
  const markets = S.doc?.markets || (S.served?.markets || []).map((m) => m.symbol);
  const hold = sortItems(items('hold'), 'value').slice(0, 8);
  const watch = sortItems(items('watch'), 'change').slice(0, 6);
  const sigs = allSignals().slice(0, 8);
  const news = (S.doc?.marketNews || []).slice(0, 6);
  return `${installBanner()}${setupNotice()}${welcomeHTML()}
  ${S.my?.items?.length ? `<div class="section">${summaryHTML()}</div>` : ''}
  <div class="section"><div class="section-head"><h2>マーケット</h2></div>
    <div class="tiles ${S.settings.tilesOpen ? '' : 'collapsed'}">${markets.map(tileHTML).join('') || '<div class="muted">—</div>'}</div>
    ${markets.length > 6 ? `<button class="tiles-more" data-set="tilesOpen" data-val="${S.settings.tilesOpen ? '' : '1'}">${S.settings.tilesOpen ? '閉じる ▲' : `すべて表示(ほか${markets.length - 6}件) ▼`}</button>` : ''}</div>
  <div class="grid-2">
    <div>
      <div class="section"><div class="section-head"><h2>保有銘柄</h2><button class="link" data-tab-go="hold">すべて見る</button></div>
        <div class="card list">${hold.map((it) => rowHTML(it, { list: 'hold', extra: false })).join('') || '<div class="empty">保有銘柄はまだありません</div>'}</div></div>
      <div class="section"><div class="section-head"><h2>ウォッチ(買い検討)</h2><button class="link" data-tab-go="watch">すべて見る</button></div>
        <div class="card list">${watch.map((it) => rowHTML(it, { list: 'watch', extra: false })).join('') || `<div class="empty"><b>買いを検討中の銘柄を追加しましょう</b>ウォッチ画面の「＋」から追加できます<div style="margin-top:10px"><button class="btn primary" data-action="add" data-list="watch">銘柄を追加</button></div></div>`}</div></div>
    </div>
    <div>
      <div class="section"><div class="section-head"><h2>注目シグナル</h2></div>
        <div class="card signals">${sigs.map(signalHTML).join('') || '<div class="empty">目立ったシグナルはありません</div>'}</div></div>
      <div class="section"><div class="section-head"><h2>マーケットニュース</h2><button class="link" data-tab-go="news">もっと見る</button></div>
        <div class="card">${news.map((n) => newsHTML(n)).join('') || '<div class="empty">ニュースはまだありません</div>'}</div></div>
    </div>
  </div>
  <p class="muted small" style="margin-top:20px">株価は最大20分程度遅れて表示されます。売買の判断はご自身の責任で行ってください。</p>`;
}

function sortItems(arr, key) {
  const a = [...arr];
  const pend = (x) => (x.pending ? 1 : 0);
  const by = {
    value: (x, y) => (position(y.symbol)?.value ?? -1) - (position(x.symbol)?.value ?? -1),
    change: (x, y) => (y.q?.changePct ?? -999) - (x.q?.changePct ?? -999),
    changeAsc: (x, y) => (x.q?.changePct ?? 999) - (y.q?.changePct ?? 999),
    pl: (x, y) => (position(y.symbol)?.plPct ?? -1e9) - (position(x.symbol)?.plPct ?? -1e9),
    target: (x, y) => gapOf(x) - gapOf(y),
    rsi: (x, y) => (analyze(x.q)?.rsi ?? 999) - (analyze(y.q)?.rsi ?? 999),
    name: (x, y) => (x.name || '').localeCompare(y.name || '', 'ja'),
  }[key] || (() => 0);
  return a.sort((x, y) => pend(x) - pend(y) || by(x, y));
}
function gapOf(it) {
  const t = S.targets[it.symbol]?.target;
  return t && it.q?.price ? it.q.price / t - 1 : 999;
}

function sortSeg(key, opts) {
  return `<div class="seg scroll-x" role="group" aria-label="並び替え">${opts.map(([k, l]) => `<button data-sort="${key}" data-val="${k}" aria-pressed="${S.settings[key] === k}">${l}</button>`).join('')}</div>`;
}

function viewHold() {
  const list = sortItems(items('hold'), S.settings.holdSort);
  const hasPos = list.some((it) => position(it.symbol));
  return `${setupNotice()}
  <div class="section">${summaryHTML()}</div>
  <div class="toolbar">${sortSeg('holdSort', [['value', '評価額'], ['change', '値上がり'], ['changeAsc', '値下がり'], ['pl', '損益率'], ['name', '名前']])}
    <span class="muted small">右端をタップで表示切替: ${PILL_LABEL[PILL_MODES.hold.includes(S.settings.pillMode) ? S.settings.pillMode : 'pct']}</span></div>
  ${hasPos ? '' : `<div class="notice" style="margin-bottom:10px">${icoInfo}<div>銘柄をタップして<b>保有数量</b>と<b>平均取得単価</b>を入力すると、評価額と損益を自動で計算します。入力した内容はこの端末の中だけに保存されます。</div></div>`}
  <div class="card list">${list.map((it) => rowHTML(it, { list: 'hold' })).join('') || '<div class="empty"><b>保有銘柄がありません</b>右下の「＋」から追加できます</div>'}</div>`;
}

function viewWatch() {
  const list = sortItems(items('watch'), S.settings.watchSort);
  return `${setupNotice()}
  <div class="toolbar">${sortSeg('watchSort', [['change', '値上がり'], ['changeAsc', '値下がり'], ['target', '目標に近い'], ['rsi', 'RSIが低い'], ['name', '名前']])}</div>
  <div class="card list">${list.map((it) => rowHTML(it, { list: 'watch' })).join('') || `<div class="empty"><b>ウォッチ銘柄がありません</b>買いを検討している銘柄を追加すると、目標買値までの距離や売られすぎのサインをお知らせします。<div style="margin-top:12px"><button class="btn primary" data-action="add" data-list="watch">銘柄を追加</button></div></div>`}</div>
  <p class="muted small" style="margin-top:12px">目標買値は銘柄をタップして設定できます。RSIが30以下は「売られすぎ」、70以上は「買われすぎ」の目安です。</p>`;
}

function viewNews() {
  if (!S.newsDoc) loadNews().then(() => { if (S.tab === 'news') render(); });
  const newsOf = (sym) => S.newsDoc?.news?.[sym] || [];
  const syms = allItems().filter((it) => newsOf(it.symbol).length);
  const chips = [['all', 'すべて'], ['market', 'マーケット'], ...syms.map((it) => [it.symbol, it.name])];
  let list = [];
  const f = S.newsFilter;
  if (f === 'all' || f === 'market') list.push(...(S.doc?.marketNews || []).map((n) => ({ n, sym: f === 'all' ? '市況' : '' })));
  for (const it of syms) if (f === 'all' || f === it.symbol) list.push(...newsOf(it.symbol).map((n) => ({ n, sym: it.name })));
  const seen = new Set();
  list = list.filter(({ n }) => (seen.has(n.title) ? false : seen.add(n.title))).sort((a, b) => (b.n.t || 0) - (a.n.t || 0));
  return `<div class="toolbar"><div class="seg scroll-x" style="max-width:100%">${chips.map(([k, l]) => `<button data-news="${esc(k)}" aria-pressed="${f === k}">${esc(l)}</button>`).join('')}</div></div>
  <div class="card">${list.slice(0, 60).map(({ n, sym }) => newsHTML(n, sym)).join('') || '<div class="empty">ニュースはまだありません</div>'}</div>
  <p class="muted small" style="margin-top:12px">Google ニュースの見出しを数時間ごとに取得しています。</p>`;
}

function viewSettings() {
  const st = S.settings;
  const c = gh.config();
  const seg = (key, opts) => `<div class="seg">${opts.map(([k, l]) => `<button data-set="${key}" data-val="${k}" aria-pressed="${String(st[key]) === String(k)}">${l}</button>`).join('')}</div>`;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `
  <div class="section"><div class="section-head"><h2>表示</h2></div>
  <div class="card set-group">
    <div class="set-row"><div><div class="set-label">テーマ</div></div>${seg('theme', [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']])}</div>
    <div class="set-row"><div><div class="set-label">値動きの色</div><div class="set-desc">日本式: 上昇=赤・下落=青 / 米国式: 上昇=緑・下落=赤</div></div>${seg('colors', [['jp', '日本式'], ['us', '米国式']])}</div>
    <div class="set-row"><div><div class="set-label">自動で再読み込み</div><div class="set-desc">アプリを開いている間の間隔</div></div>${seg('refreshMin', [['0', 'オフ'], ['1', '1分'], ['5', '5分'], ['15', '15分']])}</div>
    <div class="set-row"><div><div class="set-label">起動時に開く画面</div></div>${seg('startTab', [['home', 'ホーム'], ['hold', '保有'], ['watch', 'ウォッチ']])}</div>
  </div></div>

  <div class="section"><div class="section-head"><h2>スマホのホーム画面に追加</h2></div>
  <div class="card card-pad">
    <p style="margin:0 0 8px">ホーム画面にアイコンを置くと、アプリのように1タップで開けます。開くとすぐに前回のデータが表示され、最新データに自動で更新されます。</p>
    ${S.installEvt ? '<button class="btn primary" data-action="install">ホーム画面に追加する</button>' : ''}
    <div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:6px">
      <div><b>iPhone / iPad (Safari)</b><ol class="steps"><li>Safari でこのページを開く</li><li>画面下の <span class="kbd">共有 ⬆︎</span> をタップ</li><li><span class="kbd">ホーム画面に追加</span> を選び「追加」</li></ol></div>
      <div><b>Android (Chrome)</b><ol class="steps"><li>Chrome でこのページを開く</li><li>右上の <span class="kbd">⋮</span> をタップ</li><li><span class="kbd">ホーム画面に追加</span> または「アプリをインストール」</li></ol></div>
      <div><b>パソコン (Chrome / Edge)</b><ol class="steps"><li>アドレスバー右端の <span class="kbd">インストール</span> アイコンをクリック</li><li>またはブックマークバーに登録</li></ol></div>
    </div>
    ${ios ? '<p class="muted small" style="margin:10px 0 0">ヒント: iPhone の「ショートカット」アプリのオートメーションで、毎朝決まった時刻にこのアプリを開く設定もできます。</p>' : ''}
  </div></div>

  <div class="section"><div class="section-head"><h2>ほかの人にこのアプリを紹介</h2></div>
  <div class="card card-pad">
    <p style="margin:0 0 10px" class="small">このページのURLを送るだけで、だれでも使えます。登録なし・無料です。銘柄の一覧・保有数・目標買値は<b>各自の端末の中だけ</b>に保存されるので、あなたの保有内容が相手に見えることはありません。</p>
    <div class="btn-row">
      <button class="btn primary" data-action="share-app">アプリのURLを送る</button>
      <button class="btn" data-action="share-list" ${S.my?.items?.length ? '' : 'disabled'}>自分の銘柄リストを送る</button>
    </div>
    <p class="muted small" style="margin:8px 0 0">「銘柄リストを送る」は銘柄の名前だけを共有します(保有数や金額は含まれません)。相手がリンクを開くと、同じ銘柄をまとめて追加できます。</p>
  </div></div>

  <div class="section"><div class="section-head"><h2>バックアップ・機種変更</h2></div>
  <div class="card card-pad">
    <p style="margin:0 0 10px" class="small">銘柄の一覧・保有数・取得単価・目標買値はこの端末に保存されています。パソコンとスマホで同じ内容を使うときは、書き出したデータをもう一方で読み込んでください。</p>
    <div class="btn-row"><button class="btn" data-action="export">データを書き出す(コピー)</button><button class="btn" data-action="import">データを読み込む</button></div>
  </div></div>

  <details class="section card card-pad" ${c.token ? 'open' : ''}><summary style="cursor:pointer;font-weight:800">管理者向け: 取得対象の銘柄を増やす (GitHub 連携)</summary>
    <p class="small" style="margin:10px 0">株価は共通の銘柄一覧(約${universeSize() || 250}銘柄)について自動で取得しています。一覧にない銘柄をコードで追加したとき、取得対象に加えるための設定です。<b>アプリの管理者(リポジトリの持ち主)だけ</b>が使います。トークンはこの端末の中だけに保存されます。</p>
    <div class="fields">
      <div class="field"><label for="gh-repo">リポジトリ (ユーザー名/リポジトリ名)</label><input id="gh-repo" value="${esc(c.repo)}" placeholder="yourname/stock-board" autocomplete="off" autocapitalize="off"></div>
      <div class="field"><label for="gh-token">アクセストークン</label><input id="gh-token" type="password" value="${esc(c.token)}" placeholder="github_pat_..." autocomplete="off"></div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" data-action="gh-save">保存して接続テスト</button>
      <button class="btn" data-action="gh-run" ${gh.isConnected() ? '' : 'disabled'}>今すぐ株価を取得</button>
    </div>
    <details style="margin-top:12px"><summary class="small" style="cursor:pointer;font-weight:700">トークンの作り方</summary>
      <ol class="steps"><li>GitHub にログインし <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained token の作成画面</a> を開く</li>
      <li>Repository access で「Only select repositories」→ このアプリのリポジトリを選択</li>
      <li>Permissions の Repository permissions で <b>Contents: Read and write</b>(「今すぐ取得」も使うなら <b>Actions: Read and write</b> も)</li>
      <li>「Generate token」で作成し、表示された文字列を上の欄に貼り付け</li></ol></details>
  </details>

  <div class="section"><div class="section-head"><h2>このアプリについて</h2></div>
  <div class="card card-pad small">
    <p style="margin-top:0">株価: Yahoo Finance(平日は約15分ごとに自動取得、最大20分程度の遅延)。投資信託は1日1回の基準価額(投資信託協会)。ニュース: Google ニュース。</p>
    <p>最終データ更新: ${S.doc?.generatedAt ? fmtDateTime(Date.parse(S.doc.generatedAt) / 1000) : '—'}</p>
    <p style="margin-bottom:0" class="muted">表示される情報とシグナルは参考情報であり、投資の勧誘や助言ではありません。売買の判断はご自身の責任で行ってください。</p>
  </div></div>`;
}

function bindSettings() { /* 入力はクリック委譲で処理 */ }

// ===================== 詳細シート =====================
let unmountChart = null;
function openSheet(html) {
  const sh = $('#sheet'), bd = $('#sheet-backdrop');
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  sh.hidden = false; bd.hidden = false;
  requestAnimationFrame(() => { sh.classList.add('show'); bd.classList.add('show'); });
  document.body.style.overflow = 'hidden';
  if (location.hash !== '#sheet') history.pushState({ sheet: true }, '', '#sheet');
}
function closeSheet(fromPop = false) {
  const sh = $('#sheet'), bd = $('#sheet-backdrop');
  if (sh.hidden) return;
  sh.classList.remove('show'); bd.classList.remove('show');
  document.body.style.overflow = '';
  unmountChart?.(); unmountChart = null;
  setTimeout(() => { sh.hidden = true; bd.hidden = true; }, 220);
  if (!fromPop && location.hash === '#sheet') history.back();
}

function extLinks(sym, q) {
  const code = sym.replace(/\.T$/, '');
  const jp = sym.endsWith('.T');
  const links = [];
  if (q?.type === 'fund') links.push(['Yahoo!ファイナンス', `https://finance.yahoo.co.jp/quote/${code}`]);
  else if (jp) {
    links.push(['Yahoo!ファイナンス', `https://finance.yahoo.co.jp/quote/${sym}`], ['株探', `https://kabutan.jp/stock/?code=${code}`], ['TradingView', `https://jp.tradingview.com/chart/?symbol=TSE:${code}`]);
  } else if (q?.type === 'stock') {
    links.push(['Yahoo!ファイナンス', `https://finance.yahoo.co.jp/quote/${sym}`], ['株探US', `https://us.kabutan.jp/stocks/${sym}`], ['TradingView', `https://jp.tradingview.com/chart/?symbol=${sym}`], ['Yahoo Finance(英)', `https://finance.yahoo.com/quote/${sym}`]);
  } else {
    links.push(['Yahoo Finance', `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`]);
  }
  return links.map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener">${l} ↗</a>`).join('');
}

function openDetail(sym) {
  const it = allItems().find((i) => i.symbol === sym);
  const market = (S.served?.markets || []).find((m) => m.symbol === sym);
  const q = Q(sym);
  const list = it?.list || null;
  const name = market?.name || it?.name || q?.name || sym;
  if (!q || q.error) {
    openSheet(`<div class="d-head"><div><h2 class="d-title" id="sheet-title">${esc(name)}</h2><div class="d-sym">${esc(sym)}</div></div>${closeBtn()}</div>
      <div class="notice warn" style="margin-top:14px">${icoInfo}<div>${q?.error ? 'このコードでは株価を取得できませんでした。コードが正しいか確認してください(日本株は「7203」のように4桁、米国株はティッカー)。' : S.doc ? 'この銘柄は、まだ株価の自動取得の対象に入っていません。アプリの管理者が取得対象に追加すると表示されるようになります。' : 'まだ株価データがありません。'}</div></div>
      ${list ? manageHTML(sym, list) : ''}`);
    return;
  }
  const a = analyze(q);
  const f = q.fundamentals || {};
  const hasIntra = !!q.hasIntraday;
  const ranges = [['1D', '1日'], ['5D', '5日'], ['1M', '1ヶ月'], ['6M', '6ヶ月'], ['1Y', '1年'], ['5Y', '5年']].filter(([k]) => (hasIntra || !['1D', '5D'].includes(k)) && (k !== '5Y' || q.hasWeekly));
  const range = store.get('range', '1D');
  const cur = ranges.some(([k]) => k === range) ? range : ranges[0][0];
  const sigs = signalsFor(q, a, { target: S.targets[sym]?.target });

  const stat = (l, v) => `<div class="stat"><span>${l}</span><b class="num">${v}</b></div>`;
  const statsArr = [
    stat('前日終値', fmtPrice(q.prevClose, q)),
    q.dayHigh ? stat('高値', fmtPrice(q.dayHigh, q)) : '',
    q.dayLow ? stat('安値', fmtPrice(q.dayLow, q)) : '',
    q.volume ? stat('出来高', fmtVol(q.volume)) : '',
    stat('52週高値', fmtPrice(a?.hi, q)),
    stat('52週安値', fmtPrice(a?.lo, q)),
    a?.fromHigh != null ? stat('高値から', `<span class="${cls(a.fromHigh)}">${fmtPct(a.fromHigh, 1)}</span>`) : '',
    a?.ret1w != null ? stat('1週間', `<span class="${cls(a.ret1w)}">${fmtPct(a.ret1w, 1)}</span>`) : '',
    a?.ret1m != null ? stat('1ヶ月', `<span class="${cls(a.ret1m)}">${fmtPct(a.ret1m, 1)}</span>`) : '',
    a?.ret6m != null ? stat('6ヶ月', `<span class="${cls(a.ret6m)}">${fmtPct(a.ret6m, 1)}</span>`) : '',
    a?.ytd != null ? stat('年初来', `<span class="${cls(a.ytd)}">${fmtPct(a.ytd, 1)}</span>`) : '',
    f.marketCap ? stat('時価総額', fmtBig(f.marketCap, q.currency)) : '',
    f.pe ? stat('PER(実績)', fmtN(f.pe, 1) + '倍') : '',
    f.forwardPe ? stat('PER(予想)', fmtN(f.forwardPe, 1) + '倍') : '',
    f.pb ? stat('PBR', fmtN(f.pb, 2) + '倍') : '',
    f.divYield ? stat('配当利回り', fmtN(f.divYield * 100, 2) + '%') : '',
    f.beta ? stat('ベータ', fmtN(f.beta, 2)) : '',
    f.earningsDate ? stat('次回決算', fmtDate(f.earningsDate)) : '',
  ].join('');

  const tech = a ? `<div class="stats">
      ${stat('RSI(14日)', a.rsi != null ? `<span class="${a.rsi <= 30 ? 'up' : a.rsi >= 70 ? 'down' : ''}">${a.rsi.toFixed(0)}</span>` : '—')}
      ${stat('25日線乖離', a.dev25 != null ? `<span class="${cls(a.dev25)}">${fmtPct(a.dev25, 1)}</span>` : '—')}
      ${stat('75日線乖離', a.dev75 != null ? `<span class="${cls(a.dev75)}">${fmtPct(a.dev75, 1)}</span>` : '—')}
      ${stat('25日移動平均', fmtPrice(a.ma25, q))}
      ${stat('75日移動平均', fmtPrice(a.ma75, q))}
      ${stat('200日移動平均', fmtPrice(a.ma200, q))}
    </div>
    ${a.rsi != null ? `<div class="gauge" style="margin-top:14px"><div class="small" style="font-weight:700;margin-bottom:6px">RSI: 売られすぎ ⇔ 買われすぎ</div><div class="gauge-bar"><i style="left:${a.rsi}%"></i></div><div class="gauge-labels"><span>0 売られすぎ</span><span>30</span><span>50</span><span>70</span><span>買われすぎ 100</span></div></div>` : ''}` : '';

  const analyst = f.targetMean ? `<div class="section"><div class="section-head"><h2>アナリスト予想</h2><span class="muted small">${f.analysts ? `${f.analysts}人` : ''}</span></div>
    <div class="card card-pad"><div class="pos-grid">
      <div><span>評価</span><b>${esc(RECO[f.recommendation] || f.recommendation || '—')}</b></div>
      <div><span>目標株価(平均)</span><b class="num">${fmtPrice(f.targetMean, q)} <small class="${cls(f.targetMean - q.price)}">${fmtPct((f.targetMean / q.price - 1) * 100, 1)}</small></b></div>
      ${f.targetHigh ? `<div><span>目標(最高)</span><b class="num">${fmtPrice(f.targetHigh, q)}</b></div>` : ''}
      ${f.targetLow ? `<div><span>目標(最低)</span><b class="num">${fmtPrice(f.targetLow, q)}</b></div>` : ''}
    </div></div></div>` : '';

  openSheet(`
    <div class="d-head"><div style="min-width:0"><h2 class="d-title" id="sheet-title">${esc(name)}</h2>
      <div class="d-sym">${esc(sym.replace(/\.T$/, ''))}${q.exchange ? '・' + esc(q.exchange) : ''}${q.currency ? '・' + esc(q.currency) : ''}${f.sector ? '・' + esc(f.sector) : ''}</div></div>${closeBtn()}</div>
    <div class="d-price num">${fmtPrice(q.price, q)}${q.type === 'rate' ? '%' : ''}</div>
    <div class="d-chg num ${cls(q.change)}">${fmtChange(q.change, q)} (${fmtPct(q.changePct)}) <span class="muted small">前日比</span></div>
    <div class="d-time">${q.type === 'fund' ? '基準価額 ' + fmtDate(q.marketTime) : fmtDateTime(q.marketTime) + ' 時点'}${q.stale ? '・<span style="color:var(--warn)">最新の取得に失敗(前回の値)</span>' : ''}</div>
    <div class="chart-wrap" id="chart"><div class="skeleton" style="height:100%"></div></div>
    <div class="seg range-tabs" role="group" aria-label="期間">${ranges.map(([k, l]) => `<button data-range="${k}" aria-pressed="${k === cur}">${l}</button>`).join('')}</div>
    <div class="chart-opts"><label><input type="checkbox" id="ma-toggle" ${S.settings.chartMA ? 'checked' : ''}> 移動平均線 <span style="color:#f59e0b">━25日</span> <span style="color:#8b5cf6">━75日</span></label></div>

    ${sigs.length ? `<div class="section"><div class="section-head"><h2>シグナル</h2></div><div class="card signals">${sigs.map((s) => signalHTML({ ...s, it: { symbol: sym, name, q } })).join('')}</div></div>` : ''}
    ${list ? manageHTML(sym, list) : market ? '' : `<div class="section btn-row"><button class="btn primary" data-action="quick-add" data-sym="${esc(sym)}" data-list="watch">＋ ウォッチに追加</button><button class="btn" data-action="quick-add" data-sym="${esc(sym)}" data-list="hold">＋ 保有銘柄に追加</button></div>`}
    <div class="section"><div class="section-head"><h2>株価情報</h2></div><div class="card card-pad" style="padding-top:4px"><div class="stats">${statsArr}</div></div></div>
    ${tech ? `<div class="section"><div class="section-head"><h2>テクニカル指標</h2></div><div class="card card-pad" style="padding-top:4px">${tech}</div></div>` : ''}
    ${analyst}
    <div id="d-news"></div>
    <div class="section"><div class="section-head"><h2>くわしく見る</h2></div><div class="links">${extLinks(sym, q)}</div></div>
    ${list ? `<div class="section btn-row"><button class="btn" data-action="move" data-sym="${esc(sym)}" data-to="${list === 'hold' ? 'watch' : 'hold'}">${list === 'hold' ? 'ウォッチへ移動' : '保有銘柄へ移動'}</button><button class="btn danger" data-action="remove" data-sym="${esc(sym)}">一覧から削除</button></div>` : ''}
  `);
  curDetail = null;
  bindDetail(sym, q);
  loadDetail(sym).then((d) => {
    if ($('#sheet-title')?.textContent !== name) return; // 別の銘柄に切り替わった
    curDetail = d;
    drawDetailChart(q, $('#sheet-body [data-range][aria-pressed="true"]')?.dataset.range || cur);
  });
  if (!market) loadNews().then((nd) => {
    const n = nd?.news?.[sym];
    const el = $('#d-news');
    if (el && n?.length) el.innerHTML = `<div class="section"><div class="section-head"><h2>ニュース</h2></div><div class="card">${n.map((x) => newsHTML(x)).join('')}</div></div>`;
  });
}
let curDetail = null;

const closeBtn = () => `<button class="icon-btn" data-action="close" aria-label="閉じる"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;

function manageHTML(sym, list) {
  const q = Q(sym);
  if (list === 'hold') {
    const h = S.holdings[sym] || {};
    const p = position(sym);
    const fund = q?.type === 'fund';
    const usd = q?.currency === 'USD';
    return `<div class="section"><div class="section-head"><h2>保有状況</h2><span class="muted small">この端末に保存</span></div>
    <div class="card card-pad">
      ${p ? `<div class="pos-grid" style="margin-bottom:14px">
        <div><span>評価額</span><b class="num">${fmtYen(p.value)}</b>${usd ? `<div class="muted small num">$${fmtN(p.valueLocal, 2)}</div>` : ''}</div>
        <div><span>本日の損益</span><b class="num ${cls(p.dayPL)}">${fmtYen(p.dayPL, { sign: true })}</b></div>
        <div><span>含み損益</span><b class="num ${cls(p.pl)}">${p.pl != null ? fmtYen(p.pl, { sign: true }) : '—'}</b></div>
        <div><span>損益率</span><b class="num ${cls(p.pl)}">${p.plPct != null ? fmtPct(p.plPct) : '—'}</b></div>
      </div>` : ''}
      <div class="fields">
        <div class="field"><label for="h-qty">保有数量(${fund ? '口' : '株'})</label><input id="h-qty" type="number" inputmode="decimal" min="0" step="any" value="${h.qty ?? ''}" placeholder="${fund ? '例: 500000' : '例: 10'}"></div>
        <div class="field"><label for="h-cost">平均取得単価(${fund ? '1万口あたり・円' : usd ? 'ドル' : '円'})</label><input id="h-cost" type="number" inputmode="decimal" min="0" step="any" value="${h.cost ?? ''}" placeholder="${fund ? '例: 25000' : usd ? '例: 120.50' : '例: 3500'}"></div>
        ${usd ? `<div class="field"><label for="h-fx">取得時のドル円(任意)</label><input id="h-fx" type="number" inputmode="decimal" min="0" step="any" value="${h.fx ?? ''}" placeholder="例: 150.20"><span class="hint">入れると為替差も含めた円建て損益になります</span></div>` : ''}
      </div>
      ${fund ? '<p class="muted small" style="margin:8px 0 0">保有口数と平均取得単価は、証券会社の「保有資産」画面で確認できます。</p>' : ''}
    </div></div>`;
  }
  const t = S.targets[sym] || {};
  const gap = t.target && q?.price ? (q.price / t.target - 1) * 100 : null;
  return `<div class="section"><div class="section-head"><h2>買いの検討メモ</h2><span class="muted small">この端末に保存</span></div>
  <div class="card card-pad">
    ${gap != null ? `<div class="notice" style="margin-bottom:12px">${icoInfo}<div>${gap <= 0 ? '<b>目標買値に到達しています。</b>' : `目標買値まで <b class="num">あと ${gap.toFixed(1)}%</b>(${fmtChange(t.target - q.price, q)})`}</div></div>` : ''}
    <div class="fields">
      <div class="field"><label for="w-target">目標買値(${q?.currency === 'USD' ? 'ドル' : '円'})</label><input id="w-target" type="number" inputmode="decimal" min="0" step="any" value="${t.target ?? ''}" placeholder="この値段まで下がったら買いたい"></div>
      <div class="field" style="grid-column:1/-1"><label for="w-memo">メモ</label><textarea id="w-memo" rows="2" placeholder="買いたい理由・注目ポイントなど">${esc(t.memo ?? '')}</textarea></div>
    </div>
  </div></div>`;
}

function drawDetailChart(q, range) {
  unmountChart?.();
  const el = $('#chart');
  if (!el) return;
  const d = curDetail;
  if (!d) { el.innerHTML = '<div class="chart-empty">チャートを読み込めませんでした</div>'; return; }
  let series, base = null, fmtT, fmtTip, overlays = [];
  const md = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
  const ym = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric' });
  const f = (fm) => (t) => fm.format(new Date(t * 1000));
  const dailyWithMA = (n) => {
    const all = { t: [...d.daily.t], c: [...d.daily.c] };
    if (all.c.length) all.c[all.c.length - 1] = q.price;
    const k = Math.max(0, all.c.length - n);
    if (S.settings.chartMA) {
      const m25 = smaSeries(all.c, 25).slice(k), m75 = smaSeries(all.c, 75).slice(k);
      overlays = [{ c: m25, color: '#f59e0b' }, { c: m75, color: '#8b5cf6' }];
    }
    return { t: all.t.slice(k), c: all.c.slice(k) };
  };
  switch (range) {
    case '1D': series = lastSession(d.intraday); base = q.prevClose; fmtT = fmtTime; fmtTip = fmtDateTime; break;
    case '5D': series = d.intraday; fmtT = f(md); fmtTip = fmtDateTime; break;
    case '1M': series = dailyWithMA(22); fmtT = f(md); fmtTip = fmtDate; break;
    case '6M': series = dailyWithMA(126); fmtT = f(md); fmtTip = fmtDate; break;
    case '1Y': series = dailyWithMA(400); fmtT = f(ym); fmtTip = fmtDate; break;
    case '5Y': series = d.weekly; fmtT = f(ym); fmtTip = fmtDate; break;
  }
  const dir = series?.c?.length ? cls(series.c[series.c.length - 1] - (base ?? series.c[0])) : 'flat';
  unmountChart = mountChart(el, series, { base, dir: dir === 'flat' ? 'up' : dir, fmt: (v) => fmtPrice(v, q), fmtT, fmtTip, overlays });
}

function bindDetail(sym, q) {
  const body = $('#sheet-body');
  body.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    store.set('range', b.dataset.range);
    body.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    drawDetailChart(q, b.dataset.range);
  }));
  $('#ma-toggle', body)?.addEventListener('change', (e) => {
    S.settings.chartMA = e.target.checked; saveSettings();
    drawDetailChart(q, body.querySelector('[data-range][aria-pressed="true"]')?.dataset.range || '1M');
  });
  const num = (id) => { const v = parseFloat($(id, body)?.value); return isFinite(v) && v > 0 ? v : undefined; };
  let t;
  const saveHold = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const h = { qty: num('#h-qty'), cost: num('#h-cost'), fx: num('#h-fx') };
      if (!h.qty && !h.cost) delete S.holdings[sym]; else S.holdings[sym] = h;
      store.set('holdings', S.holdings);
      render();
    }, 400);
  };
  ['#h-qty', '#h-cost', '#h-fx'].forEach((id) => $(id, body)?.addEventListener('input', saveHold));
  const saveTarget = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const target = num('#w-target'), memo = $('#w-memo', body)?.value.trim();
      if (!target && !memo) delete S.targets[sym]; else S.targets[sym] = { target, memo };
      store.set('targets', S.targets);
      render();
    }, 400);
  };
  ['#w-target', '#w-memo'].forEach((id) => $(id, body)?.addEventListener('input', saveTarget));
}

// ===================== 銘柄の追加・削除 =====================
function openAdd(list = 'watch') {
  openSheet(`<div class="d-head"><div><h2 class="d-title" id="sheet-title">銘柄を追加</h2><div class="d-sym">名前・証券コード・ティッカーで検索</div></div>${closeBtn()}</div>
    <div class="seg" style="margin-top:14px" role="group" aria-label="追加先">
      <button data-addlist="watch" aria-pressed="${list === 'watch'}">ウォッチ(買い検討)</button><button data-addlist="hold" aria-pressed="${list === 'hold'}">保有銘柄</button></div>
    <div class="field" style="margin-top:12px"><input id="add-q" type="search" placeholder="例: トヨタ / 7203 / AAPL / オルカン" autocomplete="off" autocapitalize="characters" enterkeyhint="search"></div>
    <div class="card suggest" id="add-results"></div>
    <p class="muted small">日本株・米国株・ETF・投資信託など約${universeSize() || 250}銘柄の株価を自動取得しています。検索に出ない銘柄は、日本株は4桁の証券コード(例: 7203)、米国株はティッカー(例: AAPL)で追加できます${gh.isConnected() ? '(取得対象にも自動で追加されます)' : '(取得対象に入るまでは価格が表示されません)'}。</p>`);
  const body = $('#sheet-body');
  let addList = list;
  body.querySelectorAll('[data-addlist]').forEach((b) => b.addEventListener('click', () => {
    addList = b.dataset.addlist;
    body.querySelectorAll('[data-addlist]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  }));
  const input = $('#add-q', body), res = $('#add-results', body);
  const existing = new Set(allItems().map((i) => i.symbol));
  const extra = (S.served?.symbols || []).map((x) => ({ s: x.symbol, n: x.name, a: '' }));
  const draw = () => {
    const v = input.value;
    const hits = searchSymbols(v, 15, extra);
    const raw = normalizeSymbol(v);
    if (raw && /^[\w.^=-]+$/.test(raw) && !hits.some((h) => h.symbol === raw)) hits.push({ symbol: raw, name: `「${raw}」をコードとして追加`, raw: true });
    res.innerHTML = hits.map((h) => {
      const q = Q(h.symbol);
      const right = existing.has(h.symbol) ? '追加済み'
        : q && !q.error ? `<span class="num ${cls(q.change)}">${fmtPrice(q.price, q)} ${fmtPct(q.changePct)}</span>`
        : esc(h.symbol.replace(/\.T$/, ''));
      return `<button data-pick="${esc(h.symbol)}" data-name="${esc(h.raw ? '' : h.name)}"><span>${esc(h.name)}<span class="s-code" style="margin-left:6px">${esc(h.symbol.replace(/\.T$/, ''))}</span></span><span class="s-code">${right}</span></button>`;
    }).join('');
    res.style.display = hits.length ? '' : 'none';
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') res.querySelector('button')?.click(); });
  res.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    if (existing.has(b.dataset.pick)) { toast('すでに一覧にあります'); return; }
    addSymbol(b.dataset.pick, b.dataset.name, addList);
  });
  draw();
  setTimeout(() => input.focus(), 250);
}

async function addSymbol(sym, name, list, { stay = false } = {}) {
  const fetched = Q(sym) && !Q(sym).error;
  const label = name || nameOf(sym);
  addToMy(sym, list, universeEntry(sym) ? undefined : label !== sym ? label : undefined);
  if (!stay) { closeSheet(); S.tab = list; }
  render();
  if (fetched) { toast(`${label} を${list === 'hold' ? '保有銘柄' : 'ウォッチ'}に追加しました`); return; }
  // 株価の取得対象に入っていない銘柄
  if (!gh.isConnected()) { toast('追加しました。この銘柄は株価の取得対象外のため、価格は表示されません', 5000); return; }
  toast('取得対象に追加しています…');
  try {
    await gh.updateWatchlist((d) => {
      d.symbols ||= [];
      if (!d.symbols.some((s) => s.symbol === sym)) d.symbols.push({ symbol: sym, name: label, type: guessType(sym) });
    }, `取得対象に追加: ${label} (${sym})`);
    toast('追加しました。3〜5分ほどで株価が表示されます', 4000);
  } catch (e) { toast(e.message, 5000); }
}

function removeSymbol(sym) {
  const it = allItems().find((i) => i.symbol === sym);
  if (!confirm(`「${it?.name || sym}」を一覧から削除しますか？`)) return;
  S.my.items = S.my.items.filter((i) => i.symbol !== sym);
  saveMy();
  closeSheet(); render();
  toast('一覧から削除しました');
}

function moveSymbol(sym, to) {
  addToMy(sym, to);
  closeSheet(); render();
  toast(to === 'hold' ? '保有銘柄に移動しました' : 'ウォッチに移動しました');
}

function loadSample() {
  for (const x of S.served?.symbols || []) if (!inMyList(x.symbol)) addToMy(x.symbol, 'watch', universeEntry(x.symbol) ? undefined : x.name);
  render();
  toast('サンプルの銘柄をウォッチに追加しました');
}

// ===================== 共有 =====================
const appURL = () => location.origin + location.pathname;

async function shareOrCopy(title, text, url) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('リンクをコピーしました。LINE やメールに貼り付けて送ってください', 4500); }
  catch { prompt('このリンクをコピーして送ってください', url); }
}

// 銘柄リストを URL にする: ?list=NVDA.h,AMD.w  (h=保有, w=ウォッチ。保有数などは含めない)
function listShareURL() {
  const v = (S.my?.items || []).map((i) => `${i.symbol}${i.list === 'hold' ? '!h' : '!w'}`).join(',');
  return `${appURL()}?list=${encodeURIComponent(v)}`;
}

function checkSharedList() {
  const p = new URLSearchParams(location.search).get('list');
  if (!p) return;
  history.replaceState(null, '', appURL() + location.hash);
  const entries = p.split(',').map((x) => x.split('!')).filter(([s]) => /^[\w.^=-]{1,20}$/.test(s || ''));
  if (!entries.length) return;
  const names = entries.slice(0, 8).map(([s]) => nameOf(s)).join('、') + (entries.length > 8 ? ` ほか${entries.length - 8}件` : '');
  if (!confirm(`共有された銘柄リスト(${entries.length}件)を追加しますか？\n\n${names}\n\n※ すでにある銘柄はそのままです。`)) return;
  let n = 0;
  for (const [s] of entries) if (!inMyList(s)) { addToMy(s, 'watch'); n++; }
  render();
  toast(`${n}件をウォッチに追加しました`);
}

// ===================== バックアップ =====================
async function exportData() {
  const data = JSON.stringify({ v: 2, my: S.my, holdings: S.holdings, targets: S.targets, settings: S.settings });
  try { await navigator.clipboard.writeText(data); toast('クリップボードにコピーしました。もう一方の端末で「読み込む」に貼り付けてください', 5000); }
  catch { prompt('このテキストをコピーしてください', data); }
}
function importData() {
  const txt = prompt('書き出したデータを貼り付けてください');
  if (!txt) return;
  try {
    const d = JSON.parse(txt);
    if (d.my?.items) { S.my = d.my; saveMy(); }
    if (d.holdings) { S.holdings = d.holdings; store.set('holdings', S.holdings); }
    if (d.targets) { S.targets = d.targets; store.set('targets', S.targets); }
    if (d.settings) { S.settings = { ...DEFAULT_SETTINGS, ...d.settings }; saveSettings(); applyTheme(); }
    toast('読み込みました'); render();
  } catch { toast('データの形式が正しくありません'); }
}

// ===================== イベント =====================
function applyTheme() {
  const r = document.documentElement;
  if (S.settings.theme === 'auto') delete r.dataset.theme; else r.dataset.theme = S.settings.theme;
  r.dataset.colors = S.settings.colors;
  const dark = S.settings.theme === 'dark' || (S.settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name="theme-color"]').forEach((m) => { m.setAttribute('content', dark ? '#0b0e14' : '#f4f5f8'); m.removeAttribute('media'); });
}

function go(tab) {
  S.tab = tab;
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-pill],[data-quick],[data-sym],[data-tab],[data-tab-go],[data-action],[data-sort],[data-set],[data-news]');
  if (!el) return;
  if (el.dataset.pill) {
    e.stopPropagation();
    const modes = PILL_MODES[el.dataset.pill];
    const i = modes.indexOf(S.settings.pillMode);
    S.settings.pillMode = modes[(i + 1) % modes.length];
    saveSettings(); render();
    toast(PILL_LABEL[S.settings.pillMode], 1200);
    return;
  }
  if (el.dataset.quick) { addSymbol(el.dataset.quick, '', 'watch', { stay: true }); return; }
  if (el.dataset.action) {
    const a = el.dataset.action;
    if (a === 'close') closeSheet();
    else if (a === 'quick-add') { addSymbol(el.dataset.sym, '', el.dataset.list, { stay: true }); openDetail(el.dataset.sym); }
    else if (a === 'load-sample') loadSample();
    else if (a === 'welcome-done') { store.set('welcomeDone', true); render(); }
    else if (a === 'share-app') shareOrCopy('マイ株ボード', '株価・為替・保有株の値動きを一目で見られるアプリです(無料・登録不要)', appURL());
    else if (a === 'share-list') shareOrCopy('マイ株ボードの銘柄リスト', '私がチェックしている銘柄のリストです。開くとまとめて追加できます', listShareURL());
    else if (a === 'add') openAdd(el.dataset.list || (S.tab === 'hold' ? 'hold' : 'watch'));
    else if (a === 'remove') removeSymbol(el.dataset.sym);
    else if (a === 'move') moveSymbol(el.dataset.sym, el.dataset.to);
    else if (a === 'goto-settings') { closeSheet(); go('settings'); }
    else if (a === 'install-dismiss') { store.set('installDismissed', true); render(); }
    else if (a === 'install-help') go('settings');
    else if (a === 'install') { S.installEvt?.prompt(); S.installEvt = null; }
    else if (a === 'export') exportData();
    else if (a === 'import') importData();
    else if (a === 'gh-save') {
      store.set('github', { repo: $('#gh-repo').value.trim(), token: $('#gh-token').value.trim() });
      try { await gh.testConnection(); toast('接続できました'); } catch (err) { toast(err.message, 5000); }
      render();
    } else if (a === 'gh-run') {
      try { await gh.runWorkflow(); toast('取得を開始しました。1〜3分後に更新されます', 4000); } catch (err) { toast(err.status === 403 ? 'トークンに Actions: Read and write 権限を追加してください' : err.message, 5000); }
    }
    return;
  }
  if (el.dataset.sort) { S.settings[el.dataset.sort] = el.dataset.val; saveSettings(); render(); return; }
  if (el.dataset.set) {
    const k = el.dataset.set; let v = el.dataset.val;
    if (k === 'refreshMin') v = +v;
    if (k === 'tilesOpen') v = !!v;
    S.settings[k] = v; saveSettings();
    if (k === 'theme' || k === 'colors') applyTheme();
    if (k === 'refreshMin') scheduleAuto();
    render(); return;
  }
  if (el.dataset.news) { S.newsFilter = el.dataset.news; render(); return; }
  if (el.dataset.tab) { closeSheet(); go(el.dataset.tab); return; }
  if (el.dataset.tabGo) { go(el.dataset.tabGo); return; }
  if (el.dataset.sym && !el.closest('.sheet')) openDetail(el.dataset.sym);
});

$('#refresh-btn').addEventListener('click', () => refresh());
$('#sheet-backdrop').addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
window.addEventListener('popstate', () => { if (location.hash !== '#sheet') closeSheet(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderHeader();
    if (Date.now() - S.lastFetch > 60000) refresh({ silent: true });
  }
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.tab === 'settings') render(); });

// シートを下にスワイプして閉じる
(() => {
  const sh = $('#sheet'); let y0 = null, dy = 0;
  sh.addEventListener('touchstart', (e) => { if ($('#sheet-body').scrollTop <= 0 && !e.target.closest('.chart-wrap')) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  sh.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`; } else { y0 = null; sh.style.transform = ''; }
  }, { passive: true });
  sh.addEventListener('touchend', () => {
    if (y0 == null) return;
    sh.style.transition = ''; sh.style.transform = '';
    if (dy > 110) closeSheet();
    y0 = null;
  });
})();

// 引っ張って更新
(() => {
  const ptr = $('#ptr'); let y0 = null, dy = 0;
  window.addEventListener('touchstart', (e) => { if (window.scrollY <= 0 && $('#sheet').hidden) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    const p = Math.min(dy / 80, 1);
    ptr.style.opacity = p; ptr.style.transform = `translateY(${Math.min(dy, 90) - 40}px) rotate(${dy * 3}deg)`;
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (y0 == null) return;
    y0 = null;
    if (dy > 80) { ptr.classList.add('loading'); await refresh(); ptr.classList.remove('loading'); }
    ptr.style.opacity = 0; ptr.style.transform = '';
  });
})();

// ===================== 起動 =====================
applyTheme();
setUniverse(store.get('universe', []));
const initial = location.hash.slice(1);
S.tab = TABS[initial] ? initial : (S.settings.startTab || 'home');
render();
refresh({ silent: true }).then(checkSharedList);
scheduleAuto();
setInterval(renderHeader, 30000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
