import { db } from '@/lib/supabase/server';
import { resolveDevice } from '@/lib/auth';
import { jsonError } from '@/lib/apiError';
import { scoreSheet, COLORS, type Color } from '@/lib/scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const device = await resolveDevice(req);
    if (!device) return jsonError(401, 'no_device', 'No device identity found.');

    const { data: myGamePlayers, error: gpError } = await db
      .from('game_players')
      .select('game_id, final_score')
      .eq('player_id', device.playerId);

    if (gpError) return jsonError(500, 'server_error', 'Something went wrong.');

    const gameIds = (myGamePlayers ?? []).map((r) => r.game_id);

    if (gameIds.length === 0) {
      return Response.json({
        playerId: device.playerId,
        displayName: device.displayName,
        gamesPlayed: 0,
        gamesWon: 0,
        winRate: 0,
        averageScore: 0,
        bestScore: 0,
        bestRow: null,
        abandonedGames: 0,
      });
    }

    const { data: games, error: gamesError } = await db
      .from('games')
      .select('id, status, end_reason, winner_player_id')
      .in('id', gameIds)
      .eq('status', 'ended');

    if (gamesError || !games) return jsonError(500, 'server_error', 'Something went wrong.');

    const abandonedGames = games.filter((g) => g.end_reason === 'abandoned').length;
    const countedGames = games.filter((g) => g.end_reason !== 'abandoned');

    const finalScoreByGame = new Map((myGamePlayers ?? []).map((r) => [r.game_id, r.final_score]));

    const gamesPlayed = countedGames.length;
    const gamesWon = countedGames.filter((g) => g.winner_player_id === device.playerId).length;
    const winRate = gamesPlayed === 0 ? 0 : gamesWon / gamesPlayed;

    const scores = countedGames.map((g) => finalScoreByGame.get(g.id) ?? 0);
    const averageScore =
      gamesPlayed === 0 ? 0 : Math.round((scores.reduce((sum, s) => sum + s, 0) / gamesPlayed) * 10) / 10;
    const bestScore = gamesPlayed === 0 ? 0 : Math.max(...scores);

    let bestRow: { color: Color; points: number } | null = null;
    if (countedGames.length > 0) {
      const { data: sheets } = await db
        .from('sheets')
        .select('game_id, crosses, locks, penalties')
        .eq('player_id', device.playerId)
        .in(
          'game_id',
          countedGames.map((g) => g.id),
        );

      for (const sheetRow of sheets ?? []) {
        const rows = scoreSheet({
          crosses: sheetRow.crosses,
          locks: sheetRow.locks,
          penalties: sheetRow.penalties,
        }).rows;
        for (const c of COLORS) {
          if (!bestRow || rows[c] > bestRow.points) {
            bestRow = { color: c, points: rows[c] };
          }
        }
      }
    }

    return Response.json({
      playerId: device.playerId,
      displayName: device.displayName,
      gamesPlayed,
      gamesWon,
      winRate,
      averageScore,
      bestScore,
      bestRow,
      abandonedGames,
    });
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
