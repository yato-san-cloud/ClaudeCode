/* X線骨盤分析エディタ
 *
 * サーバ(/xray)が返すランドマーク初期値を SVG 上に表示し、
 * 施術者がドラッグ/矢印キーで補正 → 計測値をリアルタイム再計算する。
 * 幾何計算は modules/xray_analyzer.py と同一式 (座標系: 画像px, y下向き)。
 * 左右表記: AP標準 = 画面左が患者の右。
 */
'use strict';

const XE = (() => {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const COLOR = {
        femoral: '#00c7ff', iliac: '#ff3b3b', spine: '#50c850',
        fhl: '#ffd700', midline: '#c8c8c8', sym: '#ff50ff', calib: '#b14fff',
        ischium: '#ffa24a',
    };

    const S = {
        file: null, image: null, imgW: 0, imgH: 0,
        type: 'pelvis_full',
        landmarks: [],
        calib: { on: false, pts: null, mm: 100, direct: null, source: null },
        dicom: null,
        filters: { contrast: 1, brightness: 1, invert: false },
        ap: true, showLines: true, summary: null,
        vb: { x: 0, y: 0, w: 1, h: 1 },
        sel: null,            // {kind:'lm'|'calib', idx}
        undo: [],
        drag: null,
        lastExport: null,
    };

    const $ = (id) => document.getElementById(id);
    let svg, imgEl, ovLines, ovHandles;

    // ==================================================================
    // 初期化
    // ==================================================================
    function init() {
        svg = $('editor');
        bindUpload();
        bindTypeCards();
        bindToolbar();
        bindPanels();
        bindEditor();
        restoreClinic();
        const d = new Date();
        $('examDate').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // ==================================================================
    // アップロード & 検出
    // ==================================================================
    function bindUpload() {
        const zone = $('uploadZone');
        const input = $('fileInput');
        ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
            e.preventDefault(); zone.classList.add('dragover');
        }));
        ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
            e.preventDefault(); zone.classList.remove('dragover');
        }));
        zone.addEventListener('drop', e => {
            if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
        });
        zone.addEventListener('click', () => input.click());
        input.addEventListener('change', e => {
            if (e.target.files[0]) setFile(e.target.files[0]);
        });
        $('analyzeBtn').addEventListener('click', detect);
    }

    function setFile(file) {
        S.file = file;
        $('uploadLabel').textContent = file.name;
        $('analyzeBtn').disabled = false;
    }

    function bindTypeCards() {
        document.querySelectorAll('.analysis-option').forEach(card => {
            card.addEventListener('click', () => {
                if (card.dataset.type === S.type) return;
                if (S.landmarks.length &&
                    !confirm('分析タイプを変更すると基準点の補正がリセットされます。よろしいですか？')) {
                    return;
                }
                document.querySelectorAll('.analysis-option').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                S.type = card.dataset.type;
                if (S.file && S.image) detect();
            });
        });
    }

    async function detect() {
        if (!S.file) return;
        busy(true);
        try {
            const fd = new FormData();
            fd.append('xray_image', S.file);
            fd.append('analysis_type', S.type);
            const res = await fetch('/xray', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.error) { alert(data.error); return; }

            S.image = data.image;
            S.imgW = data.width;
            S.imgH = data.height;
            S.landmarks = data.landmarks;
            S.type = data.analysis_type;
            S.undo = [];
            S.sel = null;
            S.lastExport = null;
            S.calib.on = false;
            S.calib.pts = null;
            S.calib.direct = null;
            S.calib.source = null;
            S.dicom = data.dicom || null;
            $('calibChk').checked = false;
            $('calibFields').style.display = 'none';
            $('exportResult').style.display = 'none';

            applyDicomScale();
            setupCanvas();
            fitView();
            draw();
            recompute();
            $('workspace').classList.add('active');
            $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            alert('解析中にエラーが発生しました: ' + err.message);
        } finally {
            busy(false);
        }
    }

    function setupCanvas() {
        svg.innerHTML = '';
        $('editorWrap').style.aspectRatio = `${S.imgW} / ${S.imgH}`;

        imgEl = document.createElementNS(SVG_NS, 'image');
        imgEl.setAttribute('href', S.image);
        imgEl.setAttribute('x', 0); imgEl.setAttribute('y', 0);
        imgEl.setAttribute('width', S.imgW); imgEl.setAttribute('height', S.imgH);
        svg.appendChild(imgEl);

        ovLines = document.createElementNS(SVG_NS, 'g');
        ovHandles = document.createElementNS(SVG_NS, 'g');
        svg.appendChild(ovLines);
        svg.appendChild(ovHandles);
        applyFilters();
    }

    // ==================================================================
    // 表示 (ズーム/パン/フィルタ)
    // ==================================================================
    function applyVB() {
        svg.setAttribute('viewBox', `${S.vb.x} ${S.vb.y} ${S.vb.w} ${S.vb.h}`);
    }

    function fitView() {
        S.vb = { x: 0, y: 0, w: S.imgW, h: S.imgH };
        applyVB();
    }

    function zoomAt(px, py, factor) {
        const newW = Math.min(Math.max(S.vb.w * factor, S.imgW / 24), S.imgW * 4);
        const f = newW / S.vb.w;
        S.vb.x = px - (px - S.vb.x) * f;
        S.vb.y = py - (py - S.vb.y) * f;
        S.vb.w = newW;
        S.vb.h *= f;
        applyVB();
        draw();
    }

    function applyFilters() {
        if (!imgEl) return;
        const f = S.filters;
        imgEl.style.filter =
            `contrast(${f.contrast}) brightness(${f.brightness}) invert(${f.invert ? 1 : 0})`;
    }

    function toImg(e) {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        const m = svg.getScreenCTM();
        if (!m) return { x: 0, y: 0 };
        const p = pt.matrixTransform(m.inverse());
        return { x: p.x, y: p.y };
    }

    // ==================================================================
    // エディタ操作 (ドラッグ / キーボード)
    // ==================================================================
    function bindEditor() {
        svg.addEventListener('pointerdown', onDown);
        svg.addEventListener('pointermove', onMove);
        svg.addEventListener('pointerup', onUp);
        svg.addEventListener('pointercancel', onUp);
        svg.addEventListener('wheel', onWheel, { passive: false });
        svg.addEventListener('keydown', onKey);
    }

    function pointOf(kind, idx) {
        return kind === 'calib' ? S.calib.pts[idx] : S.landmarks[idx];
    }

    function onDown(e) {
        if (!S.image) return;
        svg.focus();
        const t = e.target.closest ? e.target.closest('[data-kind]') : null;
        if (t) {
            pushUndo();
            S.sel = { kind: t.dataset.kind, idx: +t.dataset.idx };
            S.drag = { mode: 'point', pointerId: e.pointerId };
            svg.setPointerCapture(e.pointerId);
        } else {
            S.drag = {
                mode: 'pan', pointerId: e.pointerId,
                cx: e.clientX, cy: e.clientY, vb0: { ...S.vb },
                scale: S.vb.w / svg.clientWidth,
            };
            svg.setPointerCapture(e.pointerId);
        }
        e.preventDefault();
        draw();
    }

    function onMove(e) {
        if (!S.drag) return;
        if (S.drag.mode === 'point' && S.sel) {
            const p = toImg(e);
            const pt = pointOf(S.sel.kind, S.sel.idx);
            pt.x = Math.min(Math.max(p.x, 0), S.imgW);
            pt.y = Math.min(Math.max(p.y, 0), S.imgH);
            draw();
            recompute();
        } else if (S.drag.mode === 'pan') {
            S.vb.x = S.drag.vb0.x - (e.clientX - S.drag.cx) * S.drag.scale;
            S.vb.y = S.drag.vb0.y - (e.clientY - S.drag.cy) * S.drag.scale;
            applyVB();
        }
    }

    function onUp(e) {
        if (S.drag && svg.hasPointerCapture(e.pointerId)) {
            svg.releasePointerCapture(e.pointerId);
        }
        S.drag = null;
    }

    function onWheel(e) {
        if (!S.image) return;
        e.preventDefault();
        const p = toImg(e);
        zoomAt(p.x, p.y, e.deltaY < 0 ? 1 / 1.15 : 1.15);
    }

    function onKey(e) {
        if (!S.image) return;
        const step = (e.shiftKey ? 5 : 1);
        const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (moves[e.key] && S.sel) {
            e.preventDefault();
            const pt = pointOf(S.sel.kind, S.sel.idx);
            if (!pt) return;
            pt.x = Math.min(Math.max(pt.x + moves[e.key][0] * step, 0), S.imgW);
            pt.y = Math.min(Math.max(pt.y + moves[e.key][1] * step, 0), S.imgH);
            draw();
            recompute();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            undo();
        } else if (e.key === '+' || e.key === '=') {
            zoomAt(S.vb.x + S.vb.w / 2, S.vb.y + S.vb.h / 2, 1 / 1.2);
        } else if (e.key === '-') {
            zoomAt(S.vb.x + S.vb.w / 2, S.vb.y + S.vb.h / 2, 1.2);
        } else if (e.key === '0') {
            fitView(); draw();
        }
    }

    function pushUndo() {
        S.undo.push(JSON.stringify({ landmarks: S.landmarks, calibPts: S.calib.pts }));
        if (S.undo.length > 60) S.undo.shift();
        $('undoBtn').disabled = false;
    }

    function undo() {
        const snap = S.undo.pop();
        if (!snap) return;
        const st = JSON.parse(snap);
        S.landmarks = st.landmarks;
        if (st.calibPts) S.calib.pts = st.calibPts;
        $('undoBtn').disabled = S.undo.length === 0;
        draw();
        recompute();
    }

    // ==================================================================
    // ツールバー / パネル
    // ==================================================================
    function bindToolbar() {
        $('zInBtn').addEventListener('click', () =>
            zoomAt(S.vb.x + S.vb.w / 2, S.vb.y + S.vb.h / 2, 1 / 1.3));
        $('zOutBtn').addEventListener('click', () =>
            zoomAt(S.vb.x + S.vb.w / 2, S.vb.y + S.vb.h / 2, 1.3));
        $('fitBtn').addEventListener('click', () => { fitView(); draw(); });
        $('undoBtn').addEventListener('click', undo);
        $('linesChk').addEventListener('change', e => { S.showLines = e.target.checked; draw(); });
        $('redetectBtn').addEventListener('click', () => {
            if (confirm('基準点を自動検出し直します。手動補正は失われます。よろしいですか？')) detect();
        });
    }

    function bindPanels() {
        // 画像調整
        const upd = () => {
            S.filters.contrast = parseFloat($('contrastRange').value);
            S.filters.brightness = parseFloat($('brightnessRange').value);
            S.filters.invert = $('invertChk').checked;
            $('contrastVal').textContent = S.filters.contrast.toFixed(2);
            $('brightnessVal').textContent = S.filters.brightness.toFixed(2);
            applyFilters();
        };
        ['contrastRange', 'brightnessRange'].forEach(id => $(id).addEventListener('input', upd));
        $('invertChk').addEventListener('change', upd);
        $('filterResetBtn').addEventListener('click', () => {
            $('contrastRange').value = 1; $('brightnessRange').value = 1;
            $('invertChk').checked = false; upd();
        });

        // 左右表記
        $('apChk').addEventListener('change', e => { S.ap = e.target.checked; draw(); recompute(); });

        // キャリブレーション
        $('calibChk').addEventListener('change', e => toggleCalib(e.target.checked));
        $('calibMM').addEventListener('input', () => {
            S.calib.mm = parseFloat($('calibMM').value) || 0;
            draw(); recompute();
        });

        // 出力
        $('exportBtn').addEventListener('click', exportPng);
        $('reportBtn').addEventListener('click', reportPdf);
        $('attachBtn').addEventListener('click', attachToReferral);
        $('saveSessionBtn').addEventListener('click', saveSession);
        $('loadSessionInput').addEventListener('change', loadSession);

        // 院情報はローカル保存 (患者情報は保存しない)
        ['clinicName', 'clinicPractitioner'].forEach(id =>
            $(id).addEventListener('input', persistClinic));
    }

    function toggleCalib(on) {
        // DICOM等の自動スケール中は手動2点キャリブレーションを無効化
        if (S.calib.direct) {
            $('calibChk').checked = false;
            return;
        }
        S.calib.on = on;
        $('calibFields').style.display = on ? 'block' : 'none';
        if (on && !S.calib.pts) {
            S.calib.pts = [
                { x: S.imgW * 0.15, y: S.imgH * 0.9 },
                { x: S.imgW * 0.35, y: S.imgH * 0.9 },
            ];
        }
        draw();
        recompute();
    }

    // DICOMから取得した mm/px を直接スケールとして適用し、状態を表示する
    function applyDicomScale() {
        const banner = $('dicomBanner');
        const calibRow = $('calibManualRow');
        if (S.dicom && S.dicom.mm_per_px) {
            S.calib.direct = S.dicom.mm_per_px;
            S.calib.source = S.dicom.spacing_source || 'DICOM';
            if (banner) {
                const perMm = (1 / S.dicom.mm_per_px).toFixed(1);
                banner.style.display = 'block';
                banner.innerHTML =
                    `DICOM ${S.dicom.spacing_source} から自動スケール取得: ` +
                    `<b>${S.dicom.mm_per_px} mm/px</b>（${perMm} px/mm）— mm値は自動表示されます`;
            }
            if (calibRow) calibRow.style.display = 'none';  // 手動不要
        } else {
            if (banner) {
                if (S.dicom) {
                    banner.style.display = 'block';
                    banner.innerHTML =
                        'DICOMを読み込みました（PixelSpacing情報なし）。mmが必要な場合は手動スケールを設定してください。';
                } else {
                    banner.style.display = 'none';
                }
            }
            if (calibRow) calibRow.style.display = '';
        }
    }

    function persistClinic() {
        try {
            localStorage.setItem('chiro_clinic', JSON.stringify({
                name: $('clinicName').value, practitioner: $('clinicPractitioner').value,
            }));
        } catch (e) { /* private mode等では保存しない */ }
    }

    function restoreClinic() {
        try {
            const c = JSON.parse(localStorage.getItem('chiro_clinic') || '{}');
            if (c.name) $('clinicName').value = c.name;
            if (c.practitioner) $('clinicPractitioner').value = c.practitioner;
        } catch (e) { /* noop */ }
    }

    // ==================================================================
    // 幾何計算 (サーバと同一式)
    // ==================================================================
    function lm(id) {
        return S.landmarks.find(l => l.id === id);
    }

    function mmPerPx() {
        // DICOM PixelSpacing 等の直接スケールが最優先
        if (S.calib.direct && S.calib.direct > 0) return S.calib.direct;
        if (!S.calib.on || !S.calib.pts || !(S.calib.mm > 0)) return null;
        const [a, b] = S.calib.pts;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        return d > 1 ? S.calib.mm / d : null;
    }

    function pside(viewerLeft) {
        return S.ap ? (viewerLeft ? '右' : '左') : (viewerLeft ? '左' : '右');
    }

    // 臨床的な丸め (analyzer.py と一致): 角度0.5°、長さ0.5mm刻み (half-up)
    function roundAngle(deg) { return Math.round(deg * 2) / 2; }
    function roundMM(v) { return Math.round(v * 2) / 2; }
    // px表示は Python round(x,1):g と一致させる (末尾の.0は落とす)
    function pxs(px) { return +px.toFixed(1); }

    // 有意差しきい値。校正時は表示と同じ丸めで mm≥5、未校正は 3px フロア
    // (analyzer.py の _significant と一致)。
    const THR_PX = 3.0;
    function sig(diffPx) {
        const k = mmPerPx();
        return k ? roundMM(diffPx * k) >= 5.0 : diffPx >= THR_PX;
    }

    function fmtLen(px) {
        const k = mmPerPx();
        return k ? `${roundMM(px * k)} mm（${pxs(px)}px）` : `${pxs(px)} px`;
    }

    function fmtShort(px) {
        const k = mmPerPx();
        return k ? `${roundMM(px * k)}mm` : `${pxs(px)}px`;
    }


    function measures() {
        const rows = [];
        const t = S.type;

        if (t === 'pelvis_full') {
            // Gonstead本式: 真の水平(画像y)を基準に計測 (analyzer.py と一致)
            const Lf = lm('left_femoral'), Rf = lm('right_femoral');
            const Li = lm('left_iliac'), Ri = lm('right_iliac');
            const Lis = lm('left_ischium'), Ris = lm('right_ischium');
            if (!Lf || !Rf || !Li || !Ri || !Lis || !Ris) return rows;
            const midX = (Lf.x + Rf.x) / 2;

            const tilt = Math.atan2(Math.abs(Rf.y - Lf.y), Math.abs(Rf.x - Lf.x)) * 180 / Math.PI;
            const femDiff = Math.abs(Lf.y - Rf.y);
            const iliacDiff = Math.abs(Li.y - Ri.y);
            const innomL = Math.abs(Lis.y - Li.y), innomR = Math.abs(Ris.y - Ri.y);
            const innomDiff = Math.abs(innomL - innomR);
            const sSym = lm('symphysis').x - midX;
            const sS2 = lm('s2').x - midX;
            const shiftRow = (label, s) => rows.push([label,
                sig(Math.abs(s)) ? `${pside(s < 0)}方向へ ${fmtLen(Math.abs(s))}` : '中央']);

            const fhlLow = sig(femDiff) ? pside(Lf.y > Rf.y) : '水平';
            const iliacLow = sig(iliacDiff) ? pside(Li.y > Ri.y) : '同高';
            const piSide = sig(innomDiff) ? pside(innomL > innomR) : null;

            rows.push(['大腿骨頭ライン(FHL)傾斜', `${roundAngle(tilt)}°`]);
            rows.push(['大腿骨頭 高低差', fmtLen(femDiff)]);
            rows.push(['低位側（大腿骨頭＝短下肢）', fhlLow]);
            rows.push(['腸骨稜 高低差', fmtLen(iliacDiff)]);
            rows.push(['低位側（腸骨稜）', iliacLow]);
            rows.push([`寛骨長（${pside(true)}）`, fmtLen(innomL)]);
            rows.push([`寛骨長（${pside(false)}）`, fmtLen(innomR)]);
            rows.push(['寛骨長 左右差', fmtLen(innomDiff)]);
            rows.push(['長い側（PI目安）', piSide || '左右差なし']);
            shiftRow('恥骨結合 側方偏位', sSym);
            shiftRow('S2 側方偏位', sS2);

            const rotWarn = (sig(Math.abs(sSym)) || sig(Math.abs(sS2)));
            if (piSide) {
                const asSide = pside(!(innomL > innomR));
                let s = `寛骨垂直長は患者${piSide}側が長い → 同側PI寛骨の目安（対側${asSide}はAS傾向）。`;
                if (fhlLow === '右' || fhlLow === '左') {
                    s += (fhlLow === piSide)
                        ? ` 大腿骨頭も${fhlLow}低位で短下肢側と一致。`
                        : ` ただし大腿骨頭低位は${fhlLow}側で不一致（要確認）。`;
                }
                if (rotWarn) s += ' ※恥骨結合/S2に偏位あり。体位回旋が高さ計測に影響している可能性。';
                S.summary = s;
            } else {
                S.summary = '寛骨垂直長の左右差は僅少（有意差なし）。'
                    + (rotWarn ? ' ※恥骨結合/S2に偏位あり。体位回旋が高さ計測に影響している可能性。' : '');
            }
        } else if (t === 'pelvis_tilt') {
            const L = lm('left_iliac'), R = lm('right_iliac');
            if (!L || !R) return rows;
            const angle = Math.atan2(Math.abs(R.y - L.y), Math.abs(R.x - L.x)) * 180 / Math.PI;
            const diff = Math.abs(R.y - L.y);
            rows.push(['骨盤傾斜角', `${roundAngle(angle)}°`]);
            rows.push(['腸骨稜 高低差', fmtLen(diff)]);
            rows.push(['高い側', sig(diff) ? pside(L.y < R.y) : '同高']);
            S.summary = null;
        } else if (t === 'leg_length') {
            const L = lm('left_femoral'), R = lm('right_femoral');
            if (!L || !R) return rows;
            const diff = Math.abs(L.y - R.y);
            rows.push(['大腿骨頭 高低差', fmtLen(diff)]);
            rows.push(['低い側', sig(diff) ? pside(L.y > R.y) : '水平']);
            S.summary = null;
        } else if (t === 'spine_alignment') {
            const pts = [...S.landmarks].sort((a, b) => a.y - b.y);
            if (pts.length < 3) return rows;
            const top = pts[0], bot = pts[pts.length - 1];
            const axisX = (top.x + bot.x) / 2;
            let maxDev = 0;
            pts.forEach(p => { if (Math.abs(p.x - axisX) > Math.abs(maxDev)) maxDev = p.x - axisX; });
            const mid = pts[Math.floor(pts.length / 2)];
            const halfH = Math.max((bot.y - top.y) / 2, 1);
            const cobb = Math.atan2(Math.abs(mid.x - axisX), halfH) * 180 / Math.PI;
            rows.push(['最大側方偏位', fmtLen(Math.abs(maxDev))]);
            rows.push(['偏位方向', pside(maxDev < 0)]);
            rows.push(['Cobb角（概算）', `${roundAngle(cobb)}°`]);
            S.summary = null;
        }

        const scaleLabel = mmPerPx()
            ? (S.calib.direct ? `DICOM自動（${S.calib.source}）` : 'mm換算（フィルム面）')
            : '未設定（px表示）';
        rows.push(['スケール', scaleLabel]);
        rows.push(['左右表記', S.ap ? 'AP標準（画面左＝患者右）' : '反転（画面左＝患者左）']);
        return rows;
    }

    function recompute() {
        const rows = measures();
        const summaryHtml = S.summary
            ? `<div class="clinical-summary">${S.summary}</div>` : '';
        $('measurementsList').innerHTML = summaryHtml + rows.map(([k, v]) =>
            `<div class="measurement"><span class="label">${k}</span><span class="value">${v}</span></div>`
        ).join('');
        renderLmList();
    }

    function renderLmList() {
        const el = $('lmList');
        if (!el) return;
        const items = S.landmarks.map((p, i) => {
            const selected = S.sel && S.sel.kind === 'lm' && S.sel.idx === i;
            return `<div class="lm-item ${selected ? 'selected' : ''}" data-idx="${i}">
                <span class="lm-dot" style="background:${p.color}"></span>
                <span>${p.label}</span>
                <span class="lm-xy">(${Math.round(p.x)}, ${Math.round(p.y)})</span>
            </div>`;
        }).join('');
        el.innerHTML = items;
        el.querySelectorAll('.lm-item').forEach(item => {
            item.addEventListener('click', () => {
                S.sel = { kind: 'lm', idx: +item.dataset.idx };
                const p = S.landmarks[S.sel.idx];
                // 選択点が見えるようにパン
                if (p.x < S.vb.x || p.x > S.vb.x + S.vb.w || p.y < S.vb.y || p.y > S.vb.y + S.vb.h) {
                    S.vb.x = p.x - S.vb.w / 2;
                    S.vb.y = p.y - S.vb.h / 2;
                    applyVB();
                }
                draw();
                renderLmList();
                svg.focus();
            });
        });
    }

    // ==================================================================
    // オーバーレイ描画
    // ==================================================================
    function el(tag, attrs) {
        const e = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        return e;
    }

    function draw() {
        if (!S.image || !ovLines) return;
        ovLines.innerHTML = '';
        ovHandles.innerHTML = '';
        const sw = S.vb.w / 450;
        const fs = S.vb.w / 42;

        drawRL(fs);
        if (S.showLines) drawOverlay(sw, fs);
        drawHandles(sw);
    }

    function seg(x1, y1, x2, y2, color, sw, dash) {
        const l = el('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': sw });
        if (dash) l.setAttribute('stroke-dasharray', `${sw * 5} ${sw * 5}`);
        ovLines.appendChild(l);
    }

    function lineAlong(ox, oy, dx, dy, color, sw, dash) {
        seg(ox - dx * 9000, oy - dy * 9000, ox + dx * 9000, oy + dy * 9000, color, sw, dash);
    }

    function txt(x, y, str, color, fs) {
        const t = el('text', {
            x, y, fill: color, 'font-size': fs,
            stroke: '#000', 'stroke-width': fs / 7, 'paint-order': 'stroke',
            'font-family': 'sans-serif', 'font-weight': '600',
        });
        t.textContent = str;
        ovLines.appendChild(t);
    }

    function circle(cx, cy, r, color, sw) {
        ovLines.appendChild(el('circle', {
            cx, cy, r, fill: 'none', stroke: color, 'stroke-width': sw,
        }));
    }

    function drawRL(fs) {
        const leftMark = S.ap ? 'R' : 'L';
        const rightMark = S.ap ? 'L' : 'R';
        txt(S.vb.x + S.vb.w * 0.03, S.vb.y + S.vb.h * 0.09, leftMark, '#ffffff', fs * 1.8);
        txt(S.vb.x + S.vb.w * 0.93, S.vb.y + S.vb.h * 0.09, rightMark, '#ffffff', fs * 1.8);
    }

    function drawOverlay(sw, fs) {
        const t = S.type;

        if (t === 'pelvis_full') {
            const Lf = lm('left_femoral'), Rf = lm('right_femoral');
            const Li = lm('left_iliac'), Ri = lm('right_iliac');
            const Lis = lm('left_ischium'), Ris = lm('right_ischium');
            if (!Lf || !Rf || !Li || !Ri || !Lis || !Ris) return;
            const midX = (Lf.x + Rf.x) / 2;
            const W = S.imgW;

            // 大腿骨頭線 + 各頭の水平参照線 (真の水平)
            seg(Lf.x, Lf.y, Rf.x, Rf.y, COLOR.fhl, sw);
            seg(-9000, Lf.y, W + 9000, Lf.y, COLOR.fhl, sw * 0.8, true);
            seg(-9000, Rf.y, W + 9000, Rf.y, COLOR.fhl, sw * 0.8, true);
            // 垂直中心線
            seg(midX, -9000, midX, S.imgH + 9000, COLOR.midline, sw * 0.8, true);

            const headR = W * 0.045;
            [Lf, Rf].forEach(p => circle(p.x, p.y, headR, COLOR.femoral, sw));

            // 腸骨稜: 水平参照線
            [Li, Ri].forEach(P => seg(-9000, P.y, W + 9000, P.y, COLOR.iliac, sw * 0.8, true));

            // 寛骨長: 腸骨稜→坐骨結節の縦線
            seg(Li.x, Li.y, Lis.x, Lis.y, COLOR.ischium, sw);
            seg(Ri.x, Ri.y, Ris.x, Ris.y, COLOR.ischium, sw);

            // 恥骨結合 / S2: 中心線への水平距離
            ['symphysis', 's2'].forEach(id => {
                const P = lm(id);
                seg(P.x, P.y, midX, P.y, COLOR.sym, sw * 0.8, true);
            });

            // 数値ラベル
            const tilt = Math.atan2(Math.abs(Rf.y - Lf.y), Math.abs(Rf.x - Lf.x)) * 180 / Math.PI;
            txt(midX + W * 0.03, (Lf.y + Rf.y) / 2 - fs * 0.5, `FHL ${roundAngle(tilt)}°`, COLOR.fhl, fs);
            txt(Li.x + fs, Li.y - fs * 0.6, `Δ${fmtShort(Math.abs(Li.y - Ri.y))}`, COLOR.iliac, fs);
            const innomDiff = Math.abs(Math.abs(Lis.y - Li.y) - Math.abs(Ris.y - Ri.y));
            txt(Lis.x - W * 0.16, Lis.y, `Innom ${fmtShort(innomDiff)}`, COLOR.ischium, fs);
            const sym = lm('symphysis'), s2p = lm('s2');
            txt(sym.x + fs, sym.y + fs * 1.4, `Sym ${fmtShort(Math.abs(sym.x - midX))}`, COLOR.sym, fs);
            txt(s2p.x + fs, s2p.y - fs * 0.5, `S2 ${fmtShort(Math.abs(s2p.x - midX))}`, COLOR.sym, fs);
        } else if (t === 'pelvis_tilt') {
            const L = lm('left_iliac'), R = lm('right_iliac');
            if (!L || !R) return;
            seg(L.x, L.y, R.x, R.y, '#00c800', sw);
            seg(S.vb.x - 9000, L.y, S.vb.x + 9000, L.y, COLOR.fhl, sw * 0.8, true);
            lineAlong(S.imgW / 2, 0, 0, 1, COLOR.midline, sw * 0.8, true);
        } else if (t === 'leg_length') {
            const L = lm('left_femoral'), R = lm('right_femoral');
            if (!L || !R) return;
            const headR = S.imgW * 0.045;
            [L, R].forEach(p => {
                circle(p.x, p.y, headR, COLOR.femoral, sw);
                seg(p.x, p.y, p.x, S.imgH, '#ffc800', sw * 0.8, true);
            });
            seg(L.x, L.y, R.x, R.y, '#ffa500', sw);
        } else if (t === 'spine_alignment') {
            const pts = [...S.landmarks].sort((a, b) => a.y - b.y);
            for (let i = 1; i < pts.length; i++) {
                seg(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, COLOR.spine, sw);
            }
            if (pts.length >= 2) {
                seg(pts[0].x, pts[0].y, pts[pts.length - 1].x, pts[pts.length - 1].y,
                    COLOR.midline, sw * 0.8, true);
            }
        }

        // キャリブレーション線
        if (S.calib.on && S.calib.pts) {
            const [a, b] = S.calib.pts;
            seg(a.x, a.y, b.x, b.y, COLOR.calib, sw);
            txt((a.x + b.x) / 2, (a.y + b.y) / 2 - fs * 0.6,
                `${S.calib.mm}mm`, COLOR.calib, fs);
        }
    }

    function drawHandles(sw) {
        const r = Math.max(S.vb.w / 80, 3);

        const put = (p, i, kind, color) => {
            const selected = S.sel && S.sel.kind === kind && S.sel.idx === i;
            const g = el('g', {});
            // 大きめの透明ヒット領域 (タッチ対応)
            g.appendChild(el('circle', {
                cx: p.x, cy: p.y, r: r * 2.4, fill: 'transparent',
                'data-kind': kind, 'data-idx': i, class: 'handle-hit',
            }));
            g.appendChild(el('circle', {
                cx: p.x, cy: p.y, r, fill: color,
                stroke: selected ? '#ffee00' : '#ffffff', 'stroke-width': r * (selected ? 0.5 : 0.3),
                'data-kind': kind, 'data-idx': i, class: 'handle',
            }));
            // 十字線 (精密配置用)
            g.appendChild(el('line', {
                x1: p.x - r * 1.7, y1: p.y, x2: p.x + r * 1.7, y2: p.y,
                stroke: '#ffffff', 'stroke-width': r * 0.14, 'pointer-events': 'none',
            }));
            g.appendChild(el('line', {
                x1: p.x, y1: p.y - r * 1.7, x2: p.x, y2: p.y + r * 1.7,
                stroke: '#ffffff', 'stroke-width': r * 0.14, 'pointer-events': 'none',
            }));
            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = kind === 'calib' ? 'スケール基準点' : (S.landmarks[i].label || '');
            g.appendChild(title);
            ovHandles.appendChild(g);
        };

        S.landmarks.forEach((p, i) => put(p, i, 'lm', p.color || '#ffcc00'));
        if (S.calib.on && S.calib.pts) {
            S.calib.pts.forEach((p, i) => put(p, i, 'calib', COLOR.calib));
        }
    }

    // ==================================================================
    // 出力
    // ==================================================================
    function payload() {
        return {
            image: S.image,
            analysis_type: S.type,
            landmarks: S.landmarks,
            mm_per_px: mmPerPx(),
            filters: S.filters,
            ap_standard: S.ap,
        };
    }

    function stamp() {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }

    async function exportPng() {
        if (!S.image) return null;
        busy(true);
        try {
            const res = await fetch('/xray/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload()),
            });
            const data = await res.json();
            if (data.error) { alert(data.error); return null; }
            S.lastExport = data.image;
            const name = $('patientName').value || '注釈';
            const dl = $('downloadLink');
            dl.href = data.image;
            dl.download = `X線分析_${name}_${stamp()}.png`;
            $('exportThumb').src = data.image;
            $('exportResult').style.display = 'block';
            return data.image;
        } catch (err) {
            alert('画像の生成に失敗しました: ' + err.message);
            return null;
        } finally {
            busy(false);
        }
    }

    async function reportPdf() {
        if (!S.image) return;
        busy(true);
        try {
            const body = {
                ...payload(),
                patient: {
                    name: $('patientName').value,
                    exam_date: $('examDate').value,
                    memo: $('patientMemo').value,
                },
                clinic: {
                    name: $('clinicName').value,
                    practitioner: $('clinicPractitioner').value,
                },
            };
            const res = await fetch('/xray/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                let msg = 'レポート生成に失敗しました';
                try { msg = (await res.json()).error || msg; } catch (e) { /* noop */ }
                alert(msg);
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `X線分析レポート_${$('patientName').value || '無記名'}_${stamp()}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (err) {
            alert('レポート生成に失敗しました: ' + err.message);
        } finally {
            busy(false);
        }
    }

    async function attachToReferral() {
        const img = S.lastExport || await exportPng();
        if (!img) return;
        try {
            sessionStorage.setItem('xray_attachment', img);
        } catch (e) {
            alert('画像が大きすぎるため添付できませんでした。PNGを保存して紹介状ページで添付してください。');
            return;
        }
        if (confirm('紹介状に添付しました。紹介状作成ページへ移動しますか？')) {
            location.href = '/referral';
        }
    }

    function saveSession() {
        if (!S.image) return;
        const data = {
            version: 1,
            saved_at: new Date().toISOString(),
            analysis_type: S.type,
            image: S.image,
            width: S.imgW, height: S.imgH,
            landmarks: S.landmarks,
            calib: S.calib,
            dicom: S.dicom,
            filters: S.filters,
            ap_standard: S.ap,
            patient: {
                name: $('patientName').value,
                exam_date: $('examDate').value,
                memo: $('patientMemo').value,
            },
        };
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `分析セッション_${$('patientName').value || '無記名'}_${stamp()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    function loadSession(e) {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const d = JSON.parse(ev.target.result);
                if (!d.image || !d.landmarks) throw new Error('形式が不正です');
                S.image = d.image;
                S.imgW = d.width; S.imgH = d.height;
                S.type = d.analysis_type || 'pelvis_full';
                S.landmarks = d.landmarks;
                S.calib = d.calib || { on: false, pts: null, mm: 100, direct: null, source: null };
                S.dicom = d.dicom || null;
                S.filters = d.filters || { contrast: 1, brightness: 1, invert: false };
                S.ap = d.ap_standard !== false;
                S.undo = [];
                S.sel = null;
                S.lastExport = null;
                S.file = null;

                document.querySelectorAll('.analysis-option').forEach(c =>
                    c.classList.toggle('selected', c.dataset.type === S.type));
                $('calibChk').checked = S.calib.on;
                $('calibFields').style.display = S.calib.on ? 'block' : 'none';
                $('calibMM').value = S.calib.mm;
                $('contrastRange').value = S.filters.contrast;
                $('brightnessRange').value = S.filters.brightness;
                $('invertChk').checked = !!S.filters.invert;
                $('apChk').checked = S.ap;
                if (d.patient) {
                    $('patientName').value = d.patient.name || '';
                    if (d.patient.exam_date) $('examDate').value = d.patient.exam_date;
                    $('patientMemo').value = d.patient.memo || '';
                }
                $('uploadLabel').textContent = `セッション読込: ${file.name}`;

                applyDicomScale();
                setupCanvas();
                fitView();
                draw();
                recompute();
                $('workspace').classList.add('active');
            } catch (err) {
                alert('セッションの読み込みに失敗しました: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    function busy(on) {
        $('loading').classList.toggle('active', on);
    }

    return { init };
})();

window.addEventListener('DOMContentLoaded', XE.init);
