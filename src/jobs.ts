import type { ChainRow, Env, Settings, Snapshot, TransitionKind } from './types';
import { classifyTransition, sameSong, toSnapshot } from './poller';
import { planAppend, seedFromSnapshot, summarizeChain } from './chains';
import { flattenRecent, reconcile } from './reconcile';
import { description, finalName, liveName } from './naming';
import { chainTags } from './lastfm';
import { notify, topicFor } from './notify';
import * as db from './db';
import * as spotify from './spotify';

/* ---------- poll (every minute) ---------- */

async function startChain(env: Env, userId: number, snap: Snapshot, kind: TransitionKind): Promise<number> {
  const seed = seedFromSnapshot(snap);
  if (seed.type === 'playlist' || seed.type === 'album' || seed.type === 'artist') {
    seed.name = (await spotify.getContextName(env, userId, seed.type, seed.uri)) ?? seed.name;
  }
  return db.insertChain(env, userId, seed, snap.ts - snap.progressMs, kind);
}

function playFromSnapshot(snap: Snapshot, chainId: number, kind: TransitionKind, evidence: Record<string, unknown> | null): db.NewPlay {
  return {
    chainId,
    trackId: snap.trackId,
    trackUri: snap.trackUri,
    itemType: snap.itemType,
    isLocal: snap.isLocal,
    name: snap.name,
    artists: snap.artists,
    durationMs: snap.durationMs,
    startedAt: snap.ts - snap.progressMs,
    contextUri: snap.contextUri,
    contextType: snap.contextType,
    shuffle: snap.shuffle,
    device: snap.device,
    source: 'poller',
    kind,
    evidence,
  };
}

/** Watch one user's player. Runs every minute in its own invocation (see index.ts). */
export async function runPoll(env: Env, userId: number): Promise<Record<string, unknown>> {
  const settings = await db.getSettings(env, userId);
  if (!settings.tracking) return { skipped: 'tracking is off' };

  const ts = Date.now();
  const player = await spotify.getPlayer(env, userId);
  if (!player?.item) {
    // Nothing playing / no active device. Pauses never end a chain, so just note we looked.
    await db.touchPolled(env, userId, ts);
    return { idle: true };
  }
  const queue = await spotify.getQueue(env, userId);
  const now = toSnapshot(player, queue, ts)!;
  const state = await db.getPlayerState(env, userId);
  const prev = state.snapshot;

  // Very first song we ever see starts the first chain.
  if (!prev || state.currentChainId == null) {
    const chainId = await startChain(env, userId, now, 'first');
    const res = await db.insertPlayStmt(env, userId, playFromSnapshot(now, chainId, 'first', null)).first<{ id: number }>();
    await db.savePlayerState(env, userId, {
      snapshot: now,
      lastPolledAt: ts,
      prevTrackId: null,
      currentPlayId: res?.id ?? null,
      currentChainId: chainId,
    });
    return { started: chainId };
  }

  if (sameSong(prev, now)) {
    await db.savePlayerState(env, userId, { ...state, snapshot: now, lastPolledAt: ts });
    return { same: now.name };
  }

  const pollGapMs = state.lastPolledAt ? ts - state.lastPolledAt : Number.POSITIVE_INFINITY;
  const t = classifyTransition(prev, now, { pollGapMs, trackBeforePrev: state.prevTrackId });

  const stmts: D1PreparedStatement[] = [];
  if (t.prevSkipped && state.currentPlayId) {
    stmts.push(env.DB.prepare('UPDATE plays SET skipped = 1 WHERE id = ? AND user_id = ?').bind(state.currentPlayId, userId));
  }
  // Songs that went by between two polls belong to the chain that was running.
  let at = prev.ts + Math.max(0, prev.durationMs - prev.progressMs);
  for (const q of t.intermediate) {
    stmts.push(
      db.insertPlayStmt(env, userId, {
        chainId: state.currentChainId,
        trackId: q.id,
        trackUri: q.uri,
        itemType: q.itemType,
        isLocal: false,
        name: q.name,
        artists: q.artists,
        durationMs: q.durationMs,
        startedAt: at,
        contextUri: prev.contextUri,
        contextType: prev.contextType,
        shuffle: prev.shuffle,
        device: prev.device,
        source: 'inferred',
        kind: t.kind,
        skipped: q.skipped,
      }),
    );
    at += q.skipped ? 1_000 : q.durationMs;
  }

  let chainId = state.currentChainId;
  if (t.chainBreak) {
    stmts.push(db.closeChainStmt(env, userId, chainId, now.ts - now.progressMs));
    chainId = await startChain(env, userId, now, t.kind);
  }
  stmts.push(db.insertPlayStmt(env, userId, playFromSnapshot(now, chainId, t.kind, t.evidence)));
  const results = await env.DB.batch<{ id: number }>(stmts);
  const playId = results.at(-1)?.results?.[0]?.id ?? null;

  await db.savePlayerState(env, userId, {
    snapshot: now,
    lastPolledAt: ts,
    prevTrackId: prev.trackId,
    currentPlayId: playId,
    currentChainId: chainId,
  });
  return { kind: t.kind, chainBreak: t.chainBreak, chainId, song: now.name };
}

