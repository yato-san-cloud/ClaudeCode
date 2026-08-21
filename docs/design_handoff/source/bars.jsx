/* bars.jsx — VerdictBanner, KpiBar, TransportBar, ProcessStrip */

function VerdictBanner({ v }) {
  const iconName = v.state === 'ok' ? 'checkCircle' : v.state === 'bad' ? 'alertCircle' : 'alert';
  return (
    <div className={'verdict verdict--' + v.state} role="status">
      <div className="verdict__badge"><Icon name={iconName} size={22} stroke={2} /></div>
      <div className="verdict__body">
        <div className="verdict__title">{v.title}</div>
        <div className="verdict__desc">{v.desc}</div>
      </div>
      <div className="verdict__aside">
        <div className="stability">
          <span className="stability__label">安定度</span>
          <span className="stability__bars" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={'stability__bar' + (i < v.stability ? ' on' : '')}
                style={{ height: 6 + i * 3 }} />
            ))}
          </span>
          <span className="stability__val">{v.stabilityLabel}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--ink-tertiary)' }}>{v.stabilityNote}</span>
      </div>
    </div>
  );
}

function Band({ p5, p50, p95 }) {
  const lo = p5, hi = p95;
  const pos = ((p50 - lo) / (hi - lo)) * 100;
  return (
    <div>
      <div className="band">
        <div className="band__fill" style={{ left: '8%', right: '8%' }} />
        <div className="band__mid" style={{ left: `calc(8% + ${pos * 0.84}%)` }} />
      </div>
      <div className="kpi__band-cap tnum">
        <span>{p5.toLocaleString()}</span>
        <span>ぶれ幅 (90%)</span>
        <span>{p95.toLocaleString()}</span>
      </div>
    </div>
  );
}

function Kpi({ k }) {
  return (
    <div className={'kpi' + (k.tone === 'warn' ? ' kpi--warn' : '')}>
      <span className="kpi__label"><Icon name={k.icon} size={14} />{k.label}</span>
      <div className={'kpi__val tnum' + (k.text ? ' kpi__val--text' : '')}>
        {k.text
          ? <span>{k.text}</span>
          : (k.raw
            ? <span>{k.value}</span>
            : <span>{typeof k.value === 'number' ? k.value.toLocaleString() : k.value}</span>)}
        {k.sub && <small style={{ marginLeft: 2 }}>{k.sub}</small>}
        {k.unit && <small>{k.unit}</small>}
      </div>
      {k.band
        ? <Band {...k.band} />
        : (k.note ? <span className="kpi__sub">{k.note}</span> : null)}
    </div>
  );
}

function KpiBar({ kpis }) {
  return (
    <div className="kpibar">
      {kpis.map((k) => <Kpi key={k.id} k={k} />)}
    </div>
  );
}

function TransportBar({ playing, setPlaying, t, setT, speed, setSpeed, duration }) {
  const trackRef = useRef(null);
  const pct = (t / duration) * 100;
  // 元設計に合わせて「経過分」表示（1日の作業を分で）
  const fmt = (s) => {
    const mins = (s / duration) * (8 * 60); // 稼働8時間
        return mins.toFixed(1);
  };
  const seek = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setT(p * duration);
  };
  return (
    <div className="transport">
      <button className="tp-btn" onClick={() => setT(0)} aria-label="先頭へ"><Icon name="skipBack" size={15} /></button>
      <button className="tp-btn tp-play" onClick={() => setPlaying(!playing)} aria-label={playing ? '一時停止' : '再生'}>
        <Icon name={playing ? 'pause' : 'play'} size={16} stroke={2} />
      </button>
      <button className="tp-btn" onClick={() => setT(duration)} aria-label="末尾へ"><Icon name="skipFwd" size={15} /></button>
      <span className="tp-time tnum">{fmt(t)} <span className="muted">分</span></span>
      <div className="tp-track" ref={trackRef} onClick={seek} role="slider"
        aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'ArrowRight') setT(Math.min(duration, t + 10)); if (e.key === 'ArrowLeft') setT(Math.max(0, t - 10)); }}>
        <div className="tp-track__fill" style={{ width: pct + '%' }} />
        <div className="tp-ticks">
          {[25, 50, 75].map((p) => <span key={p} className="tp-tick" style={{ left: p + '%' }} />)}
        </div>
        <div className="tp-track__head" style={{ left: pct + '%' }} />
      </div>
      <span className="muted" style={{ fontSize: 11 }}>速度</span>
      <div className="tp-speed" role="group" aria-label="再生速度">
        {[1, 10, 60].map((s) => (
          <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>
        ))}
      </div>
    </div>
  );
}

function ProcessStrip({ steps, activeId }) {
  return (
    <div className="card card--pad fade-in">
      <div className="section-h">
        <span className="section-h__title">工程ごとの稼働状況</span>
        <span className="section-h__sub">ボトルネックは「ピッキング」（稼働 45%）</span>
      </div>
      <div className="pstrip">
        {steps.map((s) => (
          <div key={s.id} className={'pstep' + (s.bottleneck ? ' is-bottleneck' : '') + (s.id === activeId ? ' is-active' : '')}>
            <div className="pstep__top">
              <span className="pstep__ico"><Icon name={s.icon} size={15} /></span>
              <span className="pstep__name">{s.name}</span>
            </div>
            <div className="pstep__meter"><b style={{ width: s.load + '%' }} /></div>
            <span className="pstep__val tnum">稼働 {s.load}%{s.bottleneck ? ' · ボトルネック' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { VerdictBanner, KpiBar, TransportBar, ProcessStrip, Band, Kpi });
