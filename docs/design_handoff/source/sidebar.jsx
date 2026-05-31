/* sidebar.jsx — Header + Sidebar (operation flow) */

function Header({ tabLabel }) {
  const p = SCENARIO.provenance;
  return (
    <header className="header">
      <div className="header__crumbs">
        <span className="crumb"><span className="crumb__ico"><Icon name="folder" size={15} /></span>プロジェクト</span>
        <span className="crumb__sep"><Icon name="chevRight" size={13} /></span>
        <span className="crumb crumb--current">{SCENARIO.project}</span>
        <span className="crumb__sep"><Icon name="chevRight" size={13} /></span>
        <span className="crumb">{tabLabel}</span>
      </div>
      <span className="header__spacer" />
      <div className="provbar" title="いまの数字がどれだけ実データに基づくか">
        <span className="provbar__seg"><ProvChip pct={p.realPct} /></span>
        <span className="provbar__sep" />
        <span className="provbar__seg">取り込み済み <b>{p.imported}</b></span>
        <span className="provbar__sep" />
        <span className="provbar__seg provbar__templated">テンプレ仮値 <b>{p.templated.length}項目</b></span>
      </div>
      <button className="btn btn--ghost btn--sm" aria-label="共有"><Icon name="share" size={15} />共有</button>
      <button className="btn btn--primary btn--sm"><Icon name="download" size={15} />提案PNG</button>
    </header>
  );
}

function ProvChip({ pct }) {
  // pct===0 → 仮値（テンプレ）, <75 → 推定込み, >=75 → 実データ
  if (pct === 0) {
    return (
      <span className="prov prov--tmpl" title="テンプレートの仮値です。データを取り込むと精度が上がります">
        <span className="prov__dot" />実データ 0%
      </span>
    );
  }
  const real = pct >= 75;
  return (
    <span className={'prov ' + (real ? 'prov--real' : 'prov--est')} title={real ? '実データに基づく値' : '一部を推定で補完'}>
      <span className="prov__dot" />
      {real ? '実データ' : '推定込み'} {pct}%
    </span>
  );
}

function Stepper({ value, step, min, max, unit, dec, onChange }) {
  const round = (v) => dec ? Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec) : v;
  const set = (v) => onChange(round(Math.max(min, Math.min(max, v))));
  const disp = dec ? value.toFixed(dec) : value;
  return (
    <div className="field__row">
      <div className="stepper">
        <button className="stepper__btn" onClick={() => set(value - step)} aria-label="減らす"><Icon name="minus" size={14} /></button>
        <input className="stepper__val tnum" type="number" value={disp} step={step}
          onChange={(e) => set(parseFloat(e.target.value || '0'))} aria-label="値" />
        <button className="stepper__btn" onClick={() => set(value + step)} aria-label="増やす"><Icon name="plus" size={14} /></button>
      </div>
      {unit && <span className="field__unit">{unit}</span>}
    </div>
  );
}

function Field({ f, value, onChange }) {
  return (
    <div className="field">
      <div className="field__top">
        <span className="field__label">{f.label}</span>
        <span className="field__hint field__hint--tmpl">仮値</span>
      </div>
      {(!f.kind) && (
        <Stepper value={value} step={f.step} min={f.min} max={f.max} unit={f.unit} dec={f.dec} onChange={onChange} />
      )}
      {f.kind === 'select' && (
        <div className="selectwrap">
          <select className="select" value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} aria-label={f.label}>
            {f.opts.map((o, i) => <option key={o} value={i}>{o}</option>)}
          </select>
          <span className="selectwrap__chev"><Icon name="chevDown" size={14} /></span>
        </div>
      )}
      {f.kind === 'slider' && (
        <div className="slider">
          <input type="range" min="0" max="100" value={value}
            style={{ '--pct': value + '%' }}
            onChange={(e) => onChange(parseInt(e.target.value, 10))} aria-label={f.label} />
          <div className="slider__scale">{f.marks.map((m) => <span key={m}>{m}</span>)}</div>
        </div>
      )}
      {f.kind === 'seg' && (
        <div className="seg" role="group" aria-label={f.label}>
          {f.opts.map((o, i) => (
            <button key={o} className="seg__opt" aria-pressed={value === i} onClick={() => onChange(i)}>{o}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function DropZone({ file, onImport }) {
  const [over, setOver] = useState(false);
  if (file) {
    return (
      <div>
        <div className="import-file">
          <span className="import-file__ico"><Icon name="checkCircle" size={17} /></span>
          <span className="import-file__name">{file.name}</span>
          <span className="import-file__rows tnum">{file.rows.toLocaleString()}行</span>
        </div>
        <button className="btn btn--ghost btn--sm cad-btn" style={{ marginTop: 6 }}>
          <Icon name="frame" size={14} />CAD図面(DXF)を取込
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className={'dropzone' + (over ? ' is-over' : '')} role="button" tabIndex={0}
        onClick={onImport} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onImport()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onImport(); }}>
        <div className="dropzone__ico"><Icon name="archive" size={22} /></div>
        <div className="dropzone__title">ZIP をドラッグ&ドロップ</div>
        <div className="dropzone__hint">{SCENARIO.importHint}</div>
      </div>
      <button className="btn btn--ghost btn--sm cad-btn" style={{ marginTop: 6 }} onClick={onImport}>
        <Icon name="frame" size={14} />CAD図面(DXF)を取込
      </button>
    </div>
  );
}

function Sidebar({ fields, setField, file, onImport, onApply, onRun, status, canRun }) {
  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <div className="brand">
          <span className="brand__mark">wh</span>
          <span className="col">
            whsim
            <span className="brand__sub">倉庫シミュレータ</span>
          </span>
        </div>
      </div>

      <div className="sidebar__scroll">
        <div className="side-sect">
          <div className="side-sect__label"><span className="side-sect__step">1</span>プロジェクト</div>
          <div className="proj">
            <span className="proj__ico"><Icon name="box" size={16} /></span>
            <span className="proj__name">{SCENARIO.project}</span>
            <span className="proj__chev"><Icon name="chevDown" size={14} /></span>
          </div>
        </div>

        <div className="side-sect">
          <div className="side-sect__label"><span className="side-sect__step">2</span>顧客データ取り込み<span className="side-sect__opt">任意</span></div>
          <DropZone file={file} onImport={onImport} />
        </div>

        <div className="side-sect">
          <div className="side-sect__label"><span className="side-sect__step">3</span>キー項目<span className="side-sect__num">5</span></div>
          {fields.map((f) => (
            <Field key={f.id} f={f} value={f.value} onChange={(v) => setField(f.id, v)} />
          ))}
          <button className="btn btn--ghost btn--sm apply-btn" onClick={onApply}>
            <Icon name="refresh" size={14} />反映
          </button>
        </div>
      </div>

      <div className="sidebar__foot">
        <button className={'btn-run' + (status === 'running' ? ' is-running' : '')}
          onClick={onRun} disabled={!canRun || status === 'running'}>
          {status === 'running'
            ? (<><span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.4)' }} />計算中…</>)
            : (<><Icon name="play" size={16} stroke={2} />シミュレーション実行<span className="btn-run__kbd">⌘↵</span></>)}
        </button>
        <div className="run-meta">
          {status === 'results'
            ? (<><span className="row" style={{ gap: 5 }}><Icon name="check" size={12} style={{ color: 'var(--ok)' }} />完了</span><span className="mono">{SCENARIO.runId}</span></>)
            : (<><span>所要 約8秒</span><span>50回試算</span></>)}
        </div>
      </div>
    </aside>
  );
}

Object.assign(window, { Header, Sidebar, ProvChip, Field });
