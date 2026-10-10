import type { Env, Settings } from './types';

/** A user's ntfy topic: their own from Settings, or the legacy NTFY_TOPIC secret for the original owner (user 1). */
export function topicFor(env: Env, userId: number, settings: Settings): string {
  return settings.ntfyTopic || (userId === 1 ? env.NTFY_TOPIC ?? '' : '');
}

/** Push to the ntfy iOS app. A no-op without a topic; never throws. */
export async function notify(topic: string, title: string, message: string, clickUrl?: string | null): Promise<void> {
  if (!topic) return;
  try {
    await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic,
        title,
        message,
        tags: ['musical_note'],
        ...(clickUrl ? { click: clickUrl } : {}),
      }),
    });
  } catch (e) {
    console.error('ntfy failed', e);
  }
}
