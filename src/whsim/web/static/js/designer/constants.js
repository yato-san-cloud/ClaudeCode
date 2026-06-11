// designer/constants.js — palettes, label maps, and geometry constants for the
// structured/parametric warehouse design editor (the MapMaker-style layout tool).
//
// Pure data only: no DOM, no `this`, no behaviour. These were previously declared
// at the top of designer.js; they are moved here verbatim so future feature work
// touches one small module. The shared zone-label map `ZONE_JP` lives in the
// app-wide constants.js; it is re-exported here so core.js has one import surface.
import { ZONE_JP } from '../constants.js';
export { ZONE_JP };

// ---- constants -------------------------------------------------------------
export const ZONE_TYPES = ['receiving', 'storage', 'picking', 'packing', 'shipping', 'staging'];
export const ZONE_DEFAULT_COLOR = {
  receiving: '#74add1', storage: '#fdae61', picking: '#a6d96a',
  packing: '#f46d43', shipping: '#5e4fa2', staging: '#d9d9d9',
};
// Equipment palette: label, schema type, fill color.
export const EQUIP_PALETTE = [
  { key: 'agv', label: 'AGV(搬送ロボ)', type: 'agv', color: '#1f78b4' },
  { key: 'conveyor', label: 'コンベア', type: 'conveyor', color: '#33a02c' },
  { key: 'asrs', label: '自動倉庫', type: 'asrs', color: '#6a3d9a' },
  { key: 'station', label: '梱包台', type: 'station', color: '#08519c' },
  { key: 'robot_arm', label: 'ロボットアーム', type: 'robot_arm', color: '#e6550d' },
  { key: 'crane', label: 'ホイストクレーン', type: 'crane', color: '#8c564b' },
];
// Layout object palette (PPT-like): pick an object, then click the floor to place it.
//   key       — palette/brush id (also a tooltip for the cursor)
//   label     — Japanese button label
//   zoneType  — schema zone type to create
//   w,h       — default footprint in meters
//   rack      — if set, the new zone is created with this parametric rack fill
export const LAYOUT_PALETTE = [
  { key: 'shelf_block', label: '棚ブロック', zoneType: 'storage', w: 12, h: 8,
    rack: { col_spacing: 4, row_spacing: 3, margin: 2 } },
  { key: 'pack_station', label: '梱包台', zoneType: 'packing', w: 6, h: 4 },
  { key: 'receiving', label: '入荷ゾーン', zoneType: 'receiving', w: 10, h: 6 },
  { key: 'picking', label: 'ピッキングゾーン', zoneType: 'picking', w: 10, h: 6 },
  { key: 'shipping', label: '出荷ゾーン', zoneType: 'shipping', w: 10, h: 6 },
  { key: 'staging', label: '一時保管ゾーン', zoneType: 'staging', w: 8, h: 5 },
];
// Storage-equipment presets — the WITNESS-style object library (M3 設備パレット).
// This is the JS twin of whsim.racktypes.RACK_TYPES (served at /api/racktypes);
// we mirror the full catalog (label, bay×depth in metres, levels, per-cell
// capacity, render colour, one-line desc) so the equipment palette can show
// specs without a round-trip, and so the 2D colour + 3D geometry agree.
// `silhouette` keys the tiny 2D icon family to view3d.js's geometry builders
// (shelving / pallet-beam / nestainer-stack / flow-roller / asrs-crane) so a
// palette card previews how that type actually renders in 3D. `levels`/`h`
// mirror RACK_DIMS in view3d.js. If /api/racktypes is reachable the live catalog
// overrides label/bay/depth/levels/capacity/color/desc at runtime
// (see _loadRackCatalog), so a backend change to the presets flows through.
// NOTE: this object (and RACK_ORDER below) is mutated IN PLACE by
// Designer._loadRackCatalog. ES module bindings share the same reference across
// modules, so the live-catalog merge stays visible to every importer.
export const RACK_TYPES = {
  light:     { label: '軽量棚', bay: 0.9, depth: 0.45, levels: 5, capacity: 30,
               color: '#7fb0f2', silhouette: 'shelving', h: 2.0,
               desc: '小物・ピース。手前ピッキング向き。' },
  medium:    { label: '中量棚', bay: 1.2, depth: 0.6, levels: 4, capacity: 120,
               color: '#2ee6a0', silhouette: 'shelving', h: 2.4,
               desc: 'ケース・中量品の定番。' },
  pallet:    { label: 'パレットラック', bay: 1.1, depth: 1.1, levels: 4, capacity: 800,
               color: '#f5b05a', silhouette: 'pallet', h: 5.6,
               desc: 'パレット保管。フォークリフト前提。' },
  nestainer: { label: 'ネステナー', bay: 1.1, depth: 1.4, levels: 3, capacity: 600,
               color: '#9b6bff', silhouette: 'nestainer', h: 3.6,
               desc: 'ネステナー段積み。可搬・レイアウト自由。' },
  flow:      { label: 'フローラック', bay: 1.0, depth: 1.5, levels: 3, capacity: 200,
               color: '#34e3ff', silhouette: 'flow', h: 2.6,
               desc: '流動棚。先入先出のピッキング。' },
  asrs:      { label: '自動倉庫(AS/RS)', bay: 0.8, depth: 1.2, levels: 12, capacity: 2000,
               color: '#5cebff', silhouette: 'asrs', h: 16.0,
               desc: '高層自動倉庫。クレーン入出庫。' },
  mezzanine: { label: 'メザニン', bay: 2.0, depth: 2.0, levels: 2, capacity: 500,
               color: '#b0885f', silhouette: 'shelving', h: 4.5,
               desc: '中二階で床面積を倍化。上段からの出荷は昇降設備前提。' },
  mobile:    { label: '移動ラック', bay: 1.2, depth: 0.65, levels: 5, capacity: 150,
               color: '#e07ad2', silhouette: 'shelving', h: 2.6,
               desc: '通路を共有し保管効率最大。低頻度・長期滞留品向き。' },
  hanger:    { label: 'ハンガーラック', bay: 1.8, depth: 0.6, levels: 1, capacity: 60,
               color: '#c8d44e', silhouette: 'shelving', h: 2.2,
               desc: 'アパレル吊るし保管。シワ・畳みじわ回避。' },
};
// Insertion order = catalog order; mutated in place if /api/racktypes returns a
// different (or extended) ordering. The seed value matches racktypes.ORDER.
export const RACK_ORDER = ['light', 'medium', 'pallet', 'nestainer', 'flow', 'asrs',
                           'mezzanine', 'mobile', 'hanger'];
