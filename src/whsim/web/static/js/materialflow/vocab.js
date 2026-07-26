// materialflow/vocab.js — ②マテリアルフロー「工程キャンバス」の語彙とトークン。
//
// One place for the words and the colours the canvas, the popovers and the table
// editor all share, so the two lenses of the ONE flow graph (whsim/flowgraph.py)
// can never drift apart. EN comments / JA UI, per house style.
//
// The 搬送手段 palette lives here as CSS custom properties (light default + dark
// override) and is consumed through `var(--mf-tr-*)` inside inline `style`
// attributes — so a theme flip repaints every ribbon with no JS at all.

// transport: how goods reach a process. Values are the server's; labels 業務用語.
export const TRANSPORTS = ['manual', 'conveyor', 'agv', 'forklift', 'asrs'];
export const TRANSPORT_JA = {
  manual: '人手', conveyor: 'コンベア', agv: 'AGV',
  forklift: 'フォークリフト', asrs: '自動倉庫',
};
export const TRANSPORT_VAR = {
  manual: '--mf-tr-manual', conveyor: '--mf-tr-conveyor', agv: '--mf-tr-agv',
  forklift: '--mf-tr-forklift', asrs: '--mf-tr-asrs',
};
// A CSS colour expression for a 搬送手段 (safe inside a style attribute).
export const trColor = (t) => `var(${TRANSPORT_VAR[t] || TRANSPORT_VAR.manual})`;

// role: which engine behaviour a freely-named business process drives.
export const ROLE_JA = {
  receive: '入荷', putaway: '格納', pick: 'ピッキング', pack: '梱包',
  ship: '出荷', inspect: '検品', none: '計上のみ',
};
export const ROLES_FALLBACK = ['receive', 'putaway', 'pick', 'pack', 'ship'];

// 荷姿: the two families of load unit an edge can carry goods in.
export const LOAD_KINDS = ['container', 'carrier'];
export const LOAD_KIND_JA = { container: '容器', carrier: '台車' };
// 入数 is NOT one number per family: `capacity` is keyed by what is held, so a
// カゴ台車 is 「14 オリコン」 or 「14 ケース」 depending on the leg. loadunits.js
// (capacityKey/heldLabel) owns that; there is deliberately no constant here.

// 搬送手段 → the equipment kinds that can actually serve it. Mirrors
// designer/flowwire.js's TRANSPORT_KINDS (same graph, same rule).
const TRANSPORT_KINDS = {
  conveyor: ['conveyor'], agv: ['agv', 'amr'], asrs: ['asrs'],
  forklift: ['forklift', 'crane'], manual: [],
};

// The equipment an edge may name for a given 搬送手段. Never returns an empty
// list where something plausible exists: an unknown kind vocabulary falls back to
// "anything that is not a belt", which is what the table editor always did.
export function equipForTransport(equipment, transport) {
  const list = Array.isArray(equipment) ? equipment.filter((e) => e && e.id) : [];
  if (!transport || transport === 'manual') return [];
  const kinds = TRANSPORT_KINDS[transport];
  if (!kinds) return list.filter((e) => e.kind !== 'conveyor');
  if (!kinds.length) return [];
  const exact = list.filter((e) => kinds.includes(e.kind));
  if (exact.length) return exact;
  return transport === 'conveyor' ? [] : list.filter((e) => e.kind !== 'conveyor');
}

