// adopt.js — 「採用」ボタン共通の誠実性ガード.
//
// POST /apply はトレラント（不正なパスは黙って skipped に落とし、200 を返す）ので、
// 呼び出し側が `applied`/`skipped` を見ずに成功トーストを出すと **嘘ボタン** になる
// （③生産性試算の「この方式で設計 →」が `process.stages.2.work.orders_per_trip` を
// 投げ、stages[2].work が null なので全部 skipped、なのに「採用しました」と出ていた）。
//
// ここを1つの口にまとめ、要求したパスが1つでも通らなければ **例外** にする。
// 「何が適用されなかったか」を message に載せるので、呼び出し側はそのまま
// toast(error) に流すだけでよい。EN comments / JA UI.
import { api } from './util.js';

export class ApplyError extends Error {
  constructor(message, skipped) {
    super(message);
    this.name = 'ApplyError';
    this.skipped = skipped || [];
  }
}

/**
 * Apply dotted-path edits and VERIFY the server took them.
 * @param {string} name    project name
 * @param {object} edits   {dotted.path: value}
 * @returns {Promise<object>} the server response ({ok, applied, skipped, …})
 * @throws {ApplyError} when any requested path was skipped / not applied.
 */
export async function applyEdits(name, edits) {
  const want = Object.keys(edits || {});
  const r = await api(`/api/projects/${encodeURIComponent(name)}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ edits }),
  });
  const applied = Array.isArray(r && r.applied) ? r.applied : [];
  // Trust `skipped` when present, but also treat "asked for X, X is not in
  // applied" as a skip — a future endpoint that drops a path silently must not
  // be able to turn this into a success either.
  const missed = Array.from(new Set(
    (Array.isArray(r && r.skipped) ? r.skipped : [])
      .concat(want.filter((p) => !applied.includes(p)))));
  if (missed.length) {
    throw new ApplyError(
      `モデルに書き込めない項目がありました（${missed.join(' / ')}）。`, missed);
  }
  return r;
}
