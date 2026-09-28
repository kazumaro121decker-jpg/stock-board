// マイ株ボード ホーム画面ウィジェット (iPhone / iPad の「Scriptable」アプリ用)
//
// 使い方:
//   1. App Store で「Scriptable」(無料) をインストール
//   2. このスクリプトを Scriptable に新規作成して貼り付け
//   3. ホーム画面を長押し →「＋」→ Scriptable → ウィジェットの大きさを選んで追加
//   4. 追加したウィジェットを長押し →「ウィジェットを編集」→ Script でこのスクリプトを選ぶ
//   表示する銘柄を変えたいときは、同じ画面の Parameter に「^N225,JPY=X,NVDA,7203」のように
//   カンマ区切りで入れてください(空欄なら下の SYMBOLS を表示)。
//   ロック画面(長方形・1行)ウィジェットにも対応しています。

const APP_URL = "__APP_URL__";
const DATA_URL = APP_URL + "data/quotes.json";
// 表示する銘柄(上から順に表示。小=4、中=5、大=12銘柄まで)
const SYMBOLS = __SYMBOLS__;
// 値動きの色: "jp" = 上昇が赤・下落が青 / "us" = 上昇が緑・下落が赤
const COLOR_STYLE = "__COLORS__";

// ---------------------------------------------------------------------------

const UP = COLOR_STYLE === "us" ? new Color("#1fb877") : new Color("#f0464c");
const DOWN = COLOR_STYLE === "us" ? new Color("#f0464c") : new Color("#3d7cf0");
const FLAT = new Color("#8a93a3");
const BG = Color.dynamic(new Color("#ffffff"), new Color("#11151d"));
const TEXT = Color.dynamic(new Color("#121620"), new Color("#eef1f6"));
const SUB = Color.dynamic(new Color("#6b7385"), new Color("#8d96a7"));

function normalize(s) {
  s = String(s || "").trim().toUpperCase();
  if (/^\d{4}$/.test(s) || /^\d{3}[A-Z]$/.test(s)) return s + ".T";
  if (/^[0-9A-Z]{8}$/.test(s) && /\d/.test(s)) return s + ".T";
  return s;
}

function symbolsToShow() {
  const p = (typeof args !== "undefined" && args.widgetParameter) || "";
  const list = p.trim() ? p.split(/[,、\s]+/) : SYMBOLS;
  return list.map(normalize).filter(Boolean);
}

async function loadData() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), "stock-board-quotes.json");
  try {
    const req = new Request(DATA_URL + "?t=" + Date.now());
    req.timeoutInterval = 20;
    const doc = await req.loadJSON();
    if (doc && doc.quotes) {
      fm.writeString(cache, JSON.stringify(doc));
      return { doc, offline: false };
    }
  } catch (e) { /* 通信できないときは前回のデータ */ }
  if (fm.fileExists(cache)) return { doc: JSON.parse(fm.readString(cache)), offline: true };
  return { doc: null, offline: true };
}

function digits(q) {
  const p = Math.abs(q.price || 0);
  if (q.type === "fund") return 0;
  if (q.type === "fx") return p < 10 ? 4 : 2;
  if (q.type === "rate") return 3;
  if (q.currency === "JPY") return p >= 10000 ? 0 : q.type === "stock" ? 1 : 2;
  if (p >= 10000) return 0;
  return 2;
}

function fmtNum(v, d) {
  const s = Number(v).toFixed(d).split(".");
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return s.join(".");
}

function fmtPrice(q) {
  if (q.price == null) return "—";
  let s = fmtNum(q.price, digits(q));
  if (q.type === "stock" && q.currency === "JPY" && s.endsWith(".0")) s = s.slice(0, -2);
  if (q.type === "rate") s += "%";
  return s;
}

function fmtPct(q) {
  if (q.type === "rate") {
    if (q.change == null) return "—";
    return (q.change > 0 ? "+" : q.change < 0 ? "−" : "±") + Math.abs(q.change).toFixed(3);
  }
  const v = q.changePct;
  if (v == null) return "—";
  return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(2) + "%";
}

const colorOf = (v) => (v > 0 ? UP : v < 0 ? DOWN : FLAT);

function shortName(q, sym) {
  const n = (q && q.name) || sym;
  return n.replace(/\(.*?\)|（.*?）/g, "").replace("ホールディングス", "HD").replace("フィナンシャル・グループ", "FG").trim() || n;
}

function sparkImage(q, w, h) {
  const c = (q.spark || []).filter((x) => x != null);
  if (c.length < 2) return null;
  let min = Math.min(...c), max = Math.max(...c);
  if (q.sparkBase != null) { min = Math.min(min, q.sparkBase); max = Math.max(max, q.sparkBase); }
  if (max === min) { max += 1; min -= 1; }
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const X = (i) => (i / (c.length - 1)) * w;
  const Y = (v) => 1 + (1 - (v - min) / (max - min)) * (h - 2);
  if (q.sparkBase != null) {
    const b = new Path();
    b.move(new Point(0, Y(q.sparkBase)));
    b.addLine(new Point(w, Y(q.sparkBase)));
    dc.addPath(b);
    dc.setStrokeColor(new Color("#8a93a3", 0.5));
    dc.setLineWidth(0.8);
    dc.strokePath();
  }
  const p = new Path();
  p.move(new Point(X(0), Y(c[0])));
  for (let i = 1; i < c.length; i++) p.addLine(new Point(X(i), Y(c[i])));
  dc.addPath(p);
  const dir = q.sparkBase != null ? q.change : c[c.length - 1] - c[0];
  dc.setStrokeColor(colorOf(dir));
  dc.setLineWidth(1.6);
  dc.strokePath();
  return dc.getImage();
}

