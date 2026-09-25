// 銘柄検索: data/universe.json (株価を自動取得している共通の銘柄一覧) から探す
// universe の各要素: { s: シンボル, n: 名前, a: 検索用の別名, t: 種類 }
let UNIVERSE = [];
let bySymbol = new Map();

export function setUniverse(list) {
  UNIVERSE = Array.isArray(list) ? list : [];
  bySymbol = new Map(UNIVERSE.map((u) => [u.s, u]));
}
export const universeEntry = (sym) => bySymbol.get(sym) || null;
export const universeSize = () => UNIVERSE.length;

const kana = (s) => s.toLowerCase().normalize('NFKC').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

export function searchSymbols(q, limit = 15, extra = []) {
  const n = kana(q.trim());
  if (!n) return [];
  const scored = [];
  const seen = new Set();
  for (const u of [...extra, ...UNIVERSE]) {
    if (seen.has(u.s)) continue;
    seen.add(u.s);
    const s = kana(u.s), nm = kana(u.n || ''), al = kana(u.a || '');
    let score = -1;
    if (s === n || s === n + '.t') score = 100;
    else if (s.startsWith(n)) score = 80;
    else if (nm.startsWith(n)) score = 70;
    else if (nm.includes(n)) score = 50;
    else if (al.includes(n)) score = 40;
    if (score >= 0) scored.push([score, u]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, u]) => ({ symbol: u.s, name: u.n }));
}

// 初めて使う人向けのおすすめ(ワンタップで追加)
export const STARTER = ['NVDA', 'AAPL', 'MSFT', 'TSLA', '7203.T', '6758.T', '8035.T', '9984.T', '0331418A.T', '03311187.T', 'VOO', 'QQQ'];
