import { adminClient } from './supabase-admin.ts';

// Explicit broadcast on a per-room channel. Used for events that carry payload
// not naturally captured by Postgres CDC — e.g. the round_closed reveal which
// carries correct_index, insight, and per-player picks for the previous round.
//
// Channel naming convention: "room:<room_code>"
// Event naming is free-form; clients subscribe by event name.
export async function broadcastToRoom(
  roomCode: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = adminClient();
  const channel = db.channel(`room:${roomCode}`);
  try {
    await channel.subscribe();
    await channel.send({
      type: 'broadcast',
      event,
      payload,
    });
  } finally {
    // Always tear down the channel so we don't leak connections across invocations.
    try { await channel.unsubscribe(); } catch { /* noop */ }
  }
}
