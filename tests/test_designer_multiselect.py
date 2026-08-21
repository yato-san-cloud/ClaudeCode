"""Behavior guard for the designer's PowerPoint-style multi-select (select.js).

The 配置 layout editor gained a rubber-band marquee, Shift-click toggling, and
group move/delete over a mixed selection (shelves + zones + equipment + stations
+ doors). That logic is pure over ``this.model`` + ``this.marquee``, so we drive
``selectMethods`` directly in node against a synthetic Designer host — no browser
needed — to lock in: what the marquee selects, the single-select collapse, the
snapped/clamped group move (doors stay on the envelope), and the one-undo group
delete. Skipped when node is unavailable.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

import whsim

NODE = shutil.which("node")
SELECT_JS = (Path(whsim.__file__).resolve().parent
             / "web" / "static" / "js" / "designer" / "select.js")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not installed")

_HARNESS = r"""
import { selectMethods } from %(path)s;

function makeHost() {
  const model = {
    layout: {
      bounds: { width: 60, depth: 30 },
      zones: [
        { id: 'z-store', x: 14, y: 1, w: 45, h: 28, type: 'storage',
          shelves: [{ id: 'sh1', x: 16, y: 3, w: 1, h: 4 }, { id: 'sh2', x: 20, y: 3, w: 1, h: 4 }] },
        { id: 'z-pack', x: 0, y: 8, w: 12, h: 14, type: 'packing' },
        { id: 'z-ship', x: 0, y: 0, w: 12, h: 8, type: 'shipping' },
      ],
      doors: [{ id: 'd1', x: 0, y: 5 }],
    },
    resources: { equipment: [{ id: 'e1', x: 30, y: 10 }], stations: [{ id: 'st1', x: 6, y: 15 }] },
  };
  const host = {
    model, selected: null, selShelves: new Set(), selObjs: [], marquee: null, drag: null,
    _pushUndo() { this._undos = (this._undos || 0) + 1; },
    _renderSide() {}, _repaint() {}, _updateStatus() {}, _renderTool() {}, _renderLibrary() {},
    _drawCanvas() {}, lib: null, _layoutStatus: null,
    _allShelves() { return (model.layout.zones || []).flatMap((z) => (z.shelves || []).map((sh) => ({ sh, zone: z }))); },
    _selShelfObjs() { return this._allShelves().filter(({ sh }) => this.selShelves.has(sh.id)); },
    _storageZones() { return (model.layout.zones || []).filter((z) => z.type === 'storage'); },
    _snapDoorPos(x, y) { return { x: 0, y }; },
    _brushHint() { return ''; },
  };
  Object.assign(host, selectMethods);
  return host;
}

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL: ' + m); } };

// marquee over the whole floor selects every intersecting object
let h = makeHost();
h.marquee = { x0: 0, y0: 0, x1: 60, y1: 30 }; h._marqueeCommit(false);
ok(h.selShelves.size === 2, 'marquee shelves=2');
ok(h.selObjs.length === 6, 'marquee objs=6');
ok(h._multiCount() === 8, 'multiCount=8');
ok(/棚2/.test(h._multiBreakdown()) && /ゾーン3/.test(h._multiBreakdown()), 'breakdown');

// marquee over the left band excludes the big storage zone + its equipment
h = makeHost();
h.marquee = { x0: 0, y0: 0, x1: 12, y1: 30 }; h._marqueeCommit(false);
const ids = h.selObjs.map((o) => o.id);
ok(!ids.includes('z-store') && !ids.includes('e1'), 'left marquee excludes storage+equip');
ok(ids.includes('z-pack') && ids.includes('z-ship'), 'left marquee includes pack+ship');

// shift-toggle add then remove → collapses to single-select
h = makeHost();
h.selected = { kind: 'zone', id: 'z-store' };
h._toggleMultiObj('zone', 'z-pack');
ok(h._multiCount() === 2, 'toggle add → 2');
h._toggleMultiObj('zone', 'z-pack');
ok(h._multiCount() === 0 && h.selected && h.selected.id === 'z-store', 'toggle remove → single-select');

// group move applies one snapped, clamped delta; doors stay on the envelope
h = makeHost();
h.marquee = { x0: 0, y0: 0, x1: 12, y1: 30 }; h._marqueeCommit(false);
const pack = h.model.layout.zones.find((z) => z.id === 'z-pack');
const ox = pack.x, oy = pack.y;
h._groupMoveStart(5, 5); h._groupMoveApply(8, 9);
ok(pack.x === ox + 3 && pack.y === oy + 4, 'group move delta');
ok(h.model.layout.doors[0].x === 0, 'door projected on envelope');

// group delete removes the whole union as one undo entry
h = makeHost();
h.marquee = { x0: 0, y0: 0, x1: 60, y1: 30 }; h._marqueeCommit(false);
h._deleteMultiSelection();
ok(h.model.layout.zones.length === 0, 'zones deleted');
ok(h.model.resources.equipment.length === 0 && h.model.resources.stations.length === 0, 'equip+stations deleted');
ok(h.model.layout.doors.length === 0, 'doors deleted');
ok(h._undos === 1, 'one undo entry');
ok(h._multiCount() === 0, 'selection cleared');

process.stdout.write(fail ? ('FAILURES=' + fail) : 'ALLOK');
process.exit(fail ? 1 : 0);
"""


def test_designer_multiselect_logic(tmp_path):
    import json
    harness = tmp_path / "ms.mjs"
    harness.write_text(_HARNESS % {"path": json.dumps(str(SELECT_JS))}, encoding="utf-8")
    out = subprocess.run([NODE, str(harness)], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, f"select.js logic failed:\n{out.stdout}\n{out.stderr}"
    assert out.stdout.strip() == "ALLOK", out.stdout
