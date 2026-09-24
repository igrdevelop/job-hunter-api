/**
 * Port of the bot's hunter/sent_parse.py (`parse_sent_date` + `classify`),
 * which tools/pipeline_snapshot.py uses for `result.sent_in_window`.
 *
 * The `Sent` column is free text: a date in one of many formats, or a note
 * ("EXPIRED", "выгасла", a dash). Keep this in step with the Python module —
 * the snapshot contract defines "sent in window" through it.
 *
 * One deliberate difference: Python reads its default year (for "15 05" /
 * "1305" cells) from `date.today()` at import time; here the caller passes
 * it (the snapshot passes the Warsaw calendar year of its own clock).
 */

const EXPIRED_MARKERS = [
  'expired',
  'выгасла',
  'wygas',
  'no longer accepting',
  'inactive',
  'zakończył',
  'nie jest już dostęp',
  'nie została odnaleziona',
  "didn't find",
  "couldn't find",
  'bad gateway',
  'not there',
];

const EN_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** A `YYYY-MM-DD` string if (y, m, d) is a real calendar date, else null. */
function valid(y: number, m: number, d: number): string | null {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(Date.UTC(2000, m - 1, d)); // leap year stand-in…
  t.setUTCFullYear(y); // …then the real year, so 1-99 aren't remapped
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Port of `parse_sent_date` — returns `YYYY-MM-DD` or null. */
export function parseSentDate(
  value: string | null | undefined,
  defaultYear: number,
): string | null {
  const s = (value ?? '').trim();
  if (!s) return null;
  const low = s.toLowerCase();

  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(s);
  if (m) return valid(Number(m[3]), Number(m[2]), Number(m[1]));

  m = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(low);
  if (m && m[1] in EN_MONTHS) {
    return valid(Number(m[3]), EN_MONTHS[m[1]], Number(m[2]));
  }

  if (EXPIRED_MARKERS.some((mark) => low.includes(mark))) return null;

  m = /^(\d{1,2})[ .](\d{1,2})[ .](\d{2})\b/.exec(s);
  if (m) return valid(2000 + Number(m[3]), Number(m[2]), Number(m[1]));

  m = /^(\d{1,2})[ ./](\d{1,2})\b/.exec(s);
  if (m) return valid(defaultYear, Number(m[2]), Number(m[1]));

  m = /^(\d{2})(\d{2})$/.exec(s);
  if (m) return valid(defaultYear, Number(m[2]), Number(m[1]));

  return null;
}

export type SentClass = 'applied' | 'expired' | 'blank' | 'other';

/** Port of `classify` — applied | expired | blank | other. */
export function classifySent(
  value: string | null | undefined,
  defaultYear: number,
): SentClass {
  const s = (value ?? '').trim();
  if (!s || ['-', '—', '–', '- ', ' - '].includes(s)) return 'blank';
  if (parseSentDate(s, defaultYear) !== null) return 'applied';
  if (EXPIRED_MARKERS.some((mark) => s.toLowerCase().includes(mark))) {
    return 'expired';
  }
  return 'other';
}
