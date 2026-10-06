import { db } from '@/lib/supabase/server';
import { requireSeat } from '@/lib/auth';
import { jsonError } from '@/lib/apiError';

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
      return jsonError(403, 'not_host', 'Only the host can start the game.');
    }

    const { data: game, error: gameError } = await db
      .from('games')
      .select('id, status')
      .eq('join_code', code)
      .maybeSingle();

    if (gameError || !game) {
      return jsonError(404, 'game_not_found', 'That game was not found.');
    }
    if (game.status !== 'lobby') {
      return jsonError(409, 'wrong_status', 'This game has already started.');
    }

    const { count, error: countError } = await db
      .from('game_players')
      .select('*', { count: 'exact', head: true })
      .eq('game_id', game.id);

    if (countError) return jsonError(500, 'server_error', 'Something went wrong.');
    if (!count || count < 2 || count > 5) {
      return jsonError(409, 'wrong_status', 'A game needs at least two players.');
    }

    const { data: updated, error: updateError } = await db
      .from('games')
      .update({ status: 'active' })
      .eq('id', game.id)
      .eq('status', 'lobby')
      .select('id')
      .maybeSingle();

    if (updateError) return jsonError(500, 'server_error', 'Something went wrong.');
    if (!updated) {
      return jsonError(409, 'wrong_status', 'This game has already started.');
    }

    const headers = new Headers();
    if (auth.setCookie) headers.append('Set-Cookie', auth.setCookie);

    return Response.json({ status: 'active' }, { headers });
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
