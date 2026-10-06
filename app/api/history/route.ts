import { db } from '@/lib/supabase/server';
import { resolveDevice } from '@/lib/auth';
import { jsonError } from '@/lib/apiError';
import { scoreSheet, type Color } from '@/lib/scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(req: Request) {
  try {
    const device = await resolveDevice(req);
    if (!device) return jsonError(401, 'no_device', 'No device identity found.');

    const url = new URL(req.url);
    const limitParam = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), MAX_LIMIT) : DEFAULT_LIMIT;
    const cursor = url.searchParams.get('cursor');

    const { data: myGamePlayers, error: gpError } = await db
      .from('game_players')
      .select('game_id')
      .eq('player_id', device.playerId);

    if (gpError) return jsonError(500, 'server_error', 'Something went wrong.');

    const gameIds = (myGamePlayers ?? []).map((r) => r.game_id);
    if (gameIds.length === 0) {
      return Response.json({ games: [], nextCursor: null });
    }

    let query = db
      .from('games')
      .select('id, join_code, status, ended_at, end_reason, winner_player_id, locked_rows')
      .in('id', gameIds)
      .eq('status', 'ended')
      .order('ended_at', { ascending: false })
      .limit(limit);

    if (cursor) {
      query = query.lt('ended_at', cursor);
    }

    const { data: games, error: gamesError } = await query;
    if (gamesError || !games) return jsonError(500, 'server_error', 'Something went wrong.');

    const resultGames = [];
    for (const game of games) {
      const { data: players } = await db
        .from('game_players')
        .select('player_id, seat, final_score')
        .eq('game_id', game.id)
        .order('seat', { ascending: true });

      const { data: sheets } = await db
        .from('sheets')
        .select('player_id, crosses, locks, penalties')
        .eq('game_id', game.id);

      const { data: playerRows } = await db
        .from('players')
        .select('id, display_name')
        .in('id', (players ?? []).map((p) => p.player_id));

      const displayNameById = new Map((playerRows ?? []).map((p) => [p.id, p.display_name]));
      const sheetByPlayer = new Map((sheets ?? []).map((s) => [s.player_id, s]));

      const gamePlayers = (players ?? []).map((p) => {
        const sheetRow = sheetByPlayer.get(p.player_id);
        const rows: Record<Color, number> = sheetRow
          ? scoreSheet({ crosses: sheetRow.crosses, locks: sheetRow.locks, penalties: sheetRow.penalties }).rows
          : { red: 0, yellow: 0, green: 0, blue: 0 };
        return {
          playerId: p.player_id,
          displayName: displayNameById.get(p.player_id) ?? 'Player',
          seat: p.seat,
          finalScore: p.final_score,
          rows,
          penalties: sheetRow?.penalties ?? 0,
        };
      });

      resultGames.push({
        gameId: game.id,
        code: game.join_code,
        endedAt: game.ended_at,
        endReason: game.end_reason,
        abandoned: game.end_reason === 'abandoned',
        winnerPlayerId: game.winner_player_id,
        youWon: game.winner_player_id === device.playerId,
        players: gamePlayers,
      });
    }

    const nextCursor =
      games.length === limit && games.length > 0 ? games[games.length - 1].ended_at : null;

    return Response.json({ games: resultGames, nextCursor });
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
