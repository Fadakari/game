const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function toFaNum(value: number | string): string {
  return String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

export function formatScoreFa(score: number): string {
  const formatted = Math.max(0, Math.round(score)).toLocaleString('en-US');
  return toFaNum(formatted).replace(/,/g, '٬');
}

export function formatTimeFa(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${toFaNum(m)}:${toFaNum(s.toString().padStart(2, '0'))}`;
}
