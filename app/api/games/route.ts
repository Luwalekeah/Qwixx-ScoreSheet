import { db } from '@/lib/supabase/server';
import { ensureDevice } from '@/lib/auth';
import { seatCookieHeader } from '@/lib/cookies';
import { generateJoinCode } from '@/lib/joincodeGenerate';
import { emptySheet, emptyLockedRows } from '@/lib/scoring';
import { jsonError, parseBody } from '@/lib/apiError';
import { createGameSchema } from '@/lib/validation';
import { consume } from '@/lib/ratelimit';
import { clientIp, hashIp } from '@/lib/ipHash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CODE_ATTEMPTS = 5;
const CREATE_IP_LIMIT = 5;

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, createGameSchema);
    if (!parsed.ok) return parsed.response;
    const { displayName } = parsed.data;

    // ensureDevice() commits a qwixx.players row for any caller with no
    // valid device cookie, and this route commits three more rows after it.
    // Unauthenticated, unbounded row creation in a Postgres instance shared
    // with other services is an availability problem for those services,
    // not just for this app (finding S1).
    const ip = clientIp(req);
    if (!ip && process.env.NODE_ENV === 'production') {
      return jsonError(400, 'bad_request', 'Unrecognised request origin.');
    }
    const createLimit = await consume(`create:${hashIp(ip ?? 'local')}`, CREATE_IP_LIMIT);
    if (!createLimit.allowed) {
      return jsonError(
        429,
        'rate_limited',
        'Too many games created. Try again shortly.',
        { retryAfter: createLimit.retryAfter },
        { headers: { 'Retry-After': String(createLimit.retryAfter) } },
      );
    }

    const device = await ensureDevice(req);

    await db.from('players').update({ display_name: displayName }).eq('id', device.playerId);

    let code: string | null = null;
    let gameId: string | null = null;

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const candidate = generateJoinCode();
      const { data, error } = await db
        .from('games')
        .insert({
          join_code: candidate,
          status: 'lobby',
          locked_rows: emptyLockedRows(),
        })
        .select('id')
        .single();

      if (!error && data) {
        code = candidate;
        gameId = data.id;
        break;
      }

      // 23505 is a unique violation on the live join_code index. Retry with a
      // fresh code. Any other error is fatal.
      if (error && error.code !== '23505') {
        return jsonError(500, 'server_error', 'Could not create the game.');
      }
    }

    if (!code || !gameId) {
      return jsonError(500, 'server_error', 'Could not generate a unique game code.');
    }

    const { error: gpError } = await db
      .from('game_players')
      .insert({ game_id: gameId, player_id: device.playerId, seat: 1 });
    if (gpError) return jsonError(500, 'server_error', 'Could not seat the host.');

    const emptySheetValue = emptySheet();
    const { error: sheetError } = await db.from('sheets').insert({
      game_id: gameId,
      player_id: device.playerId,
      crosses: emptySheetValue.crosses,
      locks: emptySheetValue.locks,
      penalties: 0,
      version: 0,
    });
    if (sheetError) return jsonError(500, 'server_error', 'Could not create the score sheet.');

    const headers = new Headers();
    if (device.setCookie) headers.append('Set-Cookie', device.setCookie);
    headers.append(
      'Set-Cookie',
      seatCookieHeader({
        gid: gameId,
        code,
        pid: device.playerId,
        seat: 1,
        iat: Math.floor(Date.now() / 1000),
      }),
    );

    return Response.json({ code, seat: 1, playerId: device.playerId }, { status: 201, headers });
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
