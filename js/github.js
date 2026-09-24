// GitHub 連携: data/watchlist.json を書き換えて株価の取得対象を増減する
import { store } from './util.js';

const PATH = 'data/watchlist.json';

// GitHub Pages の URL (https://ユーザー名.github.io/リポジトリ名/) から推測
export function detectRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return '';
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return repo ? `${m[1]}/${repo}` : `${m[1]}/${m[1]}.github.io`;
}

export function config() {
  const c = store.get('github', {});
  return { repo: c.repo || detectRepo(), token: c.token || '' };
}

export const isConnected = () => { const c = config(); return !!(c.repo && c.token); };

async function api(path, init = {}) {
  const { repo, token } = config();
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = `GitHub エラー (${res.status})`;
    if (res.status === 401) msg = 'トークンが無効です。設定を確認してください';
    if (res.status === 403) msg = 'トークンの権限が足りません (Contents: Read and write が必要)';
    if (res.status === 404) msg = 'リポジトリが見つかりません。名前と権限を確認してください';
    if (res.status === 409) msg = '同時に更新されました。もう一度お試しください';
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return res.status === 204 ? null : res.json();
}

const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const b64encode = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

async function readWatchlist() {
  const f = await api(`/contents/${PATH}?ref=main`);
  return { data: JSON.parse(b64decode(f.content)), sha: f.sha };
}

// mutate(data) で watchlist を書き換えてコミット (競合時は1回だけ読み直して再試行)
export async function updateWatchlist(mutate, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readWatchlist();
    mutate(data);
    const text = formatWatchlist(data);
    try {
      await api(`/contents/${PATH}`, {
        method: 'PUT',
        body: JSON.stringify({ message, content: b64encode(text), sha, branch: 'main' }),
      });
      return data;
    } catch (e) {
      if (e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
}

// 1銘柄1行の読みやすい形で保存
function formatWatchlist(d) {
  const line = (o) => '    ' + JSON.stringify(o);
  return `{\n  "markets": [\n${(d.markets || []).map(line).join(',\n')}\n  ],\n  "symbols": [\n${(d.symbols || []).map(line).join(',\n')}\n  ]\n}\n`;
}

export async function testConnection() {
  const r = await api('');
  if (!r.permissions?.push) throw new Error('このトークンには書き込み権限がありません');
  return r;
}

// 「今すぐ取得」: ワークフローを手動実行 (Actions: Read and write 権限が必要)
export async function runWorkflow() {
  await api('/actions/workflows/update-quotes.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
}
