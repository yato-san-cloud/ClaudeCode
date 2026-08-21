/* lib.jsx — icons + scenario data, exported to window */
const { useState, useEffect, useRef, useCallback } = React;

/* ---- Icon set (Feather/Lucide-style, 1.6 stroke) ------------------------- */
const PATHS = {
  box:        '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  upload:     '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  play:       '<path d="m6 4 14 8-14 8Z"/>',
  pause:      '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  skipBack:   '<path d="M18 5 8 12l10 7zM6 5v14"/>',
  skipFwd:    '<path d="M6 5l10 7-10 7zM18 5v14"/>',
  check:      '<path d="M20 6 9 17l-5-5"/>',
  checkCircle:'<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m22 4-10 10-3-3"/>',
  alert:      '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  alertCircle:'<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  layout:     '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  cpu:        '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  frame:      '<path d="M22 3H2v18h20zM2 9h20M2 15h20M8 3v18M16 3v18"/>',
  flow:       '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h6a3 3 0 0 1 3 3v6"/>',
  route:      '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a3 3 0 0 0 3-3V8"/>',
  film:       '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  cube:       '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  image:      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  columns:    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  download:   '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M21 21H3"/>',
  chevDown:   '<path d="m6 9 6 6 6-6"/>',
  chevRight:  '<path d="m9 6 6 6-6 6"/>',
  folder:     '<path d="M4 5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H4Z"/>',
  file:       '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  plus:       '<path d="M12 5v14M5 12h14"/>',
  minus:      '<path d="M5 12h14"/>',
  users:      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/>',
  clock:      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  zap:        '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>',
  gauge:      '<path d="M12 14 8 9"/><circle cx="12" cy="13" r="9"/><path d="M12 4v1M21 13h-1M4 13H3"/>',
  trend:      '<path d="m3 17 6-6 4 4 8-8"/><path d="M17 7h4v4"/>',
  refresh:    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  settings:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 6.6 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.4H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 6.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 3.6V3a2 2 0 0 1 4 0v.1A1.6 1.6 0 0 0 17.4 5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  truck:      '<path d="M14 7h4l3 3v5h-2"/><path d="M2 7h12v8H2zM2 15h3"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  inbox:      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3-7z"/>',
  archive:    '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  shuffle:    '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  package:    '<path d="m7.5 4.3 9 5.2M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  copy:       '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  share:      '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  link:       '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  sparkle:    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2"/>',
  database:   '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  grip:       '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
};
function Icon({ name, size = 18, stroke = 1.6, className = '', style }) {
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: PATHS[name] || '' }} aria-hidden="true" />
  );
}

/* ---- Scenario data --------------------------------------------------------
   元設計(whsim)の語彙・実値に準拠。専門用語は元設計どおり残しつつ、
   結論と信頼度が前面に出る構成にする。 */
