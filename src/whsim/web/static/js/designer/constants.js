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
// w×d = nominal top-view footprint in METERS (render/ghost only — the schema
// keeps x,y; the footprint lets the canvas draw CAD-like scaled symbols instead
// of fixed-px circles, and gives the placement ghost its real size).
export const EQUIP_PALETTE = [
  { key: 'agv', label: 'AGV(搬送ロボ)', type: 'agv', color: '#1f78b4', w: 1.2, d: 0.9,
    desc: '無人搬送ロボ。棚↔梱包台の搬送を自動化。' },
  { key: 'conveyor', label: 'コンベア', type: 'conveyor', color: '#33a02c', w: 0, d: 0,
    desc: '搬送ライン。クリックで頂点を追加して描く。' },
  { key: 'asrs', label: '自動倉庫', type: 'asrs', color: '#6a3d9a', w: 3.0, d: 1.4,
    desc: '高層自動倉庫(AS/RS)。クレーンで入出庫。' },
  { key: 'station', label: '梱包台', type: 'station', color: '#08519c', w: 1.8, d: 0.9,
    desc: '梱包・検品の作業台。' },
  { key: 'robot_arm', label: 'ロボットアーム', type: 'robot_arm', color: '#e6550d', w: 1.0, d: 1.0,
    desc: 'ピース仕分け・パレタイズ用アーム。' },
  { key: 'crane', label: 'ホイストクレーン', type: 'crane', color: '#8c564b', w: 2.4, d: 1.0,
    desc: '重量物の吊り上げ搬送。' },
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
  { value: 'discrete', label: 'シングルオーダー' }, { value: 'batch', label: 'マルチオーダー' },
  { value: 'zone', label: 'ゾーン（リレー）' }, { value: 'wave', label: 'バッチ投入' },
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
  // E 投入: 連続 / バッチ（締め単位）
  release: { label: 'いつ流す？', sub: '投入 (release)', opts: [
    { value: 'continuous', label: '随時（連続）' }, { value: 'wave', label: '締め単位（バッチ）' },
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

// ---- Library / hotbar (Minecraft-style place tool) --------------------------
// The 配置 tool replaces the old ゾーン棚/設備/躯体 tab trio with one object
// LIBRARY: every placeable thing is a card; clicking (or dragging onto the
// floor) arms it as the active brush. `LIBRARY_DIGITS` pins the digit keys 1-9
// to the most-used brushes, MapMaker-style (its OperationModeToolBar used fixed
// digits: 1=編集 3=棚 4=壁 5=検品場), so MapMaker muscle memory transfers.
export const LIBRARY_DIGITS = [
  { digit: 1, kind: 'select' },                 // 編集 (select/move)
  { digit: 2, kind: 'zone', key: 'storage' },   // 保管ゾーン (棚の容れ物)
  { digit: 3, kind: 'rack' },                   // 棚 (active rack type)
  { digit: 4, kind: 'wall' },                   // 壁
  { digit: 5, kind: 'equip', key: 'station' },  // 梱包台 (検品場相当)
  { digit: 6, kind: 'equip', key: 'agv' },
  { digit: 7, kind: 'equip', key: 'conveyor' },
  { digit: 8, kind: 'equip', key: 'asrs' },
  { digit: 9, kind: 'door', key: 'dock' },
];

// ---- Whole-warehouse design discipline (AnyLogic-style area semantics) ------
// Equipment ↔ zone-type compatibility. The simulator designs the WHOLE flow
// (入庫→仮置き→保管→梱包→出荷), so fixed equipment must sit in an area whose
// process can actually use it — a 梱包台 inside the 保管エリア is a design
// error, not a preference. `allow` lists the zone types the item may sit IN;
// bare floor (no zone under the cursor) is always allowed. Transport movers
// (AGV / conveyor) roam the whole floor and carry no entry here.
export const EQUIP_ZONE_RULES = {
  station:   { allow: ['packing', 'shipping', 'staging'],
               jp: '梱包台は梱包・出荷・一時保管エリアに置きます' },
  asrs:      { allow: ['storage'],
               jp: '自動倉庫(AS/RS)は保管エリアに置きます' },
  robot_arm: { allow: ['packing', 'picking', 'receiving', 'shipping'],
               jp: 'ロボットアームは作業系エリア（梱包/ピッキング/入出荷）に置きます' },
  crane:     { allow: ['receiving', 'shipping', 'storage'],
               jp: 'クレーンは入出荷・保管エリアに置きます' },
};
// Stage ↔ expected zone types: the area-chain contract the flow tab validates
// (each 工程 must be bound to an area of a type that can host it).
export const STAGE_ZONE_TYPES = {
  receive: ['receiving'],
  putaway: ['storage', 'staging'],
  pick:    ['storage', 'picking'],
  pack:    ['packing'],
  ship:    ['shipping', 'staging'],
};

// ---- レイアウト診断 / 人流アニメーション (動線タブ) -------------------------
// Re-audit debounce: long enough that a drag doesn't spam the endpoint, short
// enough that sealing an aisle turns the chip red while your hand is still on
// the mouse. That immediacy IS the feature.
export const AUDIT_DEBOUNCE_MS = 300;
// How many walkers the 人流アニメーション puts on the floor (one per sampled
// pick face). Enough to read as a flow, few enough to stay legible.
export const PFLOW_WALKERS = 8;
// Wall-clock seconds for one 入荷→ピック→出荷 tour, regardless of floor size —
// a fixed cadence reads as "flow" on both a 30 m and a 110 m warehouse.
export const PFLOW_TOUR_S = 16;
// Audit overlay colours (canvas-side; the DOM chips use the app's CSS vars).
export const AUDIT_COLOR = {
  bad: '#e3401c',        // 到達できない棚 / 分断された床
  warn: '#d98200',       // 人が通れない狭さ
  info: '#c9a227',       // フォークリフトが通れない狭さ
  walkIn: '#1f78b4',     // 入荷→ピック面 の脚
  walkOut: '#1db954',    // ピック面→梱包/出荷 の脚
};
