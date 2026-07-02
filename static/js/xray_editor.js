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
    };

    const S = {
        file: null, image: null, imgW: 0, imgH: 0,
        type: 'pelvis_full',
        landmarks: [],
        calib: { on: false, pts: null, mm: 100 },
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
            $('calibChk').checked = false;
            $('calibFields').style.display = 'none';
            $('exportResult').style.display = 'none';

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
        if (!S.calib.on || !S.calib.pts || !(S.calib.mm > 0)) return null;
        const [a, b] = S.calib.pts;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        return d > 1 ? S.calib.mm / d : null;
    }

    function pside(viewerLeft) {
        return S.ap ? (viewerLeft ? '右' : '左') : (viewerLeft ? '左' : '右');
    }

    // 臨床的な丸め (analyzer.py と一致): 角度0.5°、長さ0.5mm刻み
    function roundAngle(deg) { return Math.round(deg * 2) / 2; }
    function roundMM(v) { return Math.round(v * 2) / 2; }

    // 有意差しきい値 (px)。これ未満は「差なし」扱い
    const THR_PX = 3.0;

    function fmtLen(px) {
        const k = mmPerPx();
        return k ? `${roundMM(px * k)} mm（${px.toFixed(0)}px）` : `${px.toFixed(0)} px`;
    }

    function fmtShort(px) {
        const k = mmPerPx();
        return k ? `${roundMM(px * k)}mm` : `${px.toFixed(0)}px`;
    }

    function fhlFrame() {
        const L = lm('left_femoral'), R = lm('right_femoral');
        if (!L || !R) return null;
        let ux = R.x - L.x, uy = R.y - L.y;
        const n0 = Math.hypot(ux, uy) || 1;
        ux /= n0; uy /= n0;
        let nx = uy, ny = -ux;
        if (ny > 0) { nx = -nx; ny = -ny; }
        return { L, R, ux, uy, nx, ny, mx: (L.x + R.x) / 2, my: (L.y + R.y) / 2 };
    }

    function measures() {
        const rows = [];
        const t = S.type;

        if (t === 'pelvis_full') {
            const f = fhlFrame();
            if (!f) return rows;
            const tilt = Math.atan2(f.R.y - f.L.y, f.R.x - f.L.x) * 180 / Math.PI;
            const femDiff = Math.abs(f.R.y - f.L.y);
            const dot = (p, vx, vy) => (p.x - f.mx) * vx + (p.y - f.my) * vy;
            const hL = dot(lm('left_iliac'), f.nx, f.ny);
            const hR = dot(lm('right_iliac'), f.nx, f.ny);
            const iliacDiff = Math.abs(hL - hR);
            const sSym = dot(lm('symphysis'), f.ux, f.uy);
            const sS2 = dot(lm('s2'), f.ux, f.uy);
            const shiftRow = (label, s) => rows.push([label,
                Math.abs(s) > THR_PX ? `${pside(s < 0)}方向へ ${fmtLen(Math.abs(s))}` : '中央']);

            const iliacHigh = iliacDiff > THR_PX ? pside(hL > hR) : '同高';
            rows.push(['大腿骨頭ライン(FHL)傾斜', `${roundAngle(Math.abs(tilt))}°`]);
            rows.push(['低い側（大腿骨頭）', femDiff > THR_PX ? pside(f.L.y > f.R.y) : '水平']);
            rows.push(['大腿骨頭 高低差', fmtLen(femDiff)]);
            rows.push([`腸骨稜高（${pside(true)}）`, fmtLen(Math.abs(hL))]);
            rows.push([`腸骨稜高（${pside(false)}）`, fmtLen(Math.abs(hR))]);
            rows.push(['腸骨稜 高低差', fmtLen(iliacDiff)]);
            rows.push(['高い側（腸骨稜）', iliacHigh]);
            shiftRow('恥骨結合 側方偏位', sSym);
            shiftRow('S2 側方偏位', sS2);
            S.summary = (iliacHigh === '右' || iliacHigh === '左')
                ? `患者${iliacHigh}側の腸骨稜高位（FHL基準）。同側寛骨のPI変位を示唆。`
                : '腸骨稜高は左右ほぼ同等。明らかな高低差なし。';
        } else if (t === 'pelvis_tilt') {
            const L = lm('left_iliac'), R = lm('right_iliac');
            if (!L || !R) return rows;
            const angle = Math.atan2(R.y - L.y, R.x - L.x) * 180 / Math.PI;
            const diff = Math.abs(R.y - L.y);
            rows.push(['骨盤傾斜角', `${roundAngle(Math.abs(angle))}°`]);
            rows.push(['腸骨稜 高低差', fmtLen(diff)]);
            rows.push(['高い側', diff > THR_PX ? pside(L.y < R.y) : '同高']);
            S.summary = null;
        } else if (t === 'leg_length') {
            const L = lm('left_femoral'), R = lm('right_femoral');
            if (!L || !R) return rows;
            const diff = Math.abs(L.y - R.y);
            rows.push(['大腿骨頭 高低差', fmtLen(diff)]);
            rows.push(['低い側', diff > THR_PX ? pside(L.y > R.y) : '水平']);
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

        rows.push(['スケール', mmPerPx() ? 'mm換算（フィルム面）' : '未設定（px表示）']);
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
            const f = fhlFrame();
            if (!f) return;
            lineAlong(f.mx, f.my, f.ux, f.uy, COLOR.fhl, sw);
            lineAlong(f.mx, f.my, f.nx, f.ny, COLOR.midline, sw * 0.8, true);

            const headR = S.imgW * 0.045;
            [f.L, f.R].forEach(p => circle(p.x, p.y, headR, COLOR.femoral, sw));

            ['left_iliac', 'right_iliac'].forEach(id => {
                const P = lm(id);
                const hd = (P.x - f.mx) * f.nx + (P.y - f.my) * f.ny;
                const footX = P.x - hd * f.nx, footY = P.y - hd * f.ny;
                seg(P.x, P.y, footX, footY, COLOR.iliac, sw * 0.8, true);
                const segLen = S.imgW * 0.09;
                seg(P.x - f.ux * segLen, P.y - f.uy * segLen,
                    P.x + f.ux * segLen, P.y + f.uy * segLen, COLOR.iliac, sw);
            });

            ['symphysis', 's2'].forEach(id => {
                const P = lm(id);
                const sd = (P.x - f.mx) * f.ux + (P.y - f.my) * f.uy;
                const footX = P.x - sd * f.ux, footY = P.y - sd * f.uy;
                seg(P.x, P.y, footX, footY, COLOR.sym, sw * 0.8, true);
            });

            // 数値ラベル
            const tilt = Math.abs(Math.atan2(f.R.y - f.L.y, f.R.x - f.L.x) * 180 / Math.PI);
            const hL = (lm('left_iliac').x - f.mx) * f.nx + (lm('left_iliac').y - f.my) * f.ny;
            const hR = (lm('right_iliac').x - f.mx) * f.nx + (lm('right_iliac').y - f.my) * f.ny;
            txt(f.mx + f.ux * S.imgW * 0.17, f.my + f.uy * S.imgW * 0.17 - fs * 0.5,
                `FHL ${tilt.toFixed(1)}°`, COLOR.fhl, fs);
            txt(lm('left_iliac').x + fs, lm('left_iliac').y - fs * 0.8,
                `Δ${fmtShort(Math.abs(hL - hR))}`, COLOR.iliac, fs);
            const sym = lm('symphysis'), s2p = lm('s2');
            const sSym = (sym.x - f.mx) * f.ux + (sym.y - f.my) * f.uy;
            const sS2 = (s2p.x - f.mx) * f.ux + (s2p.y - f.my) * f.uy;
            txt(sym.x + fs, sym.y + fs * 1.4, `SP ${fmtShort(Math.abs(sSym))}`, COLOR.sym, fs);
            txt(s2p.x + fs, s2p.y - fs * 0.5, `S2 ${fmtShort(Math.abs(sS2))}`, COLOR.sym, fs);
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
                S.calib = d.calib || { on: false, pts: null, mm: 100 };
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