const SCENARIO = {
  project: '新規倉庫プラン',
  runId: 'run_0001',
  // プロベナンス: 実データ何% / 取り込み済み / 仮値の項目
  provenance: {
    realPct: 0,
    imported: 'なし',
    templated: ['基本情報','レイアウト','ロケーション','商品マスタ','オペレーション','人員','設備','出荷','入荷データ','実行条件'],
  },
  importHint: '商品マスタ / 出荷 / 入荷 …（足りない分は仮値で補完）',
  // キー項目（元設計どおり）
  fields: [
    { id: 'pickers', label: 'ピッカー人数', unit: '名',   value: 6,   step: 1,   min: 1, max: 40,  prov: 0 },
    { id: 'orders',  label: '出荷オーダー', unit: '件/時', value: 120, step: 10,  min: 0, max: 600, prov: 0 },
    { id: 'method',  label: 'ピッキング方式', kind: 'select', value: 0, opts: ['都度ピック','トータルピック','マルチオーダー','ゾーンピック'], prov: 0 },
    { id: 'hours',   label: '稼働時間',     unit: '時間', value: 8,   step: 1,   min: 1, max: 24,  prov: 0 },
    { id: 'speed',   label: '歩行速度',     unit: 'm/s',  value: 1.2, step: 0.1, min: 0.5, max: 2.0, dec: 1, prov: 0 },
  ],
  // 判定（元設計の文言に準拠）
  verdict: {
    state: 'ok',
    title: '対応可能',
    desc: 'ピッキング工程の稼働率 45% で需要をさばけます。10回中10回が安定処理でした。',
    stability: 5, stabilityLabel: '100%', stabilityNote: '10回検証',
  },
  // 下部KPIバー（元設計の主要指標）
  kpis: [
    { id: 'throughput', label: 'スループット', icon: 'box', value: 120, unit: '件/時',
      band: { p5: 112, p50: 120, p95: 125 }, delta: null },
    { id: 'shipped', label: '出荷完了', icon: 'truck', value: '961', sub: '/ 965', unit: '件',
      delta: null, note: '達成率 99.6%' },
    { id: 'bottleneck', label: 'ボトルネック', icon: 'gauge', text: 'ピッキング', unit: '稼働 45%',
      tone: 'warn' },
    { id: 'leadtime', label: '処理時間 中央値/最悪', icon: 'clock', text: '2 / 4', unit: '分' },
    { id: 'walk', label: '1件あたり歩行', icon: 'route', value: 89, unit: 'm' },
    { id: 'cost', label: '1件あたりコスト', icon: 'package', value: '¥165.1', raw: true },
  ],
  // 詳細KPI（比較タブ等で使用）
  kpiDetail: [
    { label: 'ピッカー稼働率', value: '45%', sub: '6名' },
    { label: '棚台稼働率',   value: '44%', sub: '3台' },
    { label: '月間コスト',   value: '¥3,960,000' },
    { label: '安定度',       value: '100%', sub: '10回検証' },
  ],
  process: [
    { id: 'in',   name: '入荷',   icon: 'truck',   load: 38, prov: 'est' },
    { id: 'put',  name: '格納',   icon: 'archive', load: 52, prov: 'est' },
    { id: 'repl', name: '補充',   icon: 'refresh', load: 41, prov: 'est' },
    { id: 'pick', name: 'ピッキング', icon: 'inbox', load: 45, prov: 'est', bottleneck: true },
    { id: 'sort', name: '仕分け', icon: 'shuffle', load: 33, prov: 'est' },
    { id: 'pack', name: '梱包',   icon: 'package', load: 29, prov: 'est' },
    { id: 'out',  name: '出荷',   icon: 'truck',   load: 31, prov: 'est' },
  ],
  // 比較（現行↔提案）。元設計のKPIを軸に。
  compare: [
    { metric: 'スループット',   note: '1時間あたり処理数', cur: '96',  neu: '120', unit: '件/時', delta: +25, good: true },
    { metric: '出荷完了率',     note: '当日締切まで',     cur: '92.4', neu: '99.6', unit: '%',   delta: +8,  good: true },
    { metric: '処理時間(中央値)', note: 'オーダー1件',     cur: '3',    neu: '2',   unit: '分',   delta: -33, good: true },
    { metric: '1件あたり歩行',  note: 'ピッカー移動距離', cur: '118',  neu: '89',  unit: 'm',   delta: -25, good: true },
    { metric: '1件あたりコスト', note: '人件費ベース',     cur: '198',  neu: '165', unit: '円',   delta: -17, good: true },
    { metric: '安定度',         note: '10回試算の安定率', cur: '中',   neu: '高',  unit: '',    delta: 0,  good: true, qualitative: true },
  ],
  // 2D 凡例（元設計どおり）
  agentLegend: [
    { id: 'wait',  name: '待機', cls: 'wait' },
    { id: 'move',  name: '移動', cls: 'move' },
    { id: 'pick',  name: 'ピック', cls: 'pick' },
    { id: 'carry', name: '運搬', cls: 'carry' },
    { id: 'pack',  name: '梱包', cls: 'pack' },
  ],
  // 3D表現プリセット
  render3d: ['ナチュラル', 'ワイヤー', 'ヒートマップ'],
};

Object.assign(window, { Icon, PATHS, SCENARIO,
  useState, useEffect, useRef, useCallback });
