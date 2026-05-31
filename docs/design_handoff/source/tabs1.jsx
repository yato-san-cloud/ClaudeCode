/* tabs1.jsx — Design tab (#design), 2D view (#view2d), 3D view (#view3d) */

/* ----- DESIGN ------------------------------------------------------------- */
const SUBTOOLS = [
  { id: 'layout', name: 'レイアウト', icon: 'layout' },
  { id: 'equip',  name: '設備',       icon: 'cpu' },
  { id: 'frame',  name: '躯体',       icon: 'frame' },
  { id: 'flow',   name: 'フロー',     icon: 'flow' },
  { id: 'route',  name: '動線',       icon: 'route' },
];

const ZONES = [
  { id: 'in',   label: '入荷',   x: 2,  y: 4,  w: 18, h: 30, tint: 'var(--accent-tint)',  line: 'var(--accent-tint-2)' },
  { id: 'store',label: '保管',   x: 23, y: 4,  w: 44, h: 62, tint: 'var(--bg-sunken)',    line: 'var(--line-hair)' },
  { id: 'pick', label: 'ピッキング', x: 23, y: 70, w: 44, h: 26, tint: 'var(--warn-tint)', line: 'var(--warn-line)' },
  { id: 'pack', label: '梱包・出荷', x: 70, y: 4, w: 28, h: 92, tint: 'var(--ok-tint)',    line: 'var(--ok-line)' },
];

function WarehouseCanvas({ tool }) {
  const racks = [];
  for (let c = 0; c < 5; c++) {
    racks.push({ x: 26 + c * 8, y: 8, w: 4.5, h: 54 });
  }
  const showFlow = tool === 'flow' || tool === 'route';
  return (
    <div className="wh-canvas" role="img" aria-label="倉庫レイアウトの俯瞰図">
      {ZONES.map((z) => (
        <div key={z.id} className="wh-zone"
          style={{ left: z.x + '%', top: z.y + '%', width: z.w + '%', height: z.h + '%',
            background: z.tint, borderColor: z.line }}>
          <span className="wh-zone__tag">{z.label}</span>
        </div>
      ))}
      {(tool === 'layout' || tool === 'frame' || tool === 'equip') && racks.map((r, i) => (
        <div key={i} className="wh-rack" style={{ left: r.x + '%', top: r.y + '%', width: r.w + '%', height: r.h + '%' }} />
      ))}
      {showFlow && (
        <React.Fragment>
          <div className="wh-aisle-flow" style={{ left: '11%', top: '50%', width: '12%' }} />
          <div className="wh-aisle-flow" style={{ left: '45%', top: '83%', width: '24%' }} />
          <div className="wh-aisle-flow" style={{ left: '67%', top: '50%', width: '5%', transform: 'rotate(0deg)' }} />
          <div className="wh-node" style={{ left: '11%', top: '50%' }} />
          <div className="wh-node" style={{ left: '45%', top: '40%' }} />
          <div className="wh-node" style={{ left: '45%', top: '83%' }} />
          <div className="wh-node" style={{ left: '84%', top: '50%' }} />
        </React.Fragment>
      )}
      {tool === 'equip' && (
        <div style={{ position: 'absolute', left: '70%', top: '50%', width: '28%', height: '8%',
          background: 'var(--accent)', opacity: .25, borderRadius: 4 }} title="コンベア" />
      )}
    </div>
  );
}