/* ---------- sync (every 15 minutes) ---------- */

const RECONCILE_LOOKBACK_MS = 3 * 3_600_000;
// Each invocation may make 50 subrequests (Spotify calls *and* D1 queries). Reconcile uses ~6 and a
// finalizing chain up to ~16, so two chains per run stays safely inside; leftovers wait 15 minutes.
const CHAINS_PER_SYNC = 2;

async function runReconcile(env: Env, userId: number, settings: Settings): Promise<{ matched: number; backfilled: number }> {
  const recent = flattenRecent(await spotify.getRecentlyPlayed(env, userId)).filter((r) => r.playedAt >= settings.trackingSince);
  if (!recent.length) return { matched: 0, backfilled: 0 };
  const plays = await db.playsSince(env, userId, recent[0].playedAt - RECONCILE_LOOKBACK_MS);
  const state = await db.getPlayerState(env, userId);
  const r = reconcile(recent, plays, state.currentChainId);
  const stmts: D1PreparedStatement[] = [
    ...r.matches.map((m) =>
      env.DB.prepare('UPDATE plays SET played_at = ? WHERE id = ? AND user_id = ? AND played_at IS NULL').bind(m.playedAt, m.playId, userId),
    ),
    ...r.inserts.map((i) =>
      db.insertPlayStmt(env, userId, {
        chainId: i.chainId,
        trackId: i.trackId,
        trackUri: i.trackUri,
        itemType: 'track',
        isLocal: i.isLocal,
        name: i.name,
        artists: i.artists,
        durationMs: i.durationMs,
        startedAt: i.startedAt,
        playedAt: i.playedAt,
        contextUri: i.contextUri,
        contextType: i.contextType,
        source: 'recent',
        kind: 'backfill',
      }),
    ),
  ];
  if (stmts.length) await env.DB.batch(stmts);
  return { matched: r.matches.length, backfilled: r.inserts.length };
}

function chainTitle(chain: ChainRow): string {
  return chain.custom_name ?? chain.seed_name;
}

/**
 * Bring one chain's playlist up to date: create it when due, append newly settled songs,
 * and finalize (name with date range + notification) once the chain has closed.
 * `force` creates the playlist even in Review mode or when the chain isn't eligible.
 */
