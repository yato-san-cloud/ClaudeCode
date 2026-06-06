// bianalytics.js — 分析BIビュー. A ThoughtSpot-style "ask in words → chart"
// surface over the already-aggregated analysis endpoint, plus auto-insight cards
// and three hand-rolled SVG charts (ABC Pareto / weekday heatmap / time series).
// Everything renders client-side from one GET — no server round-trip on interaction.
//
// World-view (strict): Void/panel surfaces from tokens, a single Cyan accent
// (#34E3FF) + semantic green/amber/red only, Chakra(display)/Grotesk(sans)/
// Space Mono(numerics). 120–180ms ease-out, no idle loops, reduced-motion safe,
// data-ink maximised (hairline rules, no frames/shadows). Comments EN; UI JA.

const CYAN = '#34E3FF';          // the one accent (charts/highlights)
const CYAN_40 = 'rgba(52,227,255,.40)';
const GREY = 'var(--ink-tertiary)';
const OK = 'var(--ok)';
const WARN = 'var(--warn)';
const BAD = 'var(--bad)';

const WD = ['月', '火', '水', '木', '金', '土', '日'];

// Rotating example questions (also seed the lightweight rule mapper below).
const EXAMPLES = [
  '梱包が詰まる曜日は？',
  'ABC上位20%は？',
  'ピーク時間帯は？',
  '物量が多い曜日は？',
  'データ範囲は？',
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n, d = 0) => (n == null || isNaN(n) ? '—' : `${fmt(n * 100, d)}%`);

