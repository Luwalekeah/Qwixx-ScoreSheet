import 'server-only';
import { db } from './supabase/server';
import { resolveWinners, type GameState, type EndReason, type Standing } from './scoring';

export type EndReasonDb = EndReason | 'abandoned' | 'host_ended';

/**
 * The shared end-of-game write used by both POST /mutations (automatic end)
 * and POST /end (host-forced end). Writes game_players.final_score for every
 * player, then flips games.status to 'ended'.
 */
export async function runEndOfGameWrite(
  gameId: string,
  state: GameState,
  reason: EndReasonDb,
): Promise<{ winnerPlayerId: string | null; standings: Standing[] }> {
  const { winners, standings } = resolveWinners(state);
  const winnerPlayerId = winners.length === 1 ? winners[0] : null;

  for (const standing of standings) {
    await db
      .from('game_players')
      .update({ final_score: standing.total })
      .eq('game_id', gameId)
      .eq('player_id', standing.playerId);
  }

  await db
    .from('games')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      end_reason: reason,
      winner_player_id: winnerPlayerId,
    })
    .eq('id', gameId);

  return { winnerPlayerId, standings };
}
