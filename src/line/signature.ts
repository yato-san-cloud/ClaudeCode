/**
 * LINE の Webhook 署名検証。
 * 生のリクエストボディ (バイト列) に対する HMAC-SHA256 を Base64 したもの。
 * JSON.parse 後の再シリアライズでは絶対に一致しないので、必ず生バイトを渡すこと。
 */

export async function verifyLineSignature(
  channelSecret: string,
  rawBody: ArrayBuffer,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !channelSecret) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, rawBody);

  let binary = '';
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return timingSafeEqual(btoa(binary), signature);
}

/** 長さの違いも含めて一定時間で比較する */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
