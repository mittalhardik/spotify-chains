import type { ChainRow, Env } from './types';
import { playsFrom, type Seed } from './chains';
import { syncChain } from './jobs';
import * as db from './db';
import * as spotify from './spotify';

export class HttpError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

async function mustChain(env: Env, userId: number, id: number): Promise<ChainRow> {
  const chain = await db.getChain(env, userId, id);
  if (!chain) throw new HttpError(404, `Chain ${id} not found`);
  return chain;
}

/** Split a chain so that `playId` and everything after it becomes a new chain. */
export async function splitAt(env: Env, userId: number, chainId: number, playId: number): Promise<{ newChainId: number }> {
  const chain = await mustChain(env, userId, chainId);
  const plays = await db.chainPlays(env, userId, chainId);
  const at = plays.find((p) => p.id === playId);
  if (!at) throw new HttpError(404, 'That song is not in this chain');
  const moved = playsFrom(plays, at);
  if (moved.length === plays.length) throw new HttpError(400, 'This song already starts the chain');
  if (moved.some((p) => p.added)) throw new HttpError(409, "Those songs are already in the chain's playlist, so it can't be split there");

  let seed: Seed;
  if (at.context_uri && at.context_type) {
    const known = at.context_uri === chain.seed_uri ? chain.seed_name : null;
    const name =
      known ??
      (at.context_type === 'collection' ? 'Liked Songs' : await spotify.getContextName(env, userId, at.context_type, at.context_uri)) ??
      at.name;
    seed = { type: at.context_type, uri: at.context_uri, name };
  } else {
    seed = { type: 'track', uri: at.track_uri, name: at.name };
  }
  const newChainId = await db.insertChain(env, userId, seed, at.started_at, 'manual_break');
  const ids = moved.map((p) => p.id);
  await env.DB.batch([
    env.DB.prepare(`UPDATE plays SET chain_id = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(newChainId, userId, ...ids),
    env.DB.prepare('UPDATE chains SET status = ?, ended_at = ? WHERE id = ?').bind(chain.status, chain.ended_at, newChainId),
    // The earlier part is now finished; let the sync job finalize it again.
    env.DB.prepare(
      `UPDATE chains SET status = 'closed', ended_at = ?, finalized = 0,
         playlist_status = CASE WHEN playlist_status IN ('copy', 'too_short') THEN 'none' ELSE playlist_status END
       WHERE id = ?`,
    ).bind(at.started_at, chainId),
    env.DB.prepare('UPDATE player_state SET current_chain_id = ? WHERE user_id = ? AND current_chain_id = ?').bind(newChainId, userId, chainId),
    db.addMarkerStmt(env, userId, 'split', chainId, { playId, newChainId }),
  ]);
  return { newChainId };
}

/** "Break chain" from the iPhone: the song playing now starts a new chain. */
export async function breakNow(env: Env, userId: number): Promise<{ newChainId: number } | { message: string }> {
  const state = await db.getPlayerState(env, userId);
  if (state.currentChainId == null || state.currentPlayId == null) throw new HttpError(409, 'Nothing has been tracked yet');
  const plays = await db.chainPlays(env, userId, state.currentChainId);
  if (plays[0]?.id === state.currentPlayId) return { message: 'The current song already starts a new chain' };
  return splitAt(env, userId, state.currentChainId, state.currentPlayId);
}

/** Undo a boundary: fold `chainId` into the chain right before it. */
export async function mergeIntoPrevious(env: Env, userId: number, chainId: number): Promise<{ mergedInto: number }> {
  const chain = await mustChain(env, userId, chainId);
  const prev = await db.previousChain(env, userId, chainId);
  if (!prev) throw new HttpError(400, 'There is no earlier chain to merge into');
  if (chain.playlist_status === 'created' || chain.playlist_status === 'creating') {
    throw new HttpError(409, 'This chain already has its own playlist, so it can’t be merged');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE plays SET chain_id = ? WHERE user_id = ? AND chain_id = ?').bind(prev.id, userId, chainId),
    env.DB.prepare(
      `UPDATE chains SET status = ?, ended_at = ?, finalized = 0,
         playlist_status = CASE WHEN playlist_status IN ('copy', 'too_short') THEN 'none' ELSE playlist_status END
       WHERE id = ?`,
    ).bind(chain.status, chain.ended_at, prev.id),
    env.DB.prepare('DELETE FROM chains WHERE id = ?').bind(chainId),
    env.DB.prepare('UPDATE player_state SET current_chain_id = ? WHERE user_id = ? AND current_chain_id = ?').bind(prev.id, userId, chainId),
    db.addMarkerStmt(env, userId, 'merge', prev.id, { merged: chainId }),
  ]);
  return { mergedInto: prev.id };
}

/** "Keep chain" from the iPhone: the last boundary was wrong. */
export async function keepCurrent(env: Env, userId: number): Promise<{ mergedInto: number }> {
  const state = await db.getPlayerState(env, userId);
  if (state.currentChainId == null) throw new HttpError(409, 'Nothing has been tracked yet');
  return mergeIntoPrevious(env, userId, state.currentChainId);
}

export async function createNow(env: Env, userId: number, chainId: number): Promise<string> {
  const chain = await mustChain(env, userId, chainId);
  if (chain.playlist_status === 'discarded') throw new HttpError(409, 'This chain was discarded');
  const settings = await db.getSettings(env, userId);
  await db.addMarkerStmt(env, userId, 'create', chainId).run();
  return syncChain(env, chain, settings, true);
}

export async function discard(env: Env, userId: number, chainId: number): Promise<void> {
  await mustChain(env, userId, chainId);
  await env.DB.batch([
    env.DB.prepare("UPDATE chains SET playlist_status = 'discarded', finalized = 1 WHERE id = ?").bind(chainId),
    db.addMarkerStmt(env, userId, 'discard', chainId),
  ]);
}

export async function rename(env: Env, userId: number, chainId: number, name: string): Promise<void> {
  const chain = await mustChain(env, userId, chainId);
  const clean = name.trim().slice(0, 100);
  if (!clean) throw new HttpError(400, 'Name is empty');
  await env.DB.prepare('UPDATE chains SET custom_name = ? WHERE id = ?').bind(clean, chainId).run();
  if (chain.playlist_status === 'created' && chain.playlist_id) {
    await spotify.updatePlaylistDetails(env, userId, chain.playlist_id, { name: clean });
  }
}