function injectStyle() {
  if (document.getElementById('bia-style')) return;
  const s = document.createElement('style');
  s.id = 'bia-style';
  s.textContent = `
  #bianalytics.panel{overflow:auto}
  .bia{--bia-accent:${CYAN};display:flex;flex-direction:column;gap:16px;max-width:1180px;
    margin:0 auto;width:100%;padding:8px 2px 32px;color:var(--ink-primary);font-family:var(--font-sans)}
  .bia-dim{opacity:.34;transition:opacity var(--dur-2,160ms) var(--ease-out,ease)}
  @media (prefers-reduced-motion:reduce){.bia-dim{transition:none}}

  /* ── ① question box (ThoughtSpot-style) ── */
  .bia-ask{position:relative}
  .bia-ask-in{display:flex;align-items:center;gap:10px;background:var(--bg-panel);
    border:1px solid var(--line-hair);border-radius:var(--r-lg);padding:11px 14px;
    transition:border-color var(--dur-2,160ms) var(--ease-out,ease),box-shadow var(--dur-2,160ms) var(--ease-out,ease)}
  .bia-ask-in:focus-within{border-color:var(--bia-accent);box-shadow:0 0 0 3px rgba(52,227,255,.16)}
  .bia-ask-in .q{color:var(--bia-accent);font-family:var(--font-mono);font-size:14px;flex:0 0 auto}
  .bia-ask-in input{flex:1;min-width:0;border:none;background:transparent;outline:none;
    font:inherit;font-size:14.5px;color:var(--ink-primary)}
  .bia-ask-in input::placeholder{color:var(--ink-tertiary)}
  .bia-ask-in .slash{font-family:var(--font-mono);font-size:10px;color:var(--ink-tertiary);
    border:1px solid var(--line-hair);border-radius:var(--r-sm);padding:2px 6px;flex:0 0 auto}
  .bia-answer{margin-top:8px;font-size:13px;color:var(--ink-secondary);line-height:1.5;
    padding-left:4px;min-height:18px}
  .bia-answer b{color:var(--ink-primary)}
  .bia-answer .hit{color:var(--bia-accent);font-family:var(--font-mono);font-weight:700}
  .bia-answer .sug{color:var(--ink-tertiary)}
  .bia-answer .sug u{cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}

  /* ── ② auto-insight cards ── */
  .bia-ins{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  @media(max-width:820px){.bia-ins{grid-template-columns:1fr}}
  .bia-card{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-lg);
    padding:14px 15px;display:flex;flex-direction:column;gap:7px;cursor:pointer;
    transition:border-color var(--dur-2,160ms) var(--ease-out,ease),transform var(--dur-2,160ms) var(--ease-out,ease)}
  .bia-card:hover{border-color:var(--bia-accent);transform:translateY(-2px)}
  @media (prefers-reduced-motion:reduce){.bia-card{transition:none}.bia-card:hover{transform:none}}
  .bia-card .kic{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--ink-tertiary)}
  .bia-card .fact{font-size:13.5px;color:var(--ink-primary);line-height:1.45}
  .bia-card .fact .n{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-weight:700;color:var(--bia-accent)}
  .bia-card .imp{font-size:11.5px;color:var(--ink-secondary);line-height:1.45}
  .bia-card .go{margin-top:auto;font-family:var(--font-mono);font-size:10px;color:var(--ink-tertiary)}

  /* ── ②b drill links (cross-view nav) ── */
  .bia-drill{display:flex;flex-wrap:wrap;gap:14px;margin-top:2px}
  .bia-drill a{font-family:var(--font-sans);font-size:11px;color:var(--bia-accent);
    cursor:pointer;text-decoration:none;
    transition:opacity var(--dur-1,120ms) var(--ease-out,ease)}
  .bia-drill a:hover{opacity:.7}
  @media (prefers-reduced-motion:reduce){.bia-drill a{transition:none}}

  /* ── shared chart shell ── */
  .bia-chart{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-lg);padding:16px}
  .bia-ch-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  .bia-ch-h h3{margin:0;font-family:var(--font-display);font-size:14px;font-weight:600;color:var(--ink-primary)}
  .bia-ch-h .sub{font-size:11px;color:var(--ink-tertiary)}
  .bia-ch-h .leg{margin-left:auto;display:flex;gap:12px;font-size:10.5px;color:var(--ink-tertiary);
    font-family:var(--font-mono)}
  .bia-ch-h .leg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
  .bia svg{display:block;width:100%;height:auto}
  .bia svg text{font-family:var(--font-mono);fill:var(--ink-tertiary)}
  .bia svg .axt{fill:var(--ink-secondary)}

  /* ── weekday heatmap ── */
  .bia-heat{display:flex;gap:6px}
  .bia-cell{flex:1;border-radius:var(--r-sm);aspect-ratio:1/1.05;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:2px;border:1px solid var(--line-soft);
    cursor:pointer;transition:transform var(--dur-1,90ms) var(--ease-out,ease)}
  .bia-cell:hover{transform:translateY(-2px)}
  @media (prefers-reduced-motion:reduce){.bia-cell{transition:none}.bia-cell:hover{transform:none}}
  .bia-cell.max{outline:2px solid var(--bia-accent);outline-offset:2px}
  .bia-cell .wd{font-family:var(--font-display);font-size:12px;font-weight:600}
  .bia-cell .vv{font-family:var(--font-mono);font-size:10px;font-variant-numeric:tabular-nums}

  /* ── tooltip ── */
  .bia-tip{position:fixed;z-index:50;pointer-events:none;opacity:0;transform:translateY(2px);
    background:var(--bg-app);border:1px solid var(--line-strong);border-radius:var(--r-md);
    padding:7px 10px;font-size:11.5px;color:var(--ink-primary);box-shadow:0 4px 16px rgba(0,0,0,.16);
    transition:opacity var(--dur-1,90ms) var(--ease-out,ease);white-space:nowrap}
  .bia-tip.on{opacity:1}
  .bia-tip .n{font-family:var(--font-mono);font-variant-numeric:tabular-nums;color:var(--bia-accent);font-weight:700}

  /* ── empty / scaffold ── */
  .bia-empty{background:var(--bg-panel);border:1px dashed var(--line-strong);border-radius:var(--r-lg);
    padding:30px;text-align:center;color:var(--ink-tertiary);font-size:13px;line-height:1.7}
  .bia-empty b{color:var(--ink-secondary)}
  .bia-cta{display:inline-block;margin-top:12px;font-family:var(--font-mono);font-size:12px;
    color:var(--bia-accent);border:1px solid var(--bia-accent);border-radius:var(--r-pill);
    padding:6px 16px;cursor:pointer;transition:background var(--dur-2,160ms) var(--ease-out,ease)}
  .bia-cta:hover{background:rgba(52,227,255,.10)}
  .bia-scaffold{opacity:.5;filter:grayscale(.4)}
  `;
  document.head.appendChild(s);
}

