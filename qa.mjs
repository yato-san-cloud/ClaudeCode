// 市販レベル品質保証ハーネス：起動・全シナリオ・描画・入力・音・性能を自動検査
import { chromium } from 'playwright-core';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PAGE = 'file:///home/user/ClaudeCode/index.html';
const SHOT = './qa_';

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 460 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

const results = {};
const fail = [];
function check(name, cond, detail) {
  results[name] = cond ? 'PASS' : 'FAIL';
  if (!cond) fail.push(name + (detail ? ' :: ' + JSON.stringify(detail) : ''));
}

await page.goto(PAGE, { waitUntil: 'load' });
await page.waitForTimeout(600);

// ---- 1) 起動健全性 ----
const boot = await page.evaluate(() => ({
  hasM: typeof M === 'object' && !!M,
  scenarios: typeof MODELS === 'object' ? Object.keys(MODELS) : [],
  ticking: typeof tick === 'number',
  audio: typeof Audio1 !== 'undefined' || typeof SimAudio !== 'undefined' || typeof AudioEngine !== 'undefined',
}));
check('boot.noErrors', errs.length === 0, errs.slice(0,3));
check('boot.worldLoaded', boot.hasM);
results['boot.scenarios'] = boot.scenarios.join(',');

// ---- 2) 全シナリオ：理想経路が走行可能・終端で正着 ----
for (const id of boot.scenarios) {
  const r = await page.evaluate((sid) => {
    try {
      loadScenario(sid);
      if (!M.ideal || !M.ideal.path) return { id: sid, skip: true };
      let wheelBad = 0;
      for (const s of M.ideal.path) {
        const w = wheelPositions(s);
        for (const k in w) if (!drivable(w[k].x, w[k].y)) { wheelBad++; break; }
      }
      return { id: sid, skip: false, frames: M.ideal.path.length, wheelBad };
    } catch (e) { return { id: sid, error: String(e) }; }
  }, id);
  if (r.error) check(`scen.${id}`, false, r.error);
  else if (r.skip) results[`scen.${id}`] = 'SKIP(no ideal path)';
  else check(`scen.${id}.idealDrivable`, r.wheelBad === 0, r);
}

// ---- 3) 描画：各ビューが例外なく回る（全シナリオ×複数ポーズ） ----
const draw = await page.evaluate(() => {
  const out = { frames: 0, errors: [] };
  const ids = Object.keys(MODELS);
  for (const id of ids) {
    try {
      loadScenario(id);
      const path = (M.ideal && M.ideal.path) || [{ x: car.x, y: car.y, th: car.th }];
      for (const f of [0, 0.3, 0.6, 0.9]) {
        const p = path[Math.floor((path.length - 1) * f)];
        car.x = p.x; car.y = p.y; car.th = p.th;
        for (const gr of ['D', 'R']) {
          gear = gr;
          try {
            renderScene(); renderFront(); renderWheel();
            renderMirror('L'); renderMirror('R'); renderRearview(); updateGauges();
            out.frames++;
          } catch (e) { out.errors.push(id + ':' + f + ':' + gr + ':' + e.message); }
        }
      }
    } catch (e) { out.errors.push(id + ':load:' + e.message); }
  }
  return out;
});
check('render.allViews', draw.errors.length === 0, draw.errors.slice(0,3));
results['render.frames'] = draw.frames;

// ---- 4) 入力：ブレーキ保持中のシフト・サイド操作（実車の分担操作） ----
const input = await page.evaluate(() => {
  loadScenario(Object.keys(MODELS)[0]);
  const ctr = el => { const b = el.getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; };
  const pe = (el,t,id,p) => el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,pointerId:id,clientX:p.x,clientY:p.y,isPrimary:id===1}));
  const brake = document.getElementById('brake');
  const shiftR = [...document.querySelectorAll('#shifter button')].find(b=>b.dataset.g==='R');
  const hb = document.getElementById('handbrake');
  const o = {};
  const bp = ctr(brake); pe(brake,'pointerdown',1,bp); o.braking = brakeHeld;
  const sp = ctr(shiftR); pe(shiftR,'pointerdown',2,sp); pe(shiftR,'pointerup',2,sp);
  o.shiftedWhileBraking = (gear === 'R'); o.stillBraking = brakeHeld;
  const before = handbrake, hp = ctr(hb); pe(hb,'pointerdown',3,hp); pe(hb,'pointerup',3,hp);
  o.handbrakeToggled = (handbrake !== before);
  pe(brake,'pointerup',1,bp); o.released = !brakeHeld;
  return o;
});
check('input.brakeHold', input.braking && input.shiftedWhileBraking && input.stillBraking && input.handbrakeToggled && input.released, input);

// ---- 4b) トグル系ボタン：this が要素に束縛され、押すたび状態が反転する ----
const toggles = await page.evaluate(() => {
  const ids = ['btnSound','btnGuide','btnLines','creep','btnExam'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = 'MISSING'; continue; }
    const before = el.classList.contains('on');
    const ctr = { x: el.getBoundingClientRect().x + 4, y: el.getBoundingClientRect().y + 4 };
    const pe = (t,p) => el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,pointerId:9,clientX:p.x,clientY:p.y,isPrimary:true}));
    try { pe('pointerdown',ctr); pe('pointerup',ctr); } catch(e) { out[id] = 'THROW:'+e.message; continue; }
    out[id] = (el.classList.contains('on') !== before) ? 'TOGGLED' : 'NO-CHANGE';
  }
  return out;
});
check('input.toggleButtons', Object.values(toggles).every(v => v === 'TOGGLED'), toggles);

// ---- 5) 性能：連続フレームの平均処理時間（60fps=16.7ms 予算） ----
const perf = await page.evaluate(async () => {
  loadScenario(Object.keys(MODELS)[0]);
  const t0 = performance.now(); let n = 0;
  for (let i = 0; i < 120; i++) {
    renderScene(); renderFront(); renderWheel();
    renderMirror('L'); renderMirror('R'); renderRearview(); updateGauges(); n++;
  }
  return { avgMs: +((performance.now() - t0) / n).toFixed(2), frames: n };
});
check('perf.under16ms', perf.avgMs < 16.7, perf);
results['perf.avgMs'] = perf.avgMs;

// ---- 6) 音：AudioContext が生成され、更新が例外を出さない ----
const audio = await page.evaluate(() => {
  const A = (typeof SimAudio!=='undefined'&&SimAudio) || (typeof AudioEngine!=='undefined'&&AudioEngine) || null;
  if (!A) return { present: false };
  try {
    if (A.init) A.init();
    if (A.update) for (let i=0;i<30;i++) A.update({rpm:800+i*100,speed:i*0.3,load:0.5,slip:0,gear:'D'});
    return { present: true, ctxState: (A.ctx && A.ctx.state) || 'n/a' };
  } catch (e) { return { present: true, error: e.message }; }
});
results['audio'] = JSON.stringify(audio);
if (audio.present) check('audio.noThrow', !audio.error, audio);

// ---- 7) スクリーンショット（目視確認用） ----
await page.evaluate(() => loadScenario(Object.keys(MODELS)[0]));
await page.waitForTimeout(300);
await page.screenshot({ path: SHOT + 'main.png' });

await browser.close();

console.log('===== QA RESULT =====');
for (const k of Object.keys(results)) console.log(`  ${k}: ${results[k]}`);
console.log('ERRORS:', errs.length ? JSON.stringify(errs.slice(0,5)) : 'none');
console.log(fail.length ? `\n❌ FAILED (${fail.length}):\n - ` + fail.join('\n - ') : '\n✅ ALL CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