export function injectCanvasStyle() {
  if (document.getElementById('mfc-style')) return;
  const s = document.createElement('style');
  s.id = 'mfc-style';
  s.textContent = `
  /* 搬送手段パレット: theme-aware tokens (light default / dark override). Used by
     the canvas ribbons, the legend and the popover badges. */
  :root{--mf-tr-manual:#7A8899;--mf-tr-conveyor:#2E7D55;--mf-tr-agv:#1F78B4;
        --mf-tr-forklift:#B7791F;--mf-tr-asrs:#7A4FBF}
  html[data-theme="dark"]{--mf-tr-manual:#9AAABC;--mf-tr-conveyor:#2EE6A0;--mf-tr-agv:#5CB8FF;
        --mf-tr-forklift:#F5B05A;--mf-tr-asrs:#B694FF}

  .mfc{display:flex;flex-direction:column;gap:8px;width:100%}
  .mfc-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
  .mfc-tool{font:inherit;font-size:12px;font-weight:600;padding:6px 11px;border-radius:9px;
    border:1px solid var(--line-strong,rgba(120,140,170,.3));background:var(--bg-app,#fff);
    color:var(--ink-secondary,#52677c);cursor:pointer}
  .mfc-tool:hover{background:var(--bg-hover,#f1f0ed);color:var(--ink-primary,#16202e)}
  .mfc-tool:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:2px}
  .mfc-tip{font-size:11px;color:var(--ink-tertiary,#8195a8);line-height:1.5}
  .mfc-stage{position:relative;height:clamp(320px,48vh,540px);border-radius:13px;overflow:hidden;
    border:1px solid var(--line,rgba(120,140,170,.18));background:var(--bg-panel,#f7f6f3);
    background-image:radial-gradient(var(--line-hair,rgba(120,140,170,.22)) 1px,transparent 1px);
    background-size:24px 24px;resize:vertical}
  .mfc-svg{position:absolute;inset:0;width:100%;height:100%;display:block;
    cursor:grab;touch-action:none;user-select:none}
  .mfc-svg.is-pan{cursor:grabbing}

  /* 工程カード */
  .mfc-node{cursor:grab}
  .mfc-node-bg{fill:var(--bg-app,#fff);stroke:var(--line-strong,rgba(120,140,170,.34));stroke-width:1.2}
  .mfc-node:hover .mfc-node-bg{stroke:var(--accent,#16C0DE)}
  .mfc-node.is-sel .mfc-node-bg{stroke:var(--accent,#16C0DE);stroke-width:2.2}
  .mfc-node.is-warn .mfc-node-bg{stroke:var(--warn,#B7791F);stroke-dasharray:6 4}
  .mfc-node.is-target .mfc-node-bg{stroke:var(--accent,#16C0DE);stroke-width:2.6;
    fill:color-mix(in srgb,var(--accent,#16C0DE) 12%,var(--bg-app,#fff))}
  .mfc-node:focus{outline:none}
  .mfc-node:focus-visible .mfc-node-bg{stroke:var(--line-focus,#0E8FA8);stroke-width:2.6}
  .mfc-nname{font:700 13px var(--font-sans,sans-serif);fill:var(--ink-primary,#16202e)}
  .mfc-nsub{font:500 10.5px var(--font-sans,sans-serif);fill:var(--ink-tertiary,#8195a8)}
  .mfc-nmh{font:600 11px var(--font-mono,monospace);fill:var(--ink-secondary,#52677c)}
  .mfc-nbadge-bg{fill:color-mix(in srgb,var(--accent,#16C0DE) 16%,transparent)}
  .mfc-nbadge-tx{font:700 10px var(--font-sans,sans-serif);fill:var(--accent-ink,var(--accent,#16C0DE))}
  .mfc-node.is-calc .mfc-nbadge-bg{fill:var(--bg-hover,#f1f0ed)}
  .mfc-node.is-calc .mfc-nbadge-tx{fill:var(--ink-tertiary,#8195a8)}

  /* 矢印 = 物の流れ (太さ=物量 / 色=搬送手段 / 破線=自動)。
     色と太さは グループの --mf-c / --mf-w に載せる: インラインstyleで直接 stroke を
     書くと 注意(is-warn) の上書きが効かなくなるため（詳細度ではなく継承で解く）。*/
  .mfc-edge{cursor:pointer}
  .mfc-edge-hit{fill:none;stroke:transparent;stroke-width:18;pointer-events:stroke}
  .mfc-edge-line{fill:none;stroke-linecap:round;pointer-events:none;opacity:.9;
    stroke:var(--mf-c,#7A8899);stroke-width:var(--mf-w,2px)}
  .mfc-edge-halo{fill:none;stroke-linecap:round;pointer-events:none;stroke-opacity:0;
    stroke:var(--mf-c,#7A8899);stroke-width:var(--mf-wh,11px)}
  .mfc-edge:hover .mfc-edge-halo{stroke-opacity:.16}
  .mfc-edge.is-sel .mfc-edge-halo{stroke-opacity:.3}
  .mfc-edge.is-derived .mfc-edge-line{stroke-dasharray:9 6;opacity:.62}
  .mfc-edge.is-warn{--mf-c:var(--warn,#B7791F)}
  .mfc-edge-head{pointer-events:none;fill:var(--mf-c,#7A8899)}
  .mfc-edge-tail{pointer-events:none;fill:var(--mf-c,#7A8899)}
  .mfc-edge:focus{outline:none}
  .mfc-edge:focus-visible .mfc-edge-halo{stroke-opacity:.34}
  /* 削除の × は ホバー/選択のときだけ「押せる」。opacity:0 のままだと当たり判定が
     残り、矢印の真ん中を押したつもりで流れが消える（＝いちばん押したい場所が地雷）。*/
  .mfc-x{opacity:0;cursor:pointer;pointer-events:none;transition:opacity var(--dur-2,140ms) ease}
  .mfc-edge:hover .mfc-x,.mfc-edge.is-sel .mfc-x,.mfc-edge:focus-visible .mfc-x{
    opacity:1;pointer-events:auto}
  .mfc-x-bg{fill:var(--bg-app,#fff);stroke:var(--line-strong,rgba(120,140,170,.34))}
  .mfc-x-tx{font:700 11px var(--font-sans,sans-serif);fill:var(--ink-secondary,#52677c);
    text-anchor:middle;pointer-events:none}
  .mfc-rubber{fill:none;stroke:var(--accent,#16C0DE);stroke-width:2.4;stroke-dasharray:7 5;
    pointer-events:none}
  @media (prefers-reduced-motion:reduce){.mfc-x{transition:none}}

  /* 空の状態 / 凡例 / 名前入力 */
  .mfc-hollow{position:absolute;inset:0;display:flex;flex-direction:column;gap:6px;
    align-items:center;justify-content:center;text-align:center;padding:18px;
    color:var(--ink-secondary,#52677c);font-size:13px;line-height:1.6;pointer-events:none}
  /* a class rule beats the UA [hidden] rule, so say it here or the empty state
     stays painted on top of a perfectly good graph. Every class here that sets a
     display AND is toggled with el.hidden needs its own guard: .mfc-hollow,
     .mfc-legend, .mfc-pop. */
  .mfc-hollow[hidden]{display:none}
  .mfc-hollow b{color:var(--ink-primary,#16202e);font-size:14px}
  .mfc-legend{position:absolute;left:9px;bottom:9px;display:flex;gap:9px;flex-wrap:wrap;
    align-items:center;padding:5px 9px;border-radius:999px;pointer-events:none;
    background:color-mix(in srgb,var(--bg-app,#fff) 84%,transparent);
    border:1px solid var(--line-hair,rgba(120,140,170,.22))}
  .mfc-legend[hidden]{display:none}
  .mfc-lg{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;
    color:var(--ink-secondary,#52677c);white-space:nowrap}
  .mfc-lg i{width:14px;height:3px;border-radius:2px;display:inline-block}
  .mfc-lg i.dash{background:none;border-top:3px dashed var(--ink-tertiary,#8195a8);height:0}
  .mfc-name-in{position:absolute;z-index:35;width:170px;font:inherit;font-size:13px;
    padding:7px 9px;border-radius:9px;border:1.5px solid var(--accent,#16C0DE);
    background:var(--bg-app,#fff);color:var(--ink-primary,#16202e)}
  .mfc-name-in:focus{outline:none}

  /* 設計の注意（警告のみ。実行は止めない）*/
  .mfc-diag{display:flex;flex-direction:column;gap:4px}
  .mfc-diag-h{font-size:11px;font-weight:700;color:var(--ink-tertiary,#8195a8);
    letter-spacing:.04em}
  .mfc-diag-row{display:flex;gap:7px;align-items:flex-start;text-align:left;width:100%;
    padding:5px 9px;border-radius:7px;font:inherit;font-size:11.5px;line-height:1.5;cursor:pointer;
    border:1px solid var(--warn-line,#efdfbe);background:var(--warn-tint,#fbf3e4);
    color:var(--ink-primary,#16202e)}
  .mfc-diag-row:hover{filter:brightness(1.02)}
  .mfc-diag-row:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:1px}
  .mfc-diag-mark{flex:0 0 auto;font-weight:700}
  .mfc-diag-msg{flex:1;min-width:0;word-break:break-word}

  /* ポップオーバー（矢印＝1本の流れを設計する唯一の場所 / 工程カード）*/
  .mfc-pop{position:absolute;z-index:40;width:296px;max-width:calc(100% - 16px);
    max-height:calc(100% - 16px);overflow:auto;padding:12px 13px 11px;border-radius:12px;
    background:var(--bg-app,#fff);color:var(--ink-primary,#16202e);font-size:12.5px;
    border:1px solid var(--line-strong,rgba(120,140,170,.3));
    box-shadow:var(--sh-pop,0 14px 40px rgba(15,15,15,.18))}
  .mfc-pop[hidden]{display:none}
  .mfc-pop-h{display:flex;align-items:center;gap:6px;margin:0 0 9px;font-size:13px;font-weight:700}
  .mfc-pop-h .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mfc-pop-close{border:none;background:transparent;color:var(--ink-tertiary,#8195a8);
    font-size:17px;line-height:1;cursor:pointer;padding:0 2px}
  .mfc-pop-close:hover{color:var(--ink-primary,#16202e)}
  .mfc-row{display:flex;flex-direction:column;gap:3px;margin-bottom:9px}
  .mfc-row>label{font-size:10.5px;color:var(--ink-tertiary,#8195a8)}
  .mfc-row2{display:flex;gap:7px}
  .mfc-row2>.mfc-row{flex:1 1 0;min-width:0}
  .mfc-pop select,.mfc-pop input{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;
    padding:6px 8px;border-radius:7px;border:1px solid var(--line-strong,rgba(120,140,170,.3));
    background:var(--bg-app,#fff);color:var(--ink-primary,#16202e)}
  .mfc-pop select:focus,.mfc-pop input:focus{outline:none;border-color:var(--accent,#16C0DE)}
  .mfc-pop input[type=number]{text-align:right}
  .mfc-sec{font-size:10.5px;font-weight:700;color:var(--ink-tertiary,#8195a8);
    margin:2px 0 5px;letter-spacing:.04em}
  .mfc-chip{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11.5px;
    font-weight:700;padding:3px 10px;border-radius:999px;cursor:pointer;
    border:1px dashed var(--accent,#16C0DE);color:var(--accent-ink,var(--accent,#16C0DE));
    background:color-mix(in srgb,var(--accent,#16C0DE) 10%,transparent)}
  .mfc-chip:hover{background:color-mix(in srgb,var(--accent,#16C0DE) 18%,transparent)}
  .mfc-chip:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:2px}
  .mfc-chip-in{width:86px !important;display:inline-block}
  .mfc-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:-2px 0 9px}
  .mfc-prov{font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;
    color:var(--warn-ink,#8a5a12);background:var(--warn-tint,#fbf3e4);
    border:1px solid var(--warn-line,#efdfbe)}
  .mfc-chain{font-family:var(--font-mono,monospace);font-size:11px;line-height:1.6;
    color:var(--ink-secondary,#52677c);background:var(--bg-sunken,#f1f0ed);
    border-radius:8px;padding:6px 8px;margin-bottom:9px;word-break:break-word}
  .mfc-note{font-size:11px;line-height:1.55;color:var(--ink-tertiary,#8195a8);margin-bottom:8px}
  .mfc-pop-foot{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px}
  .mfc-pop-btn{font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;
    cursor:pointer;border:1px solid var(--line-strong,rgba(120,140,170,.3));
    background:var(--bg-app,#fff);color:var(--ink-secondary,#52677c)}
  .mfc-pop-btn:hover{background:var(--bg-hover,#f1f0ed)}
  .mfc-pop-btn.primary{background:var(--accent,#16C0DE);border-color:var(--accent,#16C0DE);
    color:var(--ink-onAccent,#04222c);font-weight:700}
  .mfc-pop-btn.danger{color:var(--bad,#C4453F);border-color:var(--bad,#C4453F)}
  .mfc-pop-btn:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:2px}
  .mfc-tr-dot{width:11px;height:11px;border-radius:3px;display:inline-block;flex:0 0 auto}
  `;
  document.head.appendChild(s);
}
