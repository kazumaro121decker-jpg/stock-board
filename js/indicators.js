// テクニカル指標と売買シグナル(日足の終値から計算)

export function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

export function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

// RSI(14) ワイルダー方式
export function rsi(arr, n = 14) {
  if (arr.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// 日足の終値配列(当日分の最新価格で最後を置き換える)
export function dailyCloses(q) {
  const c = q?.daily?.c ? [...q.daily.c] : [];
  if (c.length && q.price != null) c[c.length - 1] = q.price;
  return c;
}

export function analyze(q) {
  const c = dailyCloses(q);
  if (c.length < 2) return null;
  const price = q.price ?? c[c.length - 1];
  const ma25 = sma(c, 25), ma75 = sma(c, 75), ma200 = sma(c, 200);
  const r = rsi(c);
  const hi = q.high52 ?? Math.max(...c), lo = q.low52 ?? Math.min(...c);
  const pos52 = hi > lo ? ((price - lo) / (hi - lo)) * 100 : null;
  const fromHigh = hi ? (price / hi - 1) * 100 : null;

  // ゴールデンクロス / デッドクロス (25日線と75日線、直近5営業日)
  let cross = null;
  if (c.length >= 80) {
    const s25 = smaSeries(c, 25), s75 = smaSeries(c, 75);
    for (let i = c.length - 5; i < c.length; i++) {
      const a = s25[i - 1] - s75[i - 1], b = s25[i] - s75[i];
      if (a <= 0 && b > 0) cross = 'golden';
      if (a >= 0 && b < 0) cross = 'dead';
    }
  }

  // 連騰・連落
  let streak = 0;
  for (let i = c.length - 1; i > 0; i--) {
    const d = Math.sign(c[i] - c[i - 1]);
    if (d === 0) break;
    if (streak === 0) streak = d;
    else if (Math.sign(streak) === d) streak += d;
    else break;
  }

  // 出来高急増
  let volRatio = null;
  const v = q.dailyVol?.filter((x) => x != null) ?? [];
  if (v.length > 21) {
    const avg = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    if (avg > 0) volRatio = v[v.length - 1] / avg;
  }

  const ret = (days) => (c.length > days ? (price / c[c.length - 1 - days] - 1) * 100 : null);
  const ytd = (() => {
    const t = q.daily?.t;
    if (!t) return null;
    const y = new Date().getFullYear();
    const start = Date.UTC(y, 0, 1) / 1000;
    const i = t.findIndex((x) => x >= start);
    if (i <= 0) return null;
    return (price / c[i - 1] - 1) * 100;
  })();

  return {
    price, ma25, ma75, ma200, rsi: r, hi, lo, pos52, fromHigh, cross, streak, volRatio,
    dev25: ma25 ? (price / ma25 - 1) * 100 : null,
    dev75: ma75 ? (price / ma75 - 1) * 100 : null,
    ret1w: ret(5), ret1m: ret(21), ret3m: ret(63), ret6m: ret(126), ytd,
  };
}

// 表示用シグナル(短い日本語ラベル)
export function signalsFor(q, a, { target } = {}) {
  const out = [];
  if (!a) return out;
  if (a.rsi != null) {
    if (a.rsi <= 30) out.push({ level: 'good', icon: '🧊', label: `RSI ${a.rsi.toFixed(0)} 売られすぎ`, desc: '反発の可能性。買い検討の目安の一つ' });
    else if (a.rsi >= 70) out.push({ level: 'warn', icon: '🔥', label: `RSI ${a.rsi.toFixed(0)} 買われすぎ`, desc: '過熱感あり。高値づかみに注意' });
  }
  if (a.cross === 'golden') out.push({ level: 'good', icon: '✨', label: 'ゴールデンクロス', desc: '25日線が75日線を上抜け(上昇トレンド入りのサイン)' });
  if (a.cross === 'dead') out.push({ level: 'bad', icon: '⚠️', label: 'デッドクロス', desc: '25日線が75日線を下抜け(下降トレンド入りのサイン)' });
  if (a.dev25 != null && a.dev25 <= -10) out.push({ level: 'good', icon: '📉', label: `25日線から${a.dev25.toFixed(1)}%乖離`, desc: '短期的に大きく下げている' });
  if (a.dev25 != null && a.dev25 >= 15) out.push({ level: 'warn', icon: '📈', label: `25日線から+${a.dev25.toFixed(1)}%乖離`, desc: '短期的に大きく上げている' });
  if (a.pos52 != null && a.pos52 >= 97) out.push({ level: 'info', icon: '🏔️', label: '52週高値圏', desc: '年初来・52週の高値付近' });
  if (a.pos52 != null && a.pos52 <= 3) out.push({ level: 'bad', icon: '🕳️', label: '52週安値圏', desc: '52週の安値付近' });
  if (a.volRatio != null && a.volRatio >= 2) out.push({ level: 'info', icon: '📊', label: `出来高 ${a.volRatio.toFixed(1)}倍`, desc: '20日平均に比べて出来高が急増' });
  if (Math.abs(a.streak) >= 4) out.push({ level: a.streak > 0 ? 'info' : 'bad', icon: a.streak > 0 ? '⬆️' : '⬇️', label: `${Math.abs(a.streak)}日連続${a.streak > 0 ? '上昇' : '下落'}`, desc: '' });
  if (Math.abs(q.changePct ?? 0) >= 5) out.push({ level: q.changePct > 0 ? 'info' : 'bad', icon: '⚡', label: `本日 ${q.changePct > 0 ? '+' : ''}${q.changePct.toFixed(1)}%の急変動`, desc: '' });
  if (target && a.price) {
    const gap = (a.price / target - 1) * 100;
    if (gap <= 0) out.push({ level: 'good', icon: '🎯', label: '目標買値に到達', desc: `目標 ${target} を下回りました` });
    else if (gap <= 3) out.push({ level: 'info', icon: '🎯', label: `目標買値まであと${gap.toFixed(1)}%`, desc: '' });
  }
  const f = q.fundamentals;
  if (f?.earningsDate) {
    const days = (f.earningsDate * 1000 - Date.now()) / 86400000;
    if (days >= -1 && days <= 14) out.push({ level: 'warn', icon: '📅', label: days < 0.5 ? '決算発表(直近)' : `決算まであと${Math.ceil(days)}日`, desc: '決算前後は値動きが大きくなりやすい' });
  }
  return out;
}

export const RECO = {
  strong_buy: '強い買い', buy: '買い', hold: '中立', underperform: 'やや売り', sell: '売り', strongSell: '強い売り', strong_sell: '強い売り', none: '—',
};
