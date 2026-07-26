import { Hono } from 'hono';
import type { Env } from './types';
import { api } from './api/routes';
import { verifyLineSignature } from './line/signature';
import { handleWebhook, type WebhookBody } from './line/webhook';
import { push } from './line/client';
import { listCard, text } from './line/messages';
import { allHouseholds, markDraftCreated } from './domain/households';
import {
  addParsedItems,
  ensureActiveList,
  getActiveList,
  getItems,
} from './domain/lists';
import { appearanceCounts, listCatalog, toSnapshot } from './domain/catalog';
import { suggestItems, usualItems } from './domain/suggest';
import { loadRoute } from './domain/routeStore';
import { DOW_LABELS, jstDateString, jstDayOfWeek } from './util/time';
import type { ParsedItem } from './parser';

const app = new Hono<{ Bindings: Env }>();

/** LIFF SDK の初期化に必要な値。秘密ではないので認証なしで返す。 */
app.get('/liff-config.json', (c) => c.json({ liffId: c.env.LIFF_ID }));

app.get('/healthz', (c) => c.text('ok'));

app.post('/line/webhook', async (c) => {
  // 署名検証は「生バイト」に対して行う。JSONを読んでから再構築すると必ず失敗する。
  const raw = await c.req.arrayBuffer();
  const valid = await verifyLineSignature(
    c.env.LINE_CHANNEL_SECRET,
    raw,
    c.req.header('x-line-signature') ?? null,
  );
  if (!valid) return c.text('invalid signature', 401);

  let body: WebhookBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as WebhookBody;
  } catch {
    return c.text('bad request', 400);
  }

  // LINEには即座に200を返し、処理はバックグラウンドで続ける。
  // 解析にClaude APIを挟むと数秒かかることがあるため。
  c.executionCtx.waitUntil(handleWebhook(body, c.env));
  return c.text('ok');
});

app.route('/api', api);

/**
 * 週次の下書き作成。
 *
 * 「いつもの買い物曜日」の前日に、履歴から作った下書きリストを投げておく。
 * 妻はゼロから書き起こす代わりに、要る/要らないを直すだけで済む。
 * これが「妻の負担を減らす」ぶんの本体。
 */
async function createWeeklyDrafts(env: Env, now: number): Promise<void> {
  const today = jstDateString(now);
  const todayDow = jstDayOfWeek(now);

  for (const household of await allHouseholds(env.DB)) {
    try {
      if (household.shopping_dow === null) continue;
      // 買い物の前日に出す
      const draftDow = (household.shopping_dow + 6) % 7;
      if (todayDow !== draftDow) continue;
      if (household.last_draft_on === today) continue;

      // すでに中身のあるリストが動いていれば邪魔しない
      const active = await getActiveList(env.DB, household.id);
      if (active) {
        const existing = await getItems(env.DB, active.id);
        if (existing.length > 0) {
          await markDraftCreated(env.DB, household.id, today);
          continue;
        }
      }

      const catalog = (await listCatalog(env.DB, household.id)).map(toSnapshot);
      const { counts, trips } = await appearanceCounts(env.DB, household.id, 8);
      const usual = usualItems(catalog, counts, trips, { limit: 12 });
      const suggestions = suggestItems(catalog, { now, limit: 6, minScore: 0.55 });

      const seen = new Set(usual.map((item) => item.id));
      const draft = [
        ...usual,
        ...suggestions.map((s) => s.item).filter((item) => !seen.has(item.id)),
      ];
      if (draft.length === 0) continue;

      const list = await ensureActiveList(env.DB, household.id, null, now);
      const parsed: ParsedItem[] = draft.map((item) => ({
        raw: item.canonical_name,
        name: item.canonical_name,
        quantity: item.default_quantity,
        unit: item.default_unit,
        note: null,
        category: item.category,
        confidence: 1,
      }));
      await addParsedItems(env.DB, household.id, list, parsed, 'suggestion', now);
      await markDraftCreated(env.DB, household.id, today);

      const items = await getItems(env.DB, list.id);
      const route = await loadRoute(env.DB, household.id);
      const dowLabel = DOW_LABELS[household.shopping_dow] ?? '';
      await push(env.LINE_CHANNEL_ACCESS_TOKEN, household.line_source_id, [
        text(
          `明日（${dowLabel}）は買い物の日ですね。履歴から下書きを作っておきました。\n` +
            `要らないものは「削除 ○○」、足すものはそのまま送ってください。`,
        ),
        listCard(items, env.LIFF_ID, { heading: '下書き', precedence: route.counts }),
      ]);
    } catch (error) {
      console.error(`[cron] household ${household.id} failed:`, error);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(createWeeklyDrafts(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