export function mountBIAnalytics(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  // Optional Cody delegation: when a question matches no keyword rule and this
  // is a function, the raw question is handed to Cody. Back-compatible: when
  // unset, the legacy "近い質問" suggestion list is shown instead.
  const askCody = typeof opts.askCody === 'function' ? opts.askCody : null;

  // Drill: ask PM-side to switch the active view. This file only fires the event;
  // the host listens for `whsim:nav` and performs the actual view switch.
  const nav = (view) => document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view } }));

  const root = document.createElement('div');
  root.className = 'bia';
  el.innerHTML = '';
  el.appendChild(root);

  // one floating tooltip reused by every chart
  const tip = document.createElement('div');
  tip.className = 'bia-tip';
  document.body.appendChild(tip);
  const showTip = (html, ev) => {
    tip.innerHTML = html;
    tip.classList.add('on');
    const px = (ev.clientX || 0) + 14;
    const py = (ev.clientY || 0) + 14;
    tip.style.left = `${Math.min(px, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${py}px`;
  };
  const hideTip = () => tip.classList.remove('on');

  let data = null;          // analysis payload
  let exIdx = 0, exTimer = 0;

  // ── lightweight rule mapper: keyword → {section, answer} ──────────────
  // Pure string rules over Japanese keywords; never calls the server. Unknown
  // questions fall through to a "近い質問" suggestion list (the examples).
  function answerQuestion(qRaw) {
    const q = (qRaw || '').trim();
    if (!q) { setAnswer(''); clearDim(); return; }
    const has = (...ks) => ks.some((k) => q.includes(k));

    // ABC / 上位 / 偏り
    if (has('ABC', 'abc', '上位', '主力', '偏', 'パレート', '20%')) {
      const a = data.abc || [];
      if (!a.length) return suggestNoData('abc');
      const topN = Math.max(1, Math.round(a.length * 0.2));
      const top = a.slice(0, topN);
      const share = top.reduce((s, r) => s + (r.share || 0), 0);
      focus('abc');
      setAnswer(`上位 <b>${pct(topN / a.length)}</b> の SKU（<span class="hit">${fmt(topN)}品目</span>）が物量の <span class="hit">${pct(share)}</span> を占めます。最上位は <b>${esc(top[0].name || top[0].sku)}</b>。`);
      return;
    }
    // 曜日（梱包/詰まる/混む/物量 を含む曜日質問）
    if (has('曜日') || has('梱包', '詰ま', '混む', '忙しい')) {
      const w = data.by_weekday || [];
      if (!w.length) return suggestNoData('weekday');
      const mx = w.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), w[0]);
      focus('weekday');
      setAnswer(`物量が最も多い曜日は <span class="hit">${esc(mx.label)}曜</span>（<b>${fmt(mx.qty)}</b>）。ここが詰まりやすい曜日です。`);
      return;
    }
    // ピーク / 時間帯 / 時間
    if (has('ピーク', '時間帯', '時間', '何時', 'ピーク時')) {
      const h = data.hourly || [];
      if (!h.length) return suggestNoData('time');
      const mx = h.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), h[0]);
      focus('time');
      setAnswer(`ピークは <span class="hit">${esc(mx.label)}</span> 帯（<b>${fmt(mx.qty)}</b>）。人員はこの時間に厚く。`);
      return;
    }
    // データ範囲 / 期間
    if (has('範囲', '期間', 'いつ', '何日', 'データ')) {
      const d = data.daily || [];
      if (!d.length) return suggestNoData('time');
      focus('time');
      const total = d.reduce((s, r) => s + (r.qty || 0), 0);
      setAnswer(`データ範囲は <span class="hit">${fmt(d.length)}日分</span>（${esc(d[0].label || '')}〜${esc(d[d.length - 1].label || '')}）、合計 <b>${fmt(total)}</b>。`);
      return;
    }
    // fall-through (no rule matched): delegate to Cody if available, else suggest.
    clearDim();
    if (askCody) {
      askCody(q);
      setAnswer(`<span class="sug">この質問はルールに当てはまらなかったので、<b>Codyに聞きました</b>。</span>`);
      return;
    }
    setAnswer(`<span class="sug">うまく解釈できませんでした。近い質問: ${EXAMPLES.slice(0, 3).map((e) => `<u data-ex="${esc(e)}">${esc(e)}</u>`).join(' / ')}</span>`);
    root.querySelectorAll('[data-ex]').forEach((u) => { u.onclick = () => runExample(u.dataset.ex); });
  }

  function suggestNoData(section) {
    clearDim();
    setAnswer(`<span class="sug">この質問に必要なデータがまだありません（${esc(section)}）。①取込で実データを入れると回答できます。</span>`);
  }
  function runExample(text) {
    const inp = root.querySelector('[data-bia="q"]');
    if (inp) inp.value = text;
    answerQuestion(text);
  }
  function setAnswer(html) {
    const a = root.querySelector('[data-bia="answer"]');
    if (a) a.innerHTML = html;
  }

  // cross-highlight: dim everything, undim the focused chart, scroll to it
  function focus(section) {
    root.querySelectorAll('[data-sec]').forEach((n) => {
      n.classList.toggle('bia-dim', n.dataset.sec !== section);
    });
    const tgt = root.querySelector(`[data-sec="${section}"]`);
    if (tgt && !matchMedia('(prefers-reduced-motion:reduce)').matches) {
      tgt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  function clearDim() { root.querySelectorAll('[data-sec]').forEach((n) => n.classList.remove('bia-dim')); }

  // ── auto-insights (max 3): fact line + implication line ───────────────
  function insights() {
    const out = [];
    const abc = data.abc || [];
    if (abc.length) {
      const topN = Math.max(1, Math.round(abc.length * 0.2));
      const share = abc.slice(0, topN).reduce((s, r) => s + (r.share || 0), 0);
      const skew = share >= 0.8;
      out.push({
        sec: 'abc', kic: 'ABC 偏り',
        fact: `上位20%の SKU（<span class="n">${fmt(topN)}品目</span>）が物量の <span class="n">${pct(share)}</span> を占有。`,
        imp: skew ? '主力に偏在。A品を出荷口近くへ寄せれば歩行を大きく削減できます。'
          : '比較的フラット。ゾーニング効果は限定的、動線最適化を優先。',
      });
    }
    const wk = data.by_weekday || [];
    if (wk.length) {
      const mx = wk.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), wk[0]);
      const avg = wk.reduce((s, r) => s + (r.qty || 0), 0) / wk.length;
      const ratio = avg > 0 ? mx.qty / avg : 1;
      out.push({
        sec: 'weekday', kic: 'ピーク曜日',
        fact: `<span class="n">${esc(mx.label)}曜</span>が最大（<span class="n">${fmt(mx.qty)}</span>、平均比 <span class="n">×${fmt(ratio, 1)}</span>）。`,
        imp: ratio >= 1.4 ? 'この曜日に人員を寄せるか、前倒し出荷で平準化を。' : '曜日の山は緩やか。日次の平準化余地は小さめ。',
      });
    }
    const hr = data.hourly || [];
    if (hr.length && out.length < 3) {
      const mx = hr.reduce((a, b) => ((b.qty || 0) > (a.qty || 0) ? b : a), hr[0]);
      out.push({
        sec: 'time', kic: 'ピーク時間帯',
        fact: `ピークは <span class="n">${esc(mx.label)}</span>（<span class="n">${fmt(mx.qty)}</span>）。`,
        imp: 'この時間帯にピッカーを厚く。シフトの山谷を合わせると待ちが減ります。',
      });
    }
    const dy = data.daily || [];
    if (dy.length && out.length < 3) {
      const total = dy.reduce((s, r) => s + (r.qty || 0), 0);
      out.push({
        sec: 'time', kic: 'データ範囲',
        fact: `<span class="n">${fmt(dy.length)}日分</span>、合計 <span class="n">${fmt(total)}</span> を集計。`,
        imp: `${esc(dy[0].label || '')}〜${esc(dy[dy.length - 1].label || '')} の実データに基づく分析です。`,
      });
    }
    return out.slice(0, 3);
  }

  // ── ③ ABC Pareto (SVG): bars desc + cumulative line on right axis ─────
  function svgPareto() {
    const a = (data.abc || []).slice();
    if (!a.length) return scaffold('abc', 'ABCパレート', '物量降順の棒＋累積%線');
    const W = 760, H = 260, ml = 8, mr = 38, mt = 14, mb = 28;
    const iw = W - ml - mr, ih = H - mt - mb;
    const n = a.length;
    const maxQ = Math.max(...a.map((r) => r.qty || 0), 1);
    const bw = iw / n;
    const x = (i) => ml + i * bw;
    const yBar = (q) => mt + ih - (q / maxQ) * ih;
    const yCum = (c) => mt + ih - (c) * ih; // c is 0..1
    const colOf = (r) => (r.rank === 'A' || (r.cum != null && r.cum <= 0.7) ? CYAN
      : r.rank === 'B' || (r.cum != null && r.cum <= 0.9) ? CYAN_40 : 'var(--line-strong)');
    // bars
    let bars = '';
    a.forEach((r, i) => {
      const h = mt + ih - yBar(r.qty || 0);
      bars += `<rect class="bia-bar" data-i="${i}" x="${(x(i) + 1).toFixed(1)}" y="${yBar(r.qty || 0).toFixed(1)}" `
        + `width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" `
        + `fill="${colOf(r)}" rx="1"></rect>`;
    });
    // cumulative polyline (use provided cum, else derive)
    let acc = 0; const tot = a.reduce((s, r) => s + (r.qty || 0), 0) || 1;
    const pts = a.map((r, i) => {
      const c = r.cum != null ? r.cum : (acc += (r.qty || 0) / tot, acc);
      return `${(x(i) + bw / 2).toFixed(1)},${yCum(Math.min(1, c)).toFixed(1)}`;
    }).join(' ');
    // 70/90 guides + right axis ticks
    const guide = (frac, label, col) => {
      const yy = yCum(frac).toFixed(1);
      return `<line x1="${ml}" x2="${ml + iw}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-width="1" stroke-dasharray="3 3" opacity=".5"></line>`
        + `<text x="${ml + iw + 4}" y="${(+yy + 3).toFixed(1)}" font-size="9">${label}</text>`;
    };
    let axis = '';
    [0, 0.5, 1].forEach((f) => {
      axis += `<text x="${ml + iw + 4}" y="${(yCum(f) + 3).toFixed(1)}" font-size="9">${pct(f)}</text>`;
    });
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="ABCパレート図">
      ${guide(0.7, '70%', WARN)}${guide(0.9, '90%', BAD)}
      ${bars}
      <polyline points="${pts}" fill="none" stroke="${CYAN}" stroke-width="2" stroke-linejoin="round"></polyline>
      ${a.map((r, i) => { let c2 = r.cum != null ? r.cum : 0; return `<circle cx="${(x(i) + bw / 2).toFixed(1)}" cy="${yCum(Math.min(1, c2)).toFixed(1)}" r="2" fill="${CYAN}"></circle>`; }).join('')}
      ${axis}
    </svg>`;
    return chartShell('abc', 'ABCパレート', `${fmt(n)}品目を物量降順で`, svg, [
      [CYAN, 'A (〜70%)'], [CYAN_40, 'B (〜90%)'], ['var(--line-strong)', 'C'],
    ]);
  }

  // ── ④ weekday mini-heatmap: 7 cyan-shade cells, ring on max ───────────
  function heatWeekday() {
    const raw = data.by_weekday || [];
    if (!raw.length) return scaffold('weekday', '曜日別ヒートマップ', '7セルの濃淡');
    // normalise to Mon..Sun order if labels are weekday names
    const byLabel = {}; raw.forEach((r) => { byLabel[r.label] = r.qty || 0; });
    const series = WD.every((d) => d in byLabel) ? WD.map((d) => ({ label: d, qty: byLabel[d] })) : raw;
    const max = Math.max(...series.map((r) => r.qty || 0), 1);
    const cells = series.map((r) => {
      const t = (r.qty || 0) / max;                 // 0..1
      const a = 0.10 + t * 0.78;                     // alpha ramp on cyan
      const isMax = (r.qty || 0) === max;
      const ink = t > 0.55 ? '#04222c' : 'var(--ink-secondary)';
      return `<div class="bia-cell${isMax ? ' max' : ''}" data-hd="${esc(r.label)}|${r.qty || 0}"
        style="background:rgba(52,227,255,${a.toFixed(3)})">
        <span class="wd" style="color:${ink}">${esc(r.label)}</span>
        <span class="vv" style="color:${ink}">${fmt(r.qty)}</span></div>`;
    }).join('');
    return chartShell('weekday', '曜日別ヒートマップ', '濃いほど物量大', `<div class="bia-heat">${cells}</div>`, null);
  }

  // ── ⑤ time series: daily area (faint cyan fill + line) + hourly sparkline
  function timeSeries() {
    const daily = data.daily || [];
    const hourly = data.hourly || [];
    if (!daily.length && !hourly.length) return scaffold('time', '時系列', '日次エリア＋時間スパークライン');
    let body = '';
    if (daily.length) body += areaSVG(daily, 'daily');
    if (hourly.length) {
      body += `<div style="margin-top:14px"><div class="bia-ch-h" style="margin-bottom:6px">
        <h3 style="font-size:12px">時間帯</h3><span class="sub">スパークライン</span></div>${sparkSVG(hourly)}</div>`;
    }
    return chartShell('time', '時系列', daily.length ? `日次 ${fmt(daily.length)}日` : '時間帯別', body, null);
  }

  function areaSVG(d, kind) {
    const W = 760, H = 170, ml = 8, mr = 8, mt = 12, mb = 22;
    const iw = W - ml - mr, ih = H - mt - mb, n = d.length;
    const max = Math.max(...d.map((r) => r.qty || 0), 1);
    const x = (i) => ml + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (q) => mt + ih - (q / max) * ih;
    const line = d.map((r, i) => `${x(i).toFixed(1)},${y(r.qty || 0).toFixed(1)}`).join(' ');
    const area = `${ml},${(mt + ih).toFixed(1)} ${line} ${(ml + iw).toFixed(1)},${(mt + ih).toFixed(1)}`;
    const labels = [0, Math.floor(n / 2), n - 1].filter((i, k, a) => a.indexOf(i) === k && i >= 0);
    const dots = d.map((r, i) => `<rect class="bia-pt" data-pt="${esc(r.label || '')}|${r.qty || 0}" x="${(x(i) - Math.max(3, iw / n / 2)).toFixed(1)}" y="${mt}" width="${Math.max(6, iw / n).toFixed(1)}" height="${ih}" fill="transparent"></rect>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日次物量">
      <polygon points="${area}" fill="rgba(52,227,255,.12)"></polygon>
      <polyline points="${line}" fill="none" stroke="${CYAN}" stroke-width="2" stroke-linejoin="round"></polyline>
      ${labels.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="9" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(d[i].label || '')}</text>`).join('')}
      ${dots}
    </svg>`;
  }

  function sparkSVG(h) {
    const W = 760, H = 70, ml = 8, mr = 8, mt = 8, mb = 16;
    const iw = W - ml - mr, ih = H - mt - mb, n = h.length;
    const max = Math.max(...h.map((r) => r.qty || 0), 1);
    const x = (i) => ml + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (q) => mt + ih - (q / max) * ih;
    const line = h.map((r, i) => `${x(i).toFixed(1)},${y(r.qty || 0).toFixed(1)}`).join(' ');
    const mxi = h.reduce((bi, r, i) => ((r.qty || 0) > (h[bi].qty || 0) ? i : bi), 0);
    const bars = h.map((r, i) => `<rect class="bia-pt" data-pt="${esc(r.label || '')}|${r.qty || 0}" x="${(x(i) - Math.max(3, iw / n / 2)).toFixed(1)}" y="${mt}" width="${Math.max(5, iw / n).toFixed(1)}" height="${ih}" fill="transparent"></rect>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="時間帯スパークライン">
      <polyline points="${line}" fill="none" stroke="${CYAN_40}" stroke-width="1.5"></polyline>
      <circle cx="${x(mxi).toFixed(1)}" cy="${y(h[mxi].qty || 0).toFixed(1)}" r="3" fill="${CYAN}"></circle>
      <text x="${x(mxi).toFixed(1)}" y="${(y(h[mxi].qty || 0) - 6).toFixed(1)}" font-size="9" text-anchor="middle" class="axt">${esc(h[mxi].label || '')}</text>
      ${bars}
    </svg>`;
  }

  function chartShell(sec, title, sub, body, legend) {
    const leg = legend ? `<div class="leg">${legend.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join('')}</div>` : '';
    return `<section class="bia-chart" data-sec="${sec}">
      <div class="bia-ch-h"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span>${leg}</div>
      ${body}</section>`;
  }

  // empty-state scaffold for a chart whose array is missing — frame kept, no fabrication
  function scaffold(sec, title, sub) {
    return `<section class="bia-chart bia-scaffold" data-sec="${sec}">
      <div class="bia-ch-h"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span></div>
      <div class="bia-empty" style="border:none;padding:18px">この図は実データが入ると描画されます。</div>
    </section>`;
  }

  // ── render ────────────────────────────────────────────────────────────
  function render() {
    const name = getProject();
    if (!name) {
      root.innerHTML = '<div class="bia-empty">プロジェクトを選択してください。</div>';
      return;
    }
    if (!data) { root.innerHTML = '<div class="bia-empty">分析データを読み込み中…</div>'; return; }

    if (!data.has_data) {
      root.innerHTML = `
        ${askBox()}
        <div class="bia-empty">
          <b>分析できる実データがまだありません。</b><br>
          受注・出荷の明細を取り込むと、ABC・曜日・時間帯の分析がここに表示されます。<br>
          <span class="bia-cta" data-bia="cta">① 取込へ</span>
        </div>`;
      wireAsk();
      const cta = root.querySelector('[data-bia="cta"]');
      if (cta) cta.onclick = () => { window.location.hash = '#/取込'; toast('①取込でデータを取り込んでください。', 'info'); };
      return;
    }

    const ins = insights();
    root.innerHTML = `
      ${askBox()}
      ${ins.length ? `<div class="bia-ins">${ins.map(insCard).join('')}</div>` : ''}
      ${svgPareto()}
      ${heatWeekday()}
      ${timeSeries()}`;
    wireAsk();
    wireInsights();
    wireCharts();
  }

  function askBox() {
    return `<div class="bia-ask">
      <div class="bia-ask-in">
        <span class="q">?</span>
        <input data-bia="q" type="text" placeholder="${esc(EXAMPLES[exIdx])}" aria-label="質問を入力" />
        <span class="slash">/</span>
      </div>
      <div class="bia-answer" data-bia="answer"></div>
    </div>`;
  }

  function insCard(c) {
    return `<div class="bia-card" data-go="${c.sec}">
      <div class="kic">${esc(c.kic)}</div>
      <div class="fact">${c.fact}</div>
      <div class="imp">${esc(c.imp)}</div>
      <div class="bia-drill">
        <a data-nav="bi" role="link" tabindex="0">物量BIで見る →</a>
        <a data-nav="timetable" role="link" tabindex="0">人員設計へ →</a>
      </div>
      <div class="go">→ 該当チャートへ</div>
    </div>`;
  }

  // ── wiring ────────────────────────────────────────────────────────────
  function wireAsk() {
    const inp = root.querySelector('[data-bia="q"]');
    if (!inp) return;
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); answerQuestion(inp.value); }
      else if (e.key === 'Escape') { inp.value = ''; setAnswer(''); clearDim(); inp.blur(); }
    });
  }

  function wireInsights() {
    root.querySelectorAll('[data-go]').forEach((c) => { c.onclick = () => focus(c.dataset.go); });
    // drill links fire `whsim:nav` and must not bubble into the card's focus()
    root.querySelectorAll('[data-nav]').forEach((a) => {
      const go = (e) => { e.stopPropagation(); e.preventDefault(); nav(a.dataset.nav); };
      a.onclick = go;
      a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    });
  }

  function wireCharts() {
    // ABC bars tooltip
    root.querySelectorAll('.bia-bar').forEach((b) => {
      b.addEventListener('mousemove', (e) => {
        const r = (data.abc || [])[+b.dataset.i]; if (!r) return;
        showTip(`<b>${esc(r.name || r.sku)}</b><br>物量 <span class="n">${fmt(r.qty)}</span> · 累積 <span class="n">${pct(r.cum || 0)}</span>`, e);
      });
      b.addEventListener('mouseleave', hideTip);
    });
    // weekday cells tooltip
    root.querySelectorAll('.bia-cell').forEach((c) => {
      c.addEventListener('mousemove', (e) => {
        const [lab, q] = (c.dataset.hd || '|').split('|');
        showTip(`<b>${esc(lab)}曜</b> · <span class="n">${fmt(+q)}</span>`, e);
      });
      c.addEventListener('mouseleave', hideTip);
    });
    // time-series hover hotspots (daily area + hourly spark) → cross-highlight time section
    root.querySelectorAll('.bia-pt').forEach((p) => {
      p.addEventListener('mousemove', (e) => {
        const [lab, q] = (p.dataset.pt || '|').split('|');
        showTip(`<b>${esc(lab)}</b> · <span class="n">${fmt(+q)}</span>`, e);
      });
      p.addEventListener('mouseleave', hideTip);
    });
  }

  // ── example placeholder rotation (gated: one-shot per visit, NOT a loop) ─
  // Single 5s rotation through examples; stops after one full pass to honour the
  // "no idle loops" rule and is skipped entirely under reduced-motion.
  function startExampleRotation() {
    if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    let passes = 0;
    stopRotation();
    exTimer = setInterval(() => {
      exIdx = (exIdx + 1) % EXAMPLES.length;
      if (exIdx === 0 && ++passes >= 1) { stopRotation(); return; }
      const inp = root.querySelector('[data-bia="q"]');
      if (inp && !inp.value && document.activeElement !== inp) inp.placeholder = EXAMPLES[exIdx];
    }, 5000);
  }
  function stopRotation() { if (exTimer) { clearInterval(exTimer); exTimer = 0; } }

  // `/` focuses the question box from anywhere in this view
  function onSlash(e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!el.contains(t) && el.offsetParent === null) return;
    const inp = root.querySelector('[data-bia="q"]');
    if (inp) { e.preventDefault(); inp.focus(); }
  }
  document.addEventListener('keydown', onSlash);

  async function load() {
    const name = getProject();
    if (!name) { render(); return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/bi/analysis`);
      if (!r.ok) throw new Error(r.statusText);
      data = await r.json();
      render();
      startExampleRotation();
    } catch (e) {
      root.innerHTML = `<div class="bia-empty">分析データの取得に失敗: ${esc(e.message)}</div>`;
      toast('分析BIの読み込みに失敗', 'error');
    }
  }

  load();
  return {
    refresh() { data = null; render(); load(); },
    dispose() {
      stopRotation();
      document.removeEventListener('keydown', onSlash);
      if (tip.parentNode) tip.parentNode.removeChild(tip);
      el.innerHTML = '';
    },
  };
}
