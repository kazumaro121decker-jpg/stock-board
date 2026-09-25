// テクニカル指標(計算は scripts/fetch_quotes.py で行い、q.ind に入っている)と売買シグナル

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

export function analyze(q) {
  if (!q?.ind) return null;
  return { ...q.ind, price: q.price };
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
  if (a.pos52 != null && a.pos52 >= 97) out.push({ level: 'info', icon: '🏔️', label: '52週高値圏', desc: '52週の高値付近' });
  if (a.pos52 != null && a.pos52 <= 3) out.push({ level: 'bad', icon: '🕳️', label: '52週安値圏', desc: '52週の安値付近' });
  if (a.volRatio != null && a.volRatio >= 2) out.push({ level: 'info', icon: '📊', label: `出来高 ${a.volRatio.toFixed(1)}倍`, desc: '20日平均に比べて出来高が急増' });
  if (Math.abs(a.streak || 0) >= 4) out.push({ level: a.streak > 0 ? 'info' : 'bad', icon: a.streak > 0 ? '⬆️' : '⬇️', label: `${Math.abs(a.streak)}日連続${a.streak > 0 ? '上昇' : '下落'}`, desc: '' });
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