function DesignTab() {
  const [tool, setTool] = useState('layout');
  const inspector = {
    layout: [['保管エリア面積', '2,640 ㎡'], ['通路の本数', '5 本'], ['1通路の間口', '2.4 m'], ['ロケーション数', '4,800']],
    equip:  [['コンベア', '梱包ライン 2本'], ['棚台', '3 台'], ['ピッキング方式', '都度ピック'], ['ハンディ端末', '6 台']],
    frame:  [['天井高', '6.0 m'], ['柱スパン', '10.0 m'], ['床耐荷重', '3.5 t/㎡'], ['出入口', '4 か所']],
    flow:   [['主動線', '入荷→保管→梱包'], ['交差点', '4 か所'], ['一方通行', '2 区間'], ['1件あたり歩行', '89 m']],
    route:  [['ピッキング動線', 'S字巡回'], ['処理時間(中央値)', '2 分'], ['1件あたり歩行', '89 m'], ['すれ違い', '少ない']],
  }[tool];
  return (
    <section id="design" className="fade-in">
      <div className="subtools" role="tablist" aria-label="設計サブツール">
        {SUBTOOLS.map((s) => (
          <button key={s.id} className="subtool" role="tab" aria-pressed={tool === s.id} onClick={() => setTool(s.id)}>
            <Icon name={s.icon} size={15} />{s.name}
          </button>
        ))}
      </div>
      <div className="design-grid">
        <div className="stack-3">
          <WarehouseCanvas tool={tool} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span className="tag"><Icon name="box" size={12} />保管 4,800 ロケ</span>
            <span className="tag"><Icon name="users" size={12} />ピッカー 6 名</span>
            <span className="tag"><Icon name="route" size={12} />1件あたり歩行 89 m</span>
            <ProvChip pct={0} />
          </div>
        </div>
        <div className="inspector">
          <div className="card card--pad">
            <div className="section-h"><span className="section-h__title">{SUBTOOLS.find((s) => s.id === tool).name}の設定</span></div>
            <div className="kv">
              {inspector.map(([k, v]) => (
                <div key={k} className="kv__row"><span className="kv__k">{k}</span><span className="kv__v">{v}</span></div>
              ))}
            </div>
          </div>
          <div className="card card--pad" style={{ background: 'var(--bg-sunken)' }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <Icon name="sparkle" size={15} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>気づき</span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-secondary)' }}>
              ピッキング通路の稼働が45%とやや高めです。保管エリアを1通路ぶん広げると、処理時間をさらに短縮できます。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----- 2D ----------------------------------------------------------------- */
function View2D({ t, duration, steps, activeId }) {
  const phase = (t / duration);
  const agents = [];
  const N = 14;
  for (let i = 0; i < N; i++) {
    const off = (i / N);
    const cyc = (phase * 2.2 + off) % 1;
    let x, y, state;
    if (i % 6 === 0) { // 待機 (アイドル)
      state = 'wait';
      x = 14; y = 30 + (i % 3) * 12;
    } else if (i % 7 === 0) { // 梱包・出荷
      state = 'pack';
      x = 74 + Math.sin(cyc * Math.PI) * 16;
      y = 22 + cyc * 56;
    } else { // ピッカー: 移動→ピック→運搬 を繰り返す
      const lane = i % 5;
      const seg = (cyc * 3) % 1;
      const which = Math.floor(cyc * 3) % 3;
      state = which === 0 ? 'move' : which === 1 ? 'pick' : 'carry';
      const up = Math.floor(cyc * 5) % 2 === 0;
      x = 28 + lane * 8 + Math.sin(cyc * 30) * 0.6;
      y = up ? 12 + seg * 50 : 62 - seg * 50;
    }
    agents.push({ x, y, state, i });
  }
  return (
    <section id="view2d" className="fade-in">
      <div className="stack-3">
        <div className="sim2d">
          <div className="sim2d__grid" />
          {ZONES.map((z) => (
            <div key={z.id} className="wh-zone" style={{ left: z.x + '%', top: z.y + '%', width: z.w + '%', height: z.h + '%',
              background: z.tint, borderColor: z.line, opacity: .85 }}>
              <span className="wh-zone__tag">{z.label}</span>
            </div>
          ))}
          {[0, 1, 2, 3, 4].map((c) => (
            <div key={c} className="rackbar" style={{ left: (26 + c * 8) + '%', top: '12%', width: '4.5%', height: '50%' }} />
          ))}
          {/* heat at bottleneck (ピッキング) */}
          <div className="heat" style={{ left: '38%', top: '78%', width: 120, height: 80, background: 'var(--warn)' }} />
          {agents.map((a) => (
            <div key={a.i} className={'agent agent--' + a.state}
              style={{ left: a.x + '%', top: a.y + '%' }} />
          ))}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
          {SCENARIO.agentLegend.map((g) => (
            <span key={g.id} className="row" style={{ gap: 6, fontSize: 12, color: 'var(--ink-secondary)' }}>
              <span className={'agent agent--' + g.cls} style={{ position: 'static', transform: 'none' }} />{g.name}
            </span>
          ))}
          <span className="grow" />
          <span className="tag" style={{ background: 'var(--warn-tint)', color: 'var(--warn-ink)' }}>
            <Icon name="alert" size={12} />色の濃い領域＝混雑ポイント</span>
        </div>
        <ProcessStrip steps={steps} activeId={activeId} />
      </div>
    </section>
  );
}

/* ----- 3D ----------------------------------------------------------------- */
function View3D({ steps, activeId, mode }) {
  return (
    <section id="view3d" className="fade-in">
      <div className="stack-3">
        <div className="view3d-hero">
          <div className="ph" style={{ position: 'absolute', inset: 16 }}>
            <div className="col" style={{ alignItems: 'center', gap: 10 }}>
              <Icon name="cube" size={34} />
              <span className="ph__txt">3D ウォークスルー（{mode || 'ナチュラル'}・レンダリング領域）</span>
              <span style={{ fontSize: 12, color: 'var(--ink-tertiary)' }}>マウスドラッグで視点移動・スクロールでズーム</span>
            </div>
          </div>
          <div style={{ position: 'absolute', left: 16, top: 16 }} className="row">
            <span className="tag" style={{ background: '#fff' }}><Icon name="cube" size={12} />等角ビュー</span>
            <span className="tag" style={{ background: '#fff' }}>棚 5列 · 6.0m</span>
            <span className="tag" style={{ background: '#fff' }}>表現：{mode || 'ナチュラル'}</span>
          </div>
        </div>
        <ProcessStrip steps={steps} activeId={activeId} />
      </div>
    </section>
  );
}

Object.assign(window, { DesignTab, View2D, View3D, ZONES });
