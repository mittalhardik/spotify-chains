import type { ChainSummary } from './chains';

const NAME_MAX = 100;
const DESC_MAX = 300;

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function fmtDay(ts: number, tz: string): { label: string; key: string } {
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, month: 'short', day: 'numeric' };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(new Date(ts));
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return { label: `${month} ${day}`, key: `${month}|${day}` };
}

/** "Oct 6", "Oct 6–8" or "Oct 30–Nov 2". */
export function formatRange(start: number, end: number, tz: string): string {
  const a = fmtDay(start, tz);
  const b = fmtDay(end, tz);
  if (a.key === b.key) return a.label;
  const [am] = a.key.split('|');
  const [bm, bd] = b.key.split('|');
  return am === bm ? `${a.label}–${bd}` : `${a.label}–${bm} ${bd}`;
}

export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Calendar days the chain touched, in the user's timezone. */
export function daysSpanned(start: number, end: number, tz: string): number {
  const dayNum = (ts: number) => {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
    return Date.parse(d) / 86_400_000;
  };
  return Math.round(dayNum(end) - dayNum(start)) + 1;
}

function tagSuffix(tags: string[]): string {
  return tags.length ? ` · ${tags.slice(0, 2).join(' & ')}` : '';
}

export function liveName(seedName: string, start: number, tz: string): string {
  return clip(`${seedName} · Chain · ${fmtDay(start, tz).label} (live)`, NAME_MAX);
}

export function finalName(seedName: string, start: number, end: number, tz: string, tags: string[] = []): string {
  return clip(`${seedName} · Chain · ${formatRange(start, end, tz)}${tagSuffix(tags)}`, NAME_MAX);
}

export function description(seedName: string, s: ChainSummary, open: boolean, tz: string): string {
  const parts = [`Auto-chain from "${seedName}"`, `${s.keptUnique} songs`, formatDuration(s.listenMs)];
  if (!open && s.firstAt != null && s.lastAt != null) {
    const days = daysSpanned(s.firstAt, s.lastAt, tz);
    if (days > 1) parts.push(`over ${days} days`);
  }
  if (s.skips) parts.push(`${s.skips} skip${s.skips === 1 ? '' : 's'} excluded`);
  if (open) parts.push('still growing');
  parts.push('[auto]');
  return clip(parts.join(' · '), DESC_MAX);
}

const JUNK_TAGS = new Set(['seen live', 'favorites', 'favourite', 'favorite', 'love', 'awesome', 'beautiful', 'spotify']);

/** Pick the top 2 tags across artists, weighted by how many of the chain's songs each artist has. */
export function pickTags(artistTags: Array<{ weight: number; tags: string[] }>): string[] {
  const score = new Map<string, number>();
  for (const { weight, tags } of artistTags) {
    tags.slice(0, 5).forEach((t, i) => {
      const tag = t.toLowerCase().trim();
      if (!tag || JUNK_TAGS.has(tag)) return;
      score.set(tag, (score.get(tag) ?? 0) + weight * (5 - i));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t);
}
