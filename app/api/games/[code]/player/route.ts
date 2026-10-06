import { db } from '@/lib/supabase/server';
import { requireSeat } from '@/lib/auth';
import { jsonError, parseBody } from '@/lib/apiError';
import { renamePlayerSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ code: string }> }) {
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

    const parsed = await parseBody(req, renamePlayerSchema);
    if (!parsed.ok) return parsed.response;

    const { data: game, error: gameError } = await db
      .from('games')
      .select('id, status')
      .eq('join_code', code)
      .maybeSingle();

    if (gameError || !game) {
      return jsonError(404, 'game_not_found', 'That game was not found.');
    }
    if (game.status !== 'lobby' && game.status !== 'active') {
      return jsonError(409, 'wrong_status', 'This game has ended.');
    }

    const { data: updated, error: updateError } = await db
      .from('players')
      .update({ display_name: parsed.data.displayName })
      .eq('id', auth.playerId)
      .select('display_name')
      .single();

    if (updateError || !updated) {
      return jsonError(500, 'server_error', 'Could not update your display name.');
    }

    const headers = new Headers();
    if (auth.setCookie) headers.append('Set-Cookie', auth.setCookie);

    return Response.json({ displayName: updated.display_name }, { headers });
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
