import { describe, expect, it } from 'vitest';
import { daysSpanned, description, finalName, formatRange, liveName, pickTags } from '../src/naming';
import type { ChainSummary } from '../src/chains';

const t = (iso: string) => Date.parse(iso);

describe('naming', () => {
  it('formats date ranges in the given timezone', () => {
    expect(formatRange(t('2026-10-06T10:00:00Z'), t('2026-10-06T22:00:00Z'), 'UTC')).toBe('Oct 6');
    expect(formatRange(t('2026-10-06T10:00:00Z'), t('2026-10-08T10:00:00Z'), 'UTC')).toBe('Oct 6–8');
    expect(formatRange(t('2026-10-30T10:00:00Z'), t('2026-11-02T10:00:00Z'), 'UTC')).toBe('Oct 30–Nov 2');
    // 20:00 UTC on Oct 6 is already Oct 7 in India.
    expect(formatRange(t('2026-10-06T20:00:00Z'), t('2026-10-06T21:00:00Z'), 'Asia/Kolkata')).toBe('Oct 7');
  });

  it('counts calendar days spanned', () => {
    expect(daysSpanned(t('2026-10-06T23:00:00Z'), t('2026-10-07T01:00:00Z'), 'UTC')).toBe(2);
    expect(daysSpanned(t('2026-10-06T01:00:00Z'), t('2026-10-06T23:00:00Z'), 'UTC')).toBe(1);
  });

  it('builds live and final names, clipped to Spotify limits', () => {
    expect(liveName('Midnight City', t('2026-10-06T10:00:00Z'), 'UTC')).toBe('Midnight City · Chain · Oct 6 (live)');
    expect(finalName('Midnight City', t('2026-10-06T10:00:00Z'), t('2026-10-08T10:00:00Z'), 'UTC', ['synthpop', 'electronic'])).toBe(
      'Midnight City · Chain · Oct 6–8 · synthpop & electronic',
    );
    expect(finalName('x'.repeat(200), 0, 0, 'UTC').length).toBe(100);
  });

  it('describes a finished chain', () => {
    const s: ChainSummary = {
      songs: 47, keptUnique: 42, skips: 5, listenMs: 151 * 60_000, copyRatio: 0.3, eligible: true, reason: 'ok',
      firstAt: t('2026-10-06T10:00:00Z'), lastAt: t('2026-10-08T10:00:00Z'),
    };
    expect(description('Midnight City', s, false, 'UTC')).toBe(
      'Auto-chain from "Midnight City" · 42 songs · 2h 31m · over 3 days · 5 skips excluded · [auto]',
    );
    expect(description('Midnight City', s, true, 'UTC')).toContain('still growing');
  });

  it('picks the strongest tags, ignoring junk', () => {
    expect(
      pickTags([
        { weight: 5, tags: ['seen live', 'indie', 'indie pop'] },
        { weight: 2, tags: ['lo-fi', 'indie'] },
      ]),
    ).toEqual(['indie', 'indie pop']);
  });
});
