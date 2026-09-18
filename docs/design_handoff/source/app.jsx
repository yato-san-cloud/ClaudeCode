/* app.jsx — App shell + state machine (empty / running / results / error) */

const TABS = [
  { id: 'design',  name: '設計',     icon: 'layout' },
  { id: 'view2d',  name: '2D アニメーション', icon: 'film' },
  { id: 'view3d',  name: '3D',       icon: 'cube' },
  { id: 'proposal',name: '提案PNG',  icon: 'image' },
  { id: 'compare', name: '比較',     icon: 'columns' },
  { id: 'export',  name: 'エクスポート', icon: 'download' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#2383E2",
  "accentUsage": "面を活用",
  "kpiDensity": "詳細"
}/*EDITMODE-END*/;

function App() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [status, setStatus] = useState('results'); // empty | running | results | error
  const [tab, setTab] = useState('design');
  const [fields, setFields] = useState(SCENARIO.fields.map((f) => ({ ...f })));
  const [file, setFile] = useState(null); // 初期は取り込みなし（実データ 0%）
  const [render3d, setRender3d] = useState(0);
  const [progress, setProgress] = useState(0);

  // transport
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(() => parseFloat(localStorage.getItem('whsim.t') || '0'));
  const [speed, setSpeed] = useState(1);
  const duration = 840; // 14h * 60 (営業 06:00–20:00)
  const raf = useRef(0);

  useEffect(() => { localStorage.setItem('whsim.t', String(t)); }, [t]);

  // playback loop
  useEffect(() => {
    if (!playing || status !== 'results') return;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      setT((prev) => {
        const nv = prev + dt * speed * 14; // compress day
        if (nv >= duration) { setPlaying(false); return duration; }
        return nv;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, status]);

  // running progress
  useEffect(() => {
    if (status !== 'running') return;
    setProgress(0);
    const iv = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) { clearInterval(iv); setTimeout(() => setStatus('results'), 250); return 100; }
        return p + 4;
      });
    }, 90);
    return () => clearInterval(iv);
  }, [status]);

  const setField = (id, value) => setFields((fs) => fs.map((f) => f.id === id ? { ...f, value } : f));
  const run = useCallback(() => { setStatus('running'); }, []);
  const apply = useCallback(() => { setStatus('running'); }, []);

  // apply tweaks to document root
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--accent', tw.accent);
    r.setAttribute('data-kpi-density', tw.kpiDensity === 'ミニマル' ? '0' : '1');
    // accentUsage: ミニマル → mute tinted surfaces toward neutral
    if (tw.accentUsage === 'ブルーのみ') {
      r.style.setProperty('--accent-tint', '#F1F0ED');
      r.style.setProperty('--accent-tint-2', '#EAE9E4');
    } else {
      r.style.removeProperty('--accent-tint');
      r.style.removeProperty('--accent-tint-2');
    }
  }, [tw]);

  // keyboard: cmd/ctrl+enter to run, space to play
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      if (e.key === ' ' && status === 'results' && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
        e.preventDefault(); setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [run, status]);

  // active process step follows transport
  const activeStep = (() => {
    const order = SCENARIO.process;
    const idx = Math.floor((t / duration) * order.length) % order.length;
    return order[idx].id;
  })();

  const tabLabel = TABS.find((x) => x.id === tab).name;
  const showResults = status === 'results';

  const renderMain = () => {
    if (status === 'empty') return <div className="content"><EmptyState onRun={run} /></div>;
    if (status === 'running') return <div className="content"><RunningState progress={progress} /></div>;
    if (status === 'error') return (
      <div className="content">
        <div className="tabs" role="tablist">{TABS.map(renderTabBtn)}</div>
        <ErrorState onRetry={() => setStatus('results')} />
      </div>
    );
    return (
      <div className="content">
        <div className="tabs" role="tablist" aria-label="ビュー切り替え">
          {TABS.map(renderTabBtn)}
          {tab === 'view3d' && (
            <div className="tab-aside">
              <span className="tab-aside__label">3D表現</span>
              <div className="selectwrap" style={{ width: 130 }}>
                <select className="select select--sm" value={render3d} onChange={(e) => setRender3d(parseInt(e.target.value, 10))} aria-label="3D表現">
                  {SCENARIO.render3d.map((o, i) => <option key={o} value={i}>{o}</option>)}
                </select>
                <span className="selectwrap__chev"><Icon name="chevDown" size={14} /></span>
              </div>
            </div>
          )}
        </div>
        <div className="panel"><div className="panel__inner">
          {tab === 'design'   && <DesignTab />}
          {tab === 'view2d'   && <View2D t={t} duration={duration} steps={SCENARIO.process} activeId={activeStep} />}
          {tab === 'view3d'   && <View3D steps={SCENARIO.process} activeId={activeStep} mode={SCENARIO.render3d[render3d]} />}
          {tab === 'proposal' && <Proposal />}
          {tab === 'compare'  && <Compare />}
          {tab === 'export'   && <Export />}
        </div></div>
      </div>
    );
  };

  function renderTabBtn(x) {
    return (
      <button key={x.id} className="tab" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}>
        <span className="tab__ico"><Icon name={x.icon} size={15} /></span>{x.name}
      </button>
    );
  }

  return (
    <div className="app">
      <Sidebar fields={fields} setField={setField} file={file}
        onImport={() => setFile({ name: '顧客データ_2025.zip', rows: 184523 })} onApply={apply} onRun={run} status={status} canRun={true} />
      <div className="main">
        <Header tabLabel={tabLabel} />
        {showResults && <VerdictBanner v={SCENARIO.verdict} />}
        {renderMain()}
        {showResults
          ? <KpiBar kpis={SCENARIO.kpis} />
          : <div className="kpibar" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--ink-tertiary)', fontSize: 13, gridAutoFlow: 'row' }}>実行すると、ここに結論の数字が並びます</div>}
        {showResults
          ? <TransportBar playing={playing} setPlaying={setPlaying} t={t} setT={setT} speed={speed} setSpeed={setSpeed} duration={duration} />
          : <div className="transport" style={{ color: 'var(--ink-faint)', fontSize: 12, justifyContent: 'center' }}>再生バー</div>}
      </div>
      <DevStateSwitch status={status} setStatus={setStatus} />
      <TweaksPanel title="Tweaks">
        <TweakSection label="アクセント" />
        <TweakColor label="アクセント色" value={tw.accent}
          options={['#2383E2', '#0B6E99', '#37352F', '#6940A5']}
          onChange={(v) => setTweak('accent', v)} />
        <TweakRadio label="使い方" value={tw.accentUsage}
          options={['ブルーのみ', '面を活用']}
          onChange={(v) => setTweak('accentUsage', v)} />
        <TweakSection label="KPIカード" />
        <TweakRadio label="情報量" value={tw.kpiDensity}
          options={['ミニマル', '詳細']}
          onChange={(v) => setTweak('kpiDensity', v)} />
      </TweaksPanel>
    </div>
  );
}

/* small floating state switcher for the demo (空/実行中/エラー/結果) */
function DevStateSwitch({ status, setStatus }) {
  const opts = [['results', '結果'], ['empty', '空'], ['running', '実行中'], ['error', 'エラー']];
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 150, zIndex: 40,
      display: 'flex', gap: 3, background: 'var(--bg-app)', border: '1px solid var(--line-hair)',
      borderRadius: 'var(--r-md)', padding: 4, boxShadow: 'var(--sh-md)' }}>
      <span style={{ fontSize: 10, color: 'var(--ink-tertiary)', alignSelf: 'center', padding: '0 6px', fontWeight: 600 }}>状態</span>
      {opts.map(([id, label]) => (
        <button key={id} onClick={() => setStatus(id)} aria-pressed={status === id}
          style={{ border: 'none', borderRadius: 5, padding: '5px 9px', fontSize: 12, fontWeight: 600,
            background: status === id ? 'var(--ink-primary)' : 'transparent',
            color: status === id ? '#fff' : 'var(--ink-secondary)' }}>{label}</button>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
