// Realtime subscription helpers for multiplayer rooms.
//
// Two distinct channels per room:
//   1. A Supabase "broadcast" channel on topic `room:<code>` — receives the
//      explicit round_closed event from tick-room.
//   2. Postgres CDC on the `rooms`, `room_players`, and `room_answers` tables
//      filtered by room_id — captures durable state changes.
//
// Components use these via useEffect. Always call unsubscribe on cleanup.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface RoundClosedPayload {
  closed_index: number;
  correct_index: number;
  insight: string;
  scripture_ref: string;
  is_final: boolean;
  next_question_opens_at: string | null;
  player_results: Array<{
    player_uuid: string;
    display_username: string;
    selected_index: number | null;
    is_correct: boolean;
    points_awarded: number;
    time_ms: number | null;
    score: number;
    streak: number;
    multiplier: number;
  }>;
}

export interface RoomCdcHandlers {
  onRoomUpdate?: (row: Record<string, unknown>) => void;
  onPlayerChange?: (row: Record<string, unknown>, event: 'INSERT' | 'UPDATE' | 'DELETE') => void;
  onAnswerInserted?: (row: Record<string, unknown>) => void;
  onRoundClosed?: (payload: RoundClosedPayload) => void;
}

export function subscribeToRoom(
  roomId: string,
  roomCode: string,
  handlers: RoomCdcHandlers,
): () => void {
  // Broadcast channel — receives round_closed from tick-room.
  const broadcastChannel: RealtimeChannel = supabase.channel(`room:${roomCode}`);
  if (handlers.onRoundClosed) {
    broadcastChannel.on(
      'broadcast',
      { event: 'round_closed' },
      (msg) => handlers.onRoundClosed?.(msg.payload as RoundClosedPayload),
    );
  }
  broadcastChannel.subscribe();

  // CDC channel — Postgres row changes scoped to this room.
  const cdcChannel: RealtimeChannel = supabase.channel(`room-cdc:${roomId}`);

  if (handlers.onRoomUpdate) {
    cdcChannel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
      (payload) => handlers.onRoomUpdate?.(payload.new as Record<string, unknown>),
    );
  }

  if (handlers.onPlayerChange) {
    cdcChannel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` },
      (payload) => {
        const row = (payload.new && Object.keys(payload.new).length > 0 ? payload.new : payload.old) as Record<string, unknown>;
        handlers.onPlayerChange?.(row, payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE');
      },
    );
  }

  if (handlers.onAnswerInserted) {
    cdcChannel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'room_answers', filter: `room_id=eq.${roomId}` },
      (payload) => handlers.onAnswerInserted?.(payload.new as Record<string, unknown>),
    );
  }

  cdcChannel.subscribe();

  return () => {
    try { broadcastChannel.unsubscribe(); } catch { /* noop */ }
    try { cdcChannel.unsubscribe(); } catch { /* noop */ }
  };
}