function timeLabel(doc) {
  if (!doc || !doc.generatedAt) return "";
  const d = new Date(doc.generatedAt);
  const df = new DateFormatter();
  df.dateFormat = "M/d HH:mm";
  return df.string(d);
}

function header(w, doc, offline, small) {
  const h = w.addStack();
  h.centerAlignContent();
  const t = h.addText(small ? "株ボード" : "マイ株ボード");
  t.font = Font.heavySystemFont(small ? 12 : 13);
  t.textColor = TEXT;
  h.addSpacer();
  const u = h.addText((offline ? "⚠︎ " : "") + timeLabel(doc));
  u.font = Font.mediumSystemFont(10);
  u.textColor = offline ? new Color("#d69e2e") : SUB;
  w.addSpacer(small ? 5 : 6);
}

function rowSmall(w, q, sym) {
  const r = w.addStack();
  r.layoutVertically();
  const top = r.addStack();
  top.centerAlignContent();
  const n = top.addText(shortName(q, sym));
  n.font = Font.semiboldSystemFont(11);
  n.textColor = TEXT;
  n.lineLimit = 1;
  n.minimumScaleFactor = 0.7;
  top.addSpacer();
  const bottom = r.addStack();
  bottom.centerAlignContent();
  const p = bottom.addText(fmtPrice(q));
  p.font = Font.mediumMonospacedSystemFont(10);
  p.textColor = SUB;
  p.lineLimit = 1;
  p.minimumScaleFactor = 0.7;
  bottom.addSpacer(4);
  const c = bottom.addText(fmtPct(q));
  c.font = Font.boldMonospacedSystemFont(11);
  c.textColor = colorOf(q.change);
  c.lineLimit = 1;
  c.minimumScaleFactor = 0.7;
}

function rowWide(w, q, sym, sparkW) {
  const r = w.addStack();
  r.centerAlignContent();
  const n = r.addText(shortName(q, sym));
  n.font = Font.semiboldSystemFont(13);
  n.textColor = TEXT;
  n.lineLimit = 1;
  n.minimumScaleFactor = 0.65;
  r.addSpacer();
  const img = sparkImage(q, sparkW, 16);
  if (img) {
    const im = r.addImage(img);
    im.imageSize = new Size(sparkW, 16);
    r.addSpacer(8);
  }
  const p = r.addText(fmtPrice(q));
  p.font = Font.mediumMonospacedSystemFont(12);
  p.textColor = TEXT;
  p.lineLimit = 1;
  p.minimumScaleFactor = 0.7;
  r.addSpacer(6);
  const pill = r.addStack();
  pill.size = new Size(70, 20);
  pill.cornerRadius = 6;
  pill.backgroundColor = colorOf(q.change);
  pill.centerAlignContent();
  const c = pill.addText(fmtPct(q));
  c.font = Font.boldMonospacedSystemFont(12);
  c.textColor = Color.white();
  c.lineLimit = 1;
  c.minimumScaleFactor = 0.6;
}

function missing(w, sym, small) {
  const t = w.addText(`${sym}: データなし`);
  t.font = Font.systemFont(small ? 10 : 12);
  t.textColor = SUB;
}

async function build() {
  const family = config.widgetFamily || "large";
  const { doc, offline } = await loadData();
  const syms = symbolsToShow();
  const Q = (s) => (doc && doc.quotes && doc.quotes[s]) || null;

  // ロック画面
  if (family === "accessoryInline") {
    const w = new ListWidget();
    const parts = syms.slice(0, 2).map((s) => Q(s)).filter(Boolean).map((q) => `${shortName(q, q.symbol).slice(0, 4)} ${fmtPct(q)}`);
    w.addText(parts.join("  ") || "株ボード");
    return w;
  }
  if (family === "accessoryRectangular") {
    const w = new ListWidget();
    for (const s of syms.slice(0, 3)) {
      const q = Q(s);
      if (!q) continue;
      const t = w.addText(`${shortName(q, s).slice(0, 6)} ${fmtPrice(q)} ${fmtPct(q)}`);
      t.font = Font.semiboldSystemFont(12);
      t.lineLimit = 1;
      t.minimumScaleFactor = 0.6;
    }
    w.url = APP_URL;
    return w;
  }

  const w = new ListWidget();
  w.backgroundColor = BG;
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  const small = family === "small";
  w.setPadding(small ? 12 : 14, small ? 12 : 16, small ? 12 : 14, small ? 12 : 16);
  header(w, doc, offline, small);

  if (!doc) {
    const t = w.addText("データを読み込めませんでした。通信状態を確認してください。");
    t.font = Font.systemFont(12);
    t.textColor = SUB;
    return w;
  }
  const max = small ? 4 : family === "medium" ? 5 : 12;
  const list = syms.slice(0, max);
  list.forEach((s, i) => {
    const q = Q(s);
    if (!q || q.error) missing(w, s, small);
    else if (small) rowSmall(w, q, s);
    else rowWide(w, q, s, family === "medium" ? 44 : 60);
    if (i < list.length - 1) w.addSpacer(small ? 4 : family === "medium" ? 3 : 4);
  });
  w.addSpacer();
  return w;
}

const widget = await build();
if (config.runsInWidget || config.runsInAccessoryWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
