import { db } from '@/lib/supabase/server';
import { requireSeat } from '@/lib/auth';
import { jsonError } from '@/lib/apiError';
import { scoreSheet, resolveWinners, COLORS, type Color, type GameState } from '@/lib/scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function lockedRowsHash(lockedRows: Record<Color, string | null>): string {
  return COLORS.map((c) => `${c}=${lockedRows[c] ?? '-'}`).join(',');
}

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;

  try {
    const auth = await requireSeat(req, code);
    if (!auth.ok) {
      return jsonError(
        auth.status,
        auth.error,
        auth.error === 'no_device' ? 'No device identity found.' : 'You are not seated in this game.',
      );
    }

    const { data: game, error: gameError } = await db
      .from('games')
      .select('id, join_code, status, locked_rows, end_reason, winner_player_id, ended_at')
      .eq('join_code', code)
      .maybeSingle();

    if (gameError || !game) {
      return jsonError(404, 'game_not_found', 'That game was not found.');
    }

    const { data: gamePlayers, error: gpError } = await db
      .from('game_players')
      .select('player_id, seat, final_score')
      .eq('game_id', game.id)
      .order('seat', { ascending: true });

    if (gpError || !gamePlayers) {
      return jsonError(500, 'server_error', 'Something went wrong.');
    }

    const hostRow = gamePlayers.find((p) => p.seat === 1);
    if (!hostRow) {
      return jsonError(500, 'server_error', 'This game has no host.');
    }

    const playerIds = gamePlayers.map((p) => p.player_id);

    const { data: playerRows, error: playerRowsError } = await db
      .from('players')
      .select('id, display_name')
      .in('id', playerIds);

    if (playerRowsError || !playerRows) {
      return jsonError(500, 'server_error', 'Something went wrong.');
    }

    const { data: sheetRows, error: sheetRowsError } = await db
      .from('sheets')
      .select('player_id, crosses, locks, penalties, version, updated_at')
      .eq('game_id', game.id);

    if (sheetRowsError || !sheetRows) {
      return jsonError(500, 'server_error', 'Something went wrong.');
    }

    const displayNameById = new Map(playerRows.map((p) => [p.id, p.display_name]));
    const sheetById = new Map(sheetRows.map((s) => [s.player_id, s]));

    const maxUpdatedAtMs = sheetRows.reduce((max, s) => {
      const t = new Date(s.updated_at).getTime();
      return t > max ? t : max;
    }, 0);

    const etag = `W/"${game.status}:${lockedRowsHash(game.locked_rows)}:${maxUpdatedAtMs}:${gamePlayers.length}"`;
    const ifNoneMatch = req.headers.get('if-none-match');
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-store' } });
    }

    const players = gamePlayers.map((gp) => {
      const sheet = sheetById.get(gp.player_id);
      const sheetShape = sheet
        ? { crosses: sheet.crosses, locks: sheet.locks, penalties: sheet.penalties }
        : { crosses: { red: [], yellow: [], green: [], blue: [] }, locks: { red: false, yellow: false, green: false, blue: false }, penalties: 0 };
      const score = scoreSheet(sheetShape);
      return {
        playerId: gp.player_id,
        seat: gp.seat,
        displayName: displayNameById.get(gp.player_id) ?? 'Player',
        crosses: sheetShape.crosses,
        locks: sheetShape.locks,
        penalties: sheetShape.penalties,
        version: sheet?.version ?? 0,
        rows: score.rows,
        total: score.total,
        finalScore: gp.final_score,
        updatedAt: sheet?.updated_at ?? new Date(0).toISOString(),
      };
    });

    const you = players.find((p) => p.playerId === auth.playerId);
    if (!you) {
      return jsonError(403, 'not_seated', 'You are not seated in this game.');
    }

    let standings = null;
    if (game.status === 'ended') {
      const state: GameState = {
        players: gamePlayers.map((gp) => {
          const sheet = sheetById.get(gp.player_id);
          const sheetShape = sheet
            ? { crosses: sheet.crosses, locks: sheet.locks, penalties: sheet.penalties }
            : { crosses: { red: [], yellow: [], green: [], blue: [] }, locks: { red: false, yellow: false, green: false, blue: false }, penalties: 0 };
          return { playerId: gp.player_id, seat: gp.seat, sheet: sheetShape };
        }),
        lockedRows: game.locked_rows,
      };
      standings = resolveWinners(state).standings;
    }

    const body = {
      game: {
        code: game.join_code,
        status: game.status,
        lockedRows: game.locked_rows,
        endReason: game.end_reason,
        winnerPlayerId: game.winner_player_id,
        endedAt: game.ended_at,
        hostPlayerId: hostRow.player_id,
      },
      you: { playerId: you.playerId, seat: you.seat, displayName: you.displayName, version: you.version },
      players,
      standings,
    };

    const headers = new Headers();
    if (auth.setCookie) headers.append('Set-Cookie', auth.setCookie);
    headers.set('ETag', etag);
    headers.set('Cache-Control', 'no-store');

    return Response.json(body, { headers });
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