export async function syncChain(env: Env, chain: ChainRow, settings: Settings, force = false): Promise<string> {
  const userId = chain.user_id;
  const topic = topicFor(env, userId, settings);
  const plays = await db.chainPlays(env, userId, chain.id);
  const open = chain.status === 'open';
  const summary = summarizeChain(chain, plays, settings);
  const tz = settings.timezone;
  const end = chain.ended_at ?? summary.lastAt ?? chain.started_at;
  let created = false;

  if (chain.playlist_status !== 'created') {
    const due = force || (settings.mode === 'auto' && summary.eligible);
    if (!due) {
      if (!open) {
        // Closed without a playlist. In Auto mode record why; in Review mode it waits for you to tap Create.
        const status = settings.mode === 'auto' && summary.reason !== 'ok' ? summary.reason : 'none';
        await env.DB.prepare("UPDATE chains SET playlist_status = ?, finalized = 1 WHERE id = ? AND playlist_status = 'none'")
          .bind(status, chain.id)
          .run();
        return `closed without playlist (${status === 'none' ? 'awaiting review' : status})`;
      }
      return `open, not due (${summary.reason})`;
    }
    if (summary.keptUnique === 0) return 'nothing to add yet';

    // Claim first so two overlapping runs can never create two playlists.
    const claim = await env.DB.prepare(
      "UPDATE chains SET playlist_status = 'creating' WHERE id = ? AND playlist_status IN ('none', 'copy', 'too_short')",
    )
      .bind(chain.id)
      .run();
    if (!claim.meta.changes) return 'already being created';
    const name = chain.custom_name ?? (open ? liveName(chain.seed_name, chain.started_at, tz) : finalName(chain.seed_name, chain.started_at, end, tz));
    try {
      const pl = await spotify.createPlaylist(env, userId, name, description(chainTitle(chain), summary, open, tz));
      await env.DB.prepare("UPDATE chains SET playlist_status = 'created', playlist_id = ?, playlist_url = ?, finalized = 0 WHERE id = ?")
        .bind(pl.id, pl.url, chain.id)
        .run();
      chain = { ...chain, playlist_status: 'created', playlist_id: pl.id, playlist_url: pl.url, finalized: 0 };
      created = true;
    } catch (e) {
      await env.DB.prepare("UPDATE chains SET playlist_status = 'none' WHERE id = ? AND playlist_status = 'creating'").bind(chain.id).run();
      throw e;
    }
  }

  const holdBack = open ? (await db.getPlayerState(env, userId)).currentPlayId : null;
  const plan = planAppend(plays, holdBack);
  if (plan.uris.length) await spotify.addItems(env, userId, chain.playlist_id!, plan.uris);
  if (plan.settledIds.length) {
    await env.DB.batch(
      chunk(plan.settledIds, 50).map((ids) =>
        env.DB.prepare(`UPDATE plays SET added = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(userId, ...ids),
      ),
    );
  }

  if (!open) {
    const tags = await chainTags(env, plays);
    const name = chain.custom_name ?? finalName(chain.seed_name, chain.started_at, end, tz, tags);
    await spotify.updatePlaylistDetails(env, userId, chain.playlist_id!, { name, description: description(chainTitle(chain), summary, false, tz) });
    await env.DB.prepare('UPDATE chains SET finalized = 1 WHERE id = ?').bind(chain.id).run();
    await notify(topic, `Chain finished: ${name}`, `${summary.keptUnique} songs · tap to open in Spotify`, chain.playlist_url);
    return `finalized (+${plan.uris.length})`;
  }
  if (created) {
    await notify(topic, `New chain playlist: ${chainTitle(chain)}`, `${summary.keptUnique} songs so far, it will keep growing`, chain.playlist_url);
  } else if (plan.uris.length) {
    await spotify.updatePlaylistDetails(env, userId, chain.playlist_id!, { description: description(chainTitle(chain), summary, true, tz) });
  }
  return `${created ? 'created, ' : ''}+${plan.uris.length} songs`;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Reconcile and update playlists for one user. Runs every 15 minutes in its own invocation. */
export async function runSync(env: Env, userId: number): Promise<Record<string, unknown>> {
  const settings = await db.getSettings(env, userId);
  if (!settings.tracking) return { skipped: 'tracking is off' };
  const reconciled = await runReconcile(env, userId, settings);
  const chains: Record<number, string> = {};
  for (const chain of await db.chainsNeedingSync(env, userId, CHAINS_PER_SYNC)) {
    try {
      chains[chain.id] = await syncChain(env, chain, settings);
    } catch (e) {
      chains[chain.id] = `error: ${(e as Error).message}`;
      console.error('sync chain failed', chain.id, e);
    }
  }
  return { reconciled, chains };
}
