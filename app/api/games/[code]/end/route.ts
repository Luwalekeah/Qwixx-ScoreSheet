import { db } from '@/lib/supabase/server';
import { requireSeat } from '@/lib/auth';
import { jsonError } from '@/lib/apiError';
import { runEndOfGameWrite } from '@/lib/gameEnd';
import type { GameState, Sheet } from '@/lib/scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
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
    if (auth.seat !== 1) {
      return jsonError(403, 'not_host', 'Only the host can end the game.');
    }

    const { data: game, error: gameError } = await db
      .from('games')
      .select('id, status, locked_rows')
      .eq('join_code', code)
      .maybeSingle();

    if (gameError || !game) {
      return jsonError(404, 'game_not_found', 'That game was not found.');
    }
    if (game.status !== 'active') {
      return jsonError(409, 'wrong_status', 'This game is not active.');
    }

    const { data: players, error: playersError } = await db
      .from('game_players')
      .select('player_id, seat')
      .eq('game_id', game.id);

    if (playersError || !players) return jsonError(500, 'server_error', 'Something went wrong.');

    const { data: sheets, error: sheetsError } = await db
      .from('sheets')
      .select('player_id, crosses, locks, penalties')
      .eq('game_id', game.id);

    if (sheetsError || !sheets) return jsonError(500, 'server_error', 'Something went wrong.');

    const sheetByPlayer = new Map<string, Sheet>(
      sheets.map((s) => [s.player_id, { crosses: s.crosses, locks: s.locks, penalties: s.penalties }]),
    );

    const state: GameState = {
      players: players.map((p) => ({
        playerId: p.player_id,
        seat: p.seat,
        sheet: sheetByPlayer.get(p.player_id) ?? {
          crosses: { red: [], yellow: [], green: [], blue: [] },
          locks: { red: false, yellow: false, green: false, blue: false },
          penalties: 0,
        },
      })),
      lockedRows: game.locked_rows,
    };

    const { winnerPlayerId, standings } = await runEndOfGameWrite(game.id, state, 'host_ended');

    const headers = new Headers();
    if (auth.setCookie) headers.append('Set-Cookie', auth.setCookie);

    return Response.json(
      { status: 'ended', endReason: 'host_ended', winnerPlayerId, standings },
      { headers },
    );
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
