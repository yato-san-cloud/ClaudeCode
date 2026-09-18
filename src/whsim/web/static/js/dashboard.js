// dashboard.js — ダッシュボード: the one screen that answers "how is this
// warehouse doing right now". A monitoring surface, not another editor: the KPI
// strip, the live 3D floor with its floating status panels, the chart rail and
// the event/throughput row all read the SAME run the rest of the app reads.
//
// This module is only the PROJECT MANAGER: it owns the grid hosts declared in
// index.html and the shared context object, and delegates every pixel to four
// self-contained modules under js/dashboard/. Each of those injects its own
// <style> (the established pattern — see pickrate.js), so they never fight over
// CSS and can be replaced one at a time.
//
//   mountKpiStrip(host, ctx) -> { update(ctx), dispose() }
//   mountStage(hosts,  ctx)  -> { update(ctx), dispose(), resize() }
//   mountRail(host,    ctx)  -> { update(ctx), dispose() }
//   mountBottom(host,  ctx)  -> { update(ctx), dispose() }
//
// EN comments / JA UI.
import { $, api } from './util.js';
import { mountTopbar } from './dashboard/topbar.js';
import { mountKpiStrip } from './dashboard/kpistrip.js';
import { mountStage } from './dashboard/stage.js';
import { mountRail } from './dashboard/rail.js';
import { mountBottom } from './dashboard/bottom.js';

/**
 * @param {object} opts
 *   getProjectName() -> string|null
 *   getReplay()      -> replay payload (or null)
 *   getTime()        -> current replay time in seconds
 *   getPlaying()     -> bool
 *   onSeek(t)        -> void
 *   onSelectView(id) -> void   (navigate the journey)
 *   onRun()          -> void   (kick a simulation)
 */
export function mountDashboard(opts = {}) {
  const hosts = {
    top: $('dashTop'),
    kpis: $('dashKpis'),
    stage: $('dashStage'),
    stage3d: $('dashStage3d'),
    ovLeft: $('dashOvLeft'),
    ovRight: $('dashOvRight'),
    pins: $('dashPins'),
    rail: $('dashRail'),
    bottom: $('dashBottom'),
  };
  if (!hosts.kpis) return null;

  // The shared, READ-ONLY context every module receives. Rebuilt on refresh so a
  // module never has to reach back into app state (keeps them pure over data).
  const ctx = {
    project: null,
    analysis: null,      // GET /api/projects/{n}/analysis
    replay: null,        // GET /api/projects/{n}/replay
    kpis: null,          // replay.kpis (the wide 83-key dict)
    scorecard: null,     // GET /api/projects/{n}/scorecard
    hasRun: false,
    getTime: opts.getTime || (() => 0),
    getPlaying: opts.getPlaying || (() => false),
    onSeek: opts.onSeek || (() => {}),
    onSelectView: opts.onSelectView || (() => {}),
    onRun: opts.onRun || (() => {}),
    setPlaying: opts.setPlaying || (() => {}),
    scene3d: null,
  };

  const parts = [];
  const add = (p) => { if (p) parts.push(p); return p; };
  const top = add(mountTopbar(hosts.top, ctx));
  const strip = add(mountKpiStrip(hosts.kpis, ctx));
  const stage = add(mountStage(hosts, ctx));
  const rail = add(mountRail(hosts.rail, ctx));
  const bottom = add(mountBottom(hosts.bottom, ctx));

  // Per-frame loop for the parts that follow the replay clock (the pinned 3D
  // labels, the sim clock, the "now" marker). It re-arms itself, but ONLY while
  // the panel is actually on screen — a dashboard left in the background must
  // not burn a frame budget the visible view needs.
  let raf = 0;
  const panel = hosts.kpis.closest('.panel');
  const visible = () => !panel || (!panel.hidden && panel.classList.contains('active'));
  function tick() {
    raf = 0;
    if (!visible()) return;                // parked; refresh() re-arms it
    if (top && top.tickClock) top.tickClock();
    if (stage && stage.tickClock) stage.tickClock();
    if (bottom && bottom.tickClock) bottom.tickClock();
    schedule();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(tick); }

  async function refresh() {
    const name = (opts.getProjectName && opts.getProjectName()) || null;
    ctx.project = name;
    ctx.replay = (opts.getReplay && opts.getReplay()) || null;
    ctx.kpis = ctx.replay ? ctx.replay.kpis || null : null;
    ctx.hasRun = !!(ctx.replay && ctx.kpis);
    if (name) {
      // Best-effort, never fatal: a dashboard that 500s is worse than one that
      // shows what it has ("never blocks").
      const [analysis, scorecard] = await Promise.all([
        api(`/api/projects/${encodeURIComponent(name)}/analysis`).catch(() => null),
        api(`/api/projects/${encodeURIComponent(name)}/scorecard`).catch(() => null),
      ]);
      ctx.analysis = analysis;
      ctx.scorecard = scorecard;
    } else {
      ctx.analysis = null;
      ctx.scorecard = null;
    }
    for (const p of parts) { if (p.update) p.update(ctx); }
    requestAnimationFrame(resize);   // new cards may have changed the row height
    schedule();
  }

  function resize() {
    // The WebGL surface is sized from its container, and the container's height
    // is decided by the RAIL (the grid row stretches to the tallest cell). So the
    // scene must be re-measured AFTER layout settles, or it renders at its
    // mount-time height and leaves dead space under the floor.
    if (ctx.scene3d && ctx.scene3d.resize) { try { ctx.scene3d.resize(); } catch (_) { /* noop */ } }
    if (stage && stage.resize) stage.resize();
    for (const p of parts) { if (p.resize && p !== stage) p.resize(); }
  }

  // Re-measure whenever the stage box actually changes (theme flip, rail growing
  // a card, window resize, the panel becoming visible). Cheaper and more reliable
  // than guessing with timers.
  let ro = null;
  if (typeof ResizeObserver === 'function' && hosts.stage) {
    let roRaf = 0;
    ro = new ResizeObserver(() => {
      if (roRaf) return;
      roRaf = requestAnimationFrame(() => { roRaf = 0; resize(); });
    });
    try { ro.observe(hosts.stage); } catch (_) { ro = null; }
  }

  function dispose() {
    if (ro) { try { ro.disconnect(); } catch (_) { /* noop */ } ro = null; }
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    for (const p of parts) { if (p.dispose) p.dispose(); }
    parts.length = 0;
  }

  return { refresh, resize, dispose, tick: schedule, ctx };
}