// Unknown ids (e.g. a future backend preset) fall back to the generic shelving
// silhouette so an extended catalog still renders a sensible card icon.
export const RACK_SILHOUETTE_FALLBACK = 'shelving';
// Door palette for the 躯体 (building) tool: label, schema type, marker color.
export const DOOR_PALETTE = [
  { type: 'dock', label: 'ドックドア', color: '#1f78b4' },
  { type: 'personnel', label: '通用口', color: '#33a02c' },
  { type: 'shutter', label: 'シャッター', color: '#888888' },
];
export const DOOR_JP = { dock: 'ドックドア', personnel: '通用口', shutter: 'シャッター' };
export const METHOD_OPTS = [
  { value: 'manual', label: '人手' }, { value: 'agv', label: 'AGV' },
  { value: 'conveyor', label: 'コンベア' }, { value: 'asrs', label: '自動倉庫' },
];
export const METHOD_COLOR = {
  manual: '#9aa4b0', agv: '#1f78b4', conveyor: '#33a02c', asrs: '#6a3d9a',
};
export const PICK_STRATS = [
  { value: 'discrete', label: '都度ピック' }, { value: 'batch', label: 'バッチ' },
  { value: 'zone', label: 'ゾーン' }, { value: 'wave', label: 'ウェーブ' },
];
// Work-method 5-axis controls (cf. docs/WORK_METHOD_DESIGN.md). Plain-Japanese
// labels for a non-expert; the expert term shows as a small sub-label. Only the
// pick stage exposes all 5 axes; other stages expose just transport (A).
export const WORK_AXES = {
  // A 搬送主体: who moves — 人が歩く / 物が来る
  transport: { label: '誰が動く？', sub: '搬送 (transport)', opts: [
    { value: 'manual', label: '人が歩く' }, { value: 'agv', label: 'AGV/AMRが来る' },
    { value: 'conveyor', label: 'コンベアで来る' }, { value: 'asrs', label: '自動倉庫が出す' },
  ] },
  // C ゾーン分担
  zoning: { label: 'エリアを分けて並列に採る？', sub: 'ゾーン (zoning)', opts: [
    { value: 'none', label: '全域を1人で' }, { value: 'sequential', label: 'ゾーンを順に受け渡し' },
    { value: 'parallel', label: 'ゾーン分担で並列' },
  ] },
  // D 採り方: 摘み取り / 種まき
  consolidation: { label: 'オーダー別？ 総量→仕分け？', sub: '集約 (consolidation)', opts: [
    { value: 'pick', label: 'オーダー別に採る（摘み取り）' },
    { value: 'sort', label: '総量を採って後で仕分け（種まき）' },
  ] },
  // E 投入: 連続 / ウェーブ
  release: { label: 'いつ流す？', sub: '投入 (release)', opts: [
    { value: 'continuous', label: '随時（連続）' }, { value: 'wave', label: '締め単位（ウェーブ）' },
  ] },
};
// Default 5-axis work method (mirrors schema WorkMethod defaults; always valid).
export const DEFAULT_WORK = {
  transport: 'manual', orders_per_trip: 1, zoning: 'none',
  consolidation: 'pick', release: 'continuous', wave_interval_s: 1800,
};
// 動線 (flow-line) movers: label, schema key, default speed (m/s), polyline color.
export const MOVER_OPTS = [
  { value: 'person', label: '作業員' }, { value: 'forklift', label: 'フォークリフト' },
];
export const MOVER_JP = { person: '作業員', forklift: 'フォークリフト' };
export const MOVER_SPEED = { person: 1.2, forklift: 2.0 };
export const MOVER_COLOR = { person: '#e7298a', forklift: '#1b9e77' };

