const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdSigned = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

const pct = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

export const fmtMoney = (n: number): string => (Number.isFinite(n) ? usd.format(n) : '—');

export const fmtSignedMoney = (n: number): string =>
  Number.isFinite(n) ? usdSigned.format(n) : '—';

export const fmtPrice = (n: number): string =>
  Number.isFinite(n) ? usd.format(n) : '—';

/** Fractional change, e.g. 0.0123 -> "+1.23%". */
export const fmtPercent = (fraction: number): string =>
  Number.isFinite(fraction) ? pct.format(fraction) : '—';

export const fmtQty = (n: number): string => new Intl.NumberFormat('en-US').format(n);

export const fmtTime = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** Sign class for coloring P&L / change numbers. */
export const signClass = (n: number): 'up' | 'down' | 'flat' =>
  n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
