import app from './api';
import { runPoll, runSync } from './jobs';
import { NotConnectedError } from './spotify';
import { connectedUserIds, internalKey, resolveMissingSpotifyIds } from './users';
import type { Env } from './types';

type Job = 'poll' | 'sync';

/**
 * Run a job for one user in its own Worker invocation via the SELF service binding, so every user
 * gets a fresh budget of 50 subrequests and 10 ms CPU. Falls back to running inline without SELF.
 */
async function runForUser(env: Env, job: Job, userId: number, key: string): Promise<unknown> {
  if (!env.SELF) {
    try {
      return await (job === 'poll' ? runPoll : runSync)(env, userId);
    } catch (e) {
      if (e instanceof NotConnectedError) return { notConnected: true };
      throw e;
    }
  }
  const res = await env.SELF.fetch(`https://internal/internal/${job}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': key },
    body: JSON.stringify({ userId }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const job: Job = event.cron === '* * * * *' ? 'poll' : 'sync';
    try {
      if (job === 'sync') await resolveMissingSpotifyIds(env);
      const [ids, key] = await Promise.all([connectedUserIds(env), internalKey(env)]);
      const results = await Promise.allSettled(ids.map((id) => runForUser(env, job, id, key)));
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') console.log(event.cron, `user ${ids[i]}`, JSON.stringify(r.value));
        else console.error(event.cron, `user ${ids[i]}`, r.reason);
      });
    } catch (e) {
      console.error(event.cron, e);
    }
  },
} satisfies ExportedHandler<Env>;
