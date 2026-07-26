/**
 * LIFF からのAPI呼び出しの認証。
 *
 * ブラウザ側で `liff.getIDToken()` を取り、`Authorization: Bearer <idToken>` で
 * 送ってもらう。サーバは LINE の verify エンドポイントで検証して userId (sub) を得る。
 * 検証結果はトークンの有効期限まで isolate 内にキャッシュし、毎リクエストの
 * 外部通信を避ける。
 */

import type { Env } from '../types';

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

interface VerifiedIdToken {
  sub: string;
  aud: string;
  exp: number;
  name?: string;
  picture?: string;
}

interface CacheEntry {
  userId: string;
  displayName: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;

export interface AuthedUser {
  userId: string;
  displayName: string | null;
}

export async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthedUser | null> {
  // ローカル開発の逃げ道。DEV_USER_ID が設定されているときだけ有効。
  if (env.DEV_USER_ID) {
    const devUser = request.headers.get('x-dev-user');
    if (devUser && devUser === env.DEV_USER_ID) {
      return { userId: env.DEV_USER_ID, displayName: 'dev' };
    }
  }

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const idToken = header.slice(7).trim();
  if (!idToken) return null;

  const now = Date.now();
  const cached = cache.get(idToken);
  if (cached && cached.expiresAt > now) {
    return { userId: cached.userId, displayName: cached.displayName };
  }

  if (!env.LIFF_CHANNEL_ID) {
    console.error('[auth] LIFF_CHANNEL_ID is not configured');
    return null;
  }

  const response = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LIFF_CHANNEL_ID }),
  });
  if (!response.ok) {
    console.warn('[auth] id token rejected:', response.status);
    return null;
  }

  const payload = (await response.json()) as VerifiedIdToken;
  // verify エンドポイントも検証するが、aud は自分でも確認しておく。
  if (payload.aud !== env.LIFF_CHANNEL_ID || !payload.sub) return null;

  const entry: CacheEntry = {
    userId: payload.sub,
    displayName: payload.name ?? null,
    // exp は秒。少し手前で切って使う。
    expiresAt: Math.min(payload.exp * 1000 - 30_000, now + 30 * 60_000),
  };
  if (entry.expiresAt > now) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(idToken, entry);
  }

  return { userId: entry.userId, displayName: entry.displayName };
}
