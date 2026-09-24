// SVG チャート(スパークライン と 詳細チャート)
import { esc } from './util.js';

let gid = 0;

export function sparkline(values, { base = null, dir = 'flat', w = 64, h = 30 } = {}) {
  const v = (values || []).filter((x) => x != null && isFinite(x));
  if (v.length < 2) return `<svg viewBox="0 0 ${w} ${h}" class="spark"></svg>`;
  let min = Math.min(...v), max = Math.max(...v);
  if (base != null) { min = Math.min(min, base); max = Math.max(max, base); }
  if (max === min) { max += 1; min -= 1; }
  const pad = 2;
  const x = (i) => (i / (v.length - 1)) * w;
  const y = (p) => pad + (1 - (p - min) / (max - min)) * (h - pad * 2);
  const d = v.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join('');
  const id = 'sg' + ++gid;
  const color = `var(--${dir === 'flat' ? 'flat' : dir})`;
  const baseLine = base != null
    ? `<line x1="0" x2="${w}" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>`
    : '';
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${baseLine}
    <path d="${d}L${w} ${h}L0 ${h}Z" fill="url(#${id})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/**
 * 詳細チャート
 * series: {t:[], c:[]} / opts: {base, fmt(v), fmtT(t), overlays:[{c:[], color, label}]}
 */
export function mountChart(el, series, opts = {}) {
  const t = series?.t || [], c = series?.c || [];
  if (c.length < 2) {
    el.innerHTML = '<div class="chart-empty">この期間のデータはありません</div>';
    return () => {};
  }
  const dir = opts.dir || (c[c.length - 1] >= (opts.base ?? c[0]) ? 'up' : 'down');
  const color = `var(--${dir})`;
  let ro;

  function draw() {
    const W = el.clientWidth || 320, H = el.clientHeight || 220;
    const padT = 26, padB = 20, padR = 52, padL = 4;
    const vals = [...c];
    if (opts.base != null) vals.push(opts.base);
    for (const o of opts.overlays || []) for (const v of o.c) if (v != null) vals.push(v);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max === min) { max += 1; min -= 1; }
    const span = max - min; min -= span * 0.04; max += span * 0.04;
    const cw = W - padL - padR, ch = H - padT - padB;
    const X = (i) => padL + (i / (c.length - 1)) * cw;
    const Y = (v) => padT + (1 - (v - min) / (max - min)) * ch;
    const path = (arr) => {
      let d = '', pen = false;
      arr.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true;
      });
      return d;
    };
    const d = path(c);
    const id = 'cg' + ++gid;

    // 目盛り(4本)
    let grid = '';
    for (let k = 0; k <= 3; k++) {
      const v = min + ((max - min) * k) / 3;
      const yy = Y(v).toFixed(1);
      grid += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--border)" stroke-width="1"/>`;
      grid += `<text x="${W - padR + 6}" y="${yy}" dy="4" font-size="10.5" fill="var(--text-3)">${esc(opts.fmt ? opts.fmt(v) : v.toFixed(2))}</text>`;
    }
    // 時間軸ラベル(3つ)
    let xl = '';
    if (opts.fmtT) {
      [0, Math.floor((t.length - 1) / 2), t.length - 1].forEach((i, k) => {
        const anchor = k === 0 ? 'start' : k === 2 ? 'end' : 'middle';
        xl += `<text x="${X(i).toFixed(1)}" y="${H - 4}" font-size="10.5" fill="var(--text-3)" text-anchor="${anchor}">${esc(opts.fmtT(t[i]))}</text>`;
      });
    }
    const base = opts.base != null
      ? `<line x1="${padL}" x2="${W - padR}" y1="${Y(opts.base).toFixed(1)}" y2="${Y(opts.base).toFixed(1)}" stroke="var(--text-3)" stroke-dasharray="3 4" stroke-width="1"/>`
      : '';
    const overlays = (opts.overlays || []).map((o) => `<path d="${path(o.c)}" fill="none" stroke="${o.color}" stroke-width="1.3" opacity=".9"/>`).join('');

    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="価格チャート">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${grid}${base}
      <path d="${d}L${X(c.length - 1)} ${padT + ch}L${padL} ${padT + ch}Z" fill="url(#${id})"/>
      ${overlays}
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <g class="xhair" style="display:none">
        <line class="xl" y1="${padT - 6}" y2="${padT + ch}" stroke="var(--text-2)" stroke-width="1" stroke-dasharray="2 3"/>
        <circle class="xc" r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
      </g>
      ${xl}
    </svg><div class="chart-tip" style="display:none"></div>`;

    const svg = el.querySelector('svg'), g = svg.querySelector('.xhair');
    const line = g.querySelector('.xl'), dot = g.querySelector('.xc'), tip = el.querySelector('.chart-tip');
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(c.length - 1, Math.round(((clientX - r.left - padL) / cw) * (c.length - 1))));
      const xx = X(i), yy = Y(c[i]);
      g.style.display = '';
      line.setAttribute('x1', xx); line.setAttribute('x2', xx);
      dot.setAttribute('cx', xx); dot.setAttribute('cy', yy);
      const chg = opts.base != null ? c[i] - opts.base : c[i] - c[0];
      const pct = (chg / (opts.base ?? c[0])) * 100;
      tip.innerHTML = `<b>${esc(opts.fmt ? opts.fmt(c[i]) : c[i])}</b> <span class="${chg >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span> <span class="muted">${esc(opts.fmtTip ? opts.fmtTip(t[i]) : '')}</span>`;
      tip.style.display = '';
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(tw / 2, Math.min(W - tw / 2, xx)) + 'px';
    };
    const hide = () => { g.style.display = 'none'; tip.style.display = 'none'; };
    svg.addEventListener('pointermove', (e) => show(e.clientX));
    svg.addEventListener('pointerdown', (e) => show(e.clientX));
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') setTimeout(hide, 1500); });
  }

  draw();
  let lastW = el.clientWidth;
  if ('ResizeObserver' in window) {
    ro = new ResizeObserver(() => { if (el.clientWidth !== lastW) { lastW = el.clientWidth; draw(); } });
    ro.observe(el);
  }
  return () => ro?.disconnect();
}
