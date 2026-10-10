import type { Env, PlayRow } from './types';
import { isKeepable } from './chains';
import { pickTags } from './naming';

const CACHE_MS = 90 * 86_400_000;
const MAX_ARTISTS = 3;

async function fetchArtistTags(env: Env, artist: string): Promise<string[]> {
  const q = new URLSearchParams({ method: 'artist.gettoptags', artist, api_key: env.LASTFM_KEY!, format: 'json', autocorrect: '1' });
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${q}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { toptags?: { tag?: Array<{ name: string }> } };
  return (body.toptags?.tag ?? []).slice(0, 10).map((t) => t.name);
}

/**
 * Top 2 Last.fm tags for a chain's main artists. Empty when LASTFM_KEY isn't set or lookups fail.
 * The cache is read and written in one query each, to stay inside the per-invocation subrequest budget.
 */
export async function chainTags(env: Env, plays: PlayRow[]): Promise<string[]> {
  if (!env.LASTFM_KEY) return [];
  const counts = new Map<string, number>();
  for (const p of plays.filter(isKeepable)) {
    const main = p.artists.split(', ')[0];
    if (main) counts.set(main, (counts.get(main) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ARTISTS);
  if (!top.length) return [];
  try {
    const names = top.map(([a]) => a);
    const { results } = await env.DB.prepare(
      `SELECT artist, tags FROM artist_tags WHERE fetched_at > ? AND artist IN (${names.map(() => '?').join(',')})`,
    )
      .bind(Date.now() - CACHE_MS, ...names)
      .all<{ artist: string; tags: string }>();
    const tags = new Map(results.map((r) => [r.artist, JSON.parse(r.tags) as string[]]));
    const missing = names.filter((a) => !tags.has(a));
    const fetched = await Promise.all(missing.map(async (a) => [a, await fetchArtistTags(env, a)] as const));
    if (fetched.length) {
      const now = Date.now();
      await env.DB.batch(
        fetched.map(([a, t]) =>
          env.DB.prepare(
            'INSERT INTO artist_tags (artist, tags, fetched_at) VALUES (?, ?, ?) ON CONFLICT(artist) DO UPDATE SET tags = excluded.tags, fetched_at = excluded.fetched_at',
          ).bind(a, JSON.stringify(t), now),
        ),
      );
      fetched.forEach(([a, t]) => tags.set(a, t));
    }
    return pickTags(top.map(([artist, weight]) => ({ weight, tags: tags.get(artist) ?? [] })));
  } catch (e) {
    console.error('last.fm failed', e);
    return [];
  }
}
