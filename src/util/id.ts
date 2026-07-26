/** 時刻順にソート可能なID (ULID風)。D1の主キーに使う。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(prefix: string, now: number = Date.now()): string {
  let time = now;
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ALPHABET[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }

  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  let randomPart = '';
  for (const byte of random) randomPart += ALPHABET[byte % 32]!;

  return `${prefix}_${timePart}${randomPart}`;
}
