/* tabs2.jsx — Proposal (提案PNG), Compare (#compare), Export (#export), states */

/* ----- PROPOSAL ----------------------------------------------------------- */
function Proposal() {
  const v = SCENARIO.verdict;
  return (
    <section className="fade-in">
      <div className="proposal">
        <div className="proposal__paper">
          <div className="row">
            <span className="brand__mark" style={{ width: 26, height: 26 }}>wh</span>
            <div className="col">
              <span style={{ fontSize: 16, fontWeight: 700 }}>倉庫オペレーション提案</span>
              <span style={{ fontSize: 12, color: 'var(--ink-tertiary)' }}>{SCENARIO.project} ・ ピッキング増強の検討</span>
            </div>
            <span className="grow" />
            <span className="tag" style={{ background: 'var(--ok-tint)', color: 'var(--ok-ink)' }}>
              <Icon name="check" size={12} />対応可能</span>
          </div>
          <div className="verdict verdict--ok" style={{ margin: 0 }}>
            <div className="verdict__badge"><Icon name="checkCircle" size={20} stroke={2} /></div>
            <div className="verdict__body">
              <div className="verdict__title" style={{ fontSize: 17 }}>{v.title}</div>
              <div className="verdict__desc">{v.desc}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {SCENARIO.kpis.filter((k) => k.band || k.value).slice(0, 4).map((k) => (
              <div key={k.id} className="card card--pad" style={{ padding: 14 }}>
                <span className="kpi__label"><Icon name={k.icon} size={13} />{k.label}</span>
                <div className="kpi__val tnum" style={{ fontSize: 24, marginTop: 4 }}>
                  {typeof k.value === 'number' ? k.value.toLocaleString() : k.value}<small>{k.unit}</small>
                </div>
              </div>
            ))}
          </div>
          <span className="grow" />
          <div className="row" style={{ borderTop: '1px solid var(--line-hair)', paddingTop: 12 }}>
            <ProvChip pct={0} />
            <span className="grow" />
            <span style={{ fontSize: 11, color: 'var(--ink-tertiary)' }}>whsim で作成 · run_0001</span>
          </div>
        </div>
        <div className="inspector">
          <div className="card card--pad">
            <div className="section-h"><span className="section-h__title">書き出し</span></div>
            <div className="stack-3">
              <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }}>
                <Icon name="image" size={15} />PNG（商談用 1枚）</button>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>
                <Icon name="copy" size={15} />画像をコピー</button>
              <div className="row" style={{ gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--ink-secondary)' }}>サイズ</span>
                <div className="seg" style={{ flex: 1 }}>
                  <button className="seg__opt" aria-pressed={false}>16:9</button>
                  <button className="seg__opt" aria-pressed={true}>A4</button>
                  <button className="seg__opt" aria-pressed={false}>正方形</button>
                </div>
              </div>
            </div>
          </div>
          <div className="card card--pad" style={{ background: 'var(--bg-sunken)' }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <Icon name="sparkle" size={15} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>そのまま渡せます</span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-secondary)' }}>
              専門用語を省き、結論と数字だけにまとめた1枚です。お客様にそのまま共有できます。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----- COMPARE ------------------------------------------------------------ */
function DeltaPill({ delta, good, qualitative }) {
  if (qualitative) return <span className="delta-pill delta-pill--good"><Icon name="trend" size={12} />改善</span>;
  if (delta === 0) return <span className="delta-pill delta-pill--flat">±0</span>;
  const cls = good ? 'delta-pill--good' : 'delta-pill--bad';
  return (
    <span className={'delta-pill ' + cls}>
      <Icon name="trend" size={12} style={{ transform: delta < 0 ? 'scaleY(-1)' : 'none' }} />
      {delta > 0 ? '+' : ''}{delta}%
    </span>
  );
}

function Compare() {
  return (
    <section id="compare" className="fade-in">
      <div className="section-h">
        <span className="section-h__title">現行と提案の比較</span>
        <span className="section-h__sub">緑＝改善する項目</span>
        <span className="section-h__act"><ProvChip pct={0} /></span>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="ctable">
          <thead>
            <tr>
              <th>項目</th>
              <th className="num">現行</th>
              <th className="num">提案後</th>
              <th className="num">変化</th>
            </tr>
          </thead>
          <tbody>
            {SCENARIO.compare.map((r) => (
              <tr key={r.metric}>
                <td className="ctable__metric">{r.metric}<small>{r.note}</small></td>
                <td className="num ctable__cur">{r.cur}{r.unit && <span className="muted" style={{ fontSize: 11 }}> {r.unit}</span>}</td>
                <td className="num ctable__new">{r.neu}{r.unit && <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> {r.unit}</span>}</td>
                <td className="num"><DeltaPill delta={r.delta} good={r.good} qualitative={r.qualitative} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        ※ 数字はテンプレ仮値をもとに50回試算した中央値です。顧客データを取り込むと精度が上がります。
      </p>
    </section>
  );
}

/* ----- EXPORT ------------------------------------------------------------- */
const EXPORTS = [
  { icon: 'image', title: '提案PNG（1枚）', desc: '結論と数字だけの商談用ビジュアル' },
  { icon: 'file',  title: 'PDFレポート',     desc: '前提・比較・工程まで含む詳細版' },
  { icon: 'film',  title: '2D動画（MP4）',   desc: '1日の動きを15秒に圧縮した動画' },
  { icon: 'database', title: 'データ（CSV）', desc: '試算結果の生データを書き出し' },
  { icon: 'link',  title: '共有リンク',       desc: '閲覧専用URL・パスワード付き' },
  { icon: 'cube',  title: '3Dシーン',         desc: '等角ビューを画像連番で出力' },
];
function Export() {
  return (
    <section id="export" className="fade-in">
      <div className="section-h">
        <span className="section-h__title">書き出し</span>
        <span className="section-h__sub">用途に合わせて選べます</span>
      </div>
      <div className="export-grid">
        {EXPORTS.map((e) => (
          <div key={e.title} className="card export-card" role="button" tabIndex={0}>
            <div className="export-card__ico"><Icon name={e.icon} size={18} /></div>
            <div className="col" style={{ gap: 3 }}>
              <span className="export-card__title">{e.title}</span>
              <span className="export-card__desc">{e.desc}</span>
            </div>
            <div className="row" style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600, gap: 5 }}>
              <Icon name="download" size={13} />書き出す
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----- STATES ------------------------------------------------------------- */
function EmptyState({ onRun }) {
  const steps = [
    ['顧客データを取り込む（任意）', 'ZIP / CAD図面をドロップ。足りない分は仮値で補完'],
    ['キー項目を5つ入れる', 'ピッカー人数・出荷オーダーなど'],
    ['シミュレーション実行', '約8秒・50回試算で結論と数字が出ます'],
  ];
  return (
    <div className="empty">
      <div className="empty__inner">
        <div className="empty__art"><Icon name="box" size={40} /></div>
        <div>
          <div className="empty__title">倉庫モデルを組み立てましょう</div>
          <div className="empty__desc">入力は簡単、計算は本格的。データがなくても仮値ですぐに試せます。</div>
        </div>
        <div className="empty__steps">
          {steps.map(([t, s], i) => (
            <div key={i} className="empty__step">
              <span className="empty__step-n">{i + 1}</span>
              <span className="empty__step-t">{t}<small>{s}</small></span>
            </div>
          ))}
        </div>
        <button className="btn btn--primary" onClick={onRun} style={{ marginTop: 4 }}>
          <Icon name="play" size={15} />サンプルで試す
        </button>
      </div>
    </div>
  );
}

const RUN_LOG = ['仮値テンプレを読み込み', '工程モデルを構築', '50回の試算を実行', 'ボトルネックを判定', '結果をまとめる'];
function RunningState({ progress }) {
  const stepIdx = Math.min(RUN_LOG.length - 1, Math.floor(progress / 20));
  return (
    <div className="running">
      <div className="running__inner">
        <div className="spinner" style={{ width: 26, height: 26, borderWidth: 3 }} />
        <div>
          <div className="running__title">シミュレーション中…</div>
          <div className="running__sub">1日ぶんの倉庫の動きを再現しています</div>
        </div>
        <div className="run-progress"><b style={{ width: progress + '%' }} /></div>
        <div className="run-log">
          {RUN_LOG.map((l, i) => (
            <div key={i} className={'run-log__row ' + (i < stepIdx ? 'done' : i === stepIdx ? 'active' : '')}>
              {i < stepIdx ? <Icon name="check" size={14} style={{ color: 'var(--ok)' }} />
                : i === stepIdx ? <span className="spinner" /> : <span style={{ width: 14, height: 14, display: 'inline-block', borderRadius: '50%', border: '2px solid var(--line-strong)' }} />}
              {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }) {
  return (
    <div className="panel"><div className="panel__inner">
      <div className="errbox">
        <span className="errbox__ico"><Icon name="alertCircle" size={22} /></span>
        <div className="grow">
          <div className="errbox__title">取り込んだデータに不足があります</div>
          <div className="errbox__desc">出荷データの「出荷日」列が読み取れませんでした。他の項目は仮値で補完して進められます。</div>
          <div className="errbox__row">
            <Icon name="file" size={14} style={{ color: 'var(--ink-tertiary)' }} />
            <span className="mono" style={{ fontSize: 12 }}>顧客データ_2025.zip</span>
            <span className="grow" />
            <span className="tag" style={{ background: 'var(--bad-tint)', color: 'var(--bad-ink)' }}>列「出荷日」が空</span>
          </div>
          <div className="errbox__actions">
            <button className="btn btn--primary btn--sm" onClick={onRetry}><Icon name="refresh" size={14} />列を指定して再取り込み</button>
            <button className="btn btn--sm">仮値で進める</button>
          </div>
        </div>
      </div>
    </div></div>
  );
}

Object.assign(window, { Proposal, Compare, Export, EmptyState, RunningState, ErrorState, DeltaPill });