export const HANDLE = 12;        // bottom-right resize handle size in px
export const MIN_M = 1;          // smallest zone dimension in meters
export const SNAP = 0.5;         // grid snap in meters

// ---- M2 (MapMaker editing) constants ---------------------------------------
// Edge-snap tolerance in *screen* pixels, mirroring MapMaker's MapInputHandler
// (`Math.abs(nearestScreen - x) <= 10`). The spec asks for ~8px; we use 8.
export const SNAP_PX = 8;
// Smallest shelf footprint when corner-to-corner dragging, in meters. MapMaker
// enforces `ObjectMinWidth/HeightSize`; whsim uses a non-expert-friendly 0.3 m
// (a single light-rack cell depth), so a fat-fingered tiny drag still yields a
// usable shelf rather than a degenerate sliver.
export const SHELF_MIN_M = 0.3;
// Control-point handle half-size in screen px (MapMaker ControlPoint.cornerSize=4).
export const CP_HALF = 5;
// 8 control points as (dxMask,dyMask) in {-1,0,1} like SelectionManager: the
// opposite corner/edge stays fixed while dragging a handle (relative 0..1 map).
export const CONTROL_POINTS = [
  { dx: -1, dy: -1, cur: 'nwse-resize' }, { dx: 0, dy: -1, cur: 'ns-resize' },
  { dx: 1, dy: -1, cur: 'nesw-resize' }, { dx: -1, dy: 0, cur: 'ew-resize' },
  { dx: 1, dy: 0, cur: 'ew-resize' }, { dx: -1, dy: 1, cur: 'nesw-resize' },
  { dx: 0, dy: 1, cur: 'ns-resize' }, { dx: 1, dy: 1, cur: 'nwse-resize' },
];
// 棚一括生成 frontage directions (mirrors ShelfArrayGenerator's cbFace order).
// `facing` is the schema 間口 direction; `axis` is the connection axis. Index 0/1
// (下/上) connect left-right along X; 2/3 (右/左) connect up-down along Y.
export const SHELFGEN_FACES = [
  { facing: 'down', axis: 'x', label: '下を向く（棚は左右に連結）' },
  { facing: 'up', axis: 'x', label: '上を向く（棚は左右に連結）' },
  { facing: 'right', axis: 'y', label: '右を向く（棚は上下に連結）' },
  { facing: 'left', axis: 'y', label: '左を向く（棚は上下に連結）' },
];
