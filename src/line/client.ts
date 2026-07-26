/** LINE Messaging API の薄いクライアント */

const API_BASE = 'https://api.line.me/v2/bot';

export type LineMessage = Record<string, unknown>;

async function post(
  accessToken: string,
  path: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // 返信の失敗でワーカー全体を落とさない。ログに残して先に進む。
    console.error(`[line] ${path} ${response.status}: ${await response.text()}`);
  }
}

/** replyToken は1回きり・約1分で失効する。基本はこちらを使う。 */
export async function reply(
  accessToken: string,
  replyToken: string,
  messages: LineMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await post(accessToken, '/message/reply', { replyToken, messages: messages.slice(0, 5) });
}

/** Cron からの通知など、replyToken が無い場面用。 */
export async function push(
  accessToken: string,
  to: string,
  messages: LineMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await post(accessToken, '/message/push', { to, messages: messages.slice(0, 5) });
}

export interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

export async function getProfile(
  accessToken: string,
  userId: string,
): Promise<LineProfile | null> {
  const response = await fetch(`${API_BASE}/profile/${userId}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  return response.json();
}
