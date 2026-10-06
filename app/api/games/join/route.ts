import { db } from '@/lib/supabase/server';
import { ensureDevice, resolveDevice } from '@/lib/auth';
import { seatCookieHeader } from '@/lib/cookies';
import { normalizeJoinCode } from '@/lib/joincode';
import { emptySheet } from '@/lib/scoring';
import { jsonError, parseBody } from '@/lib/apiError';
import { joinGameSchema } from '@/lib/validation';
import { consume } from '@/lib/ratelimit';
import { clientIp, hashIp } from '@/lib/ipHash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IP_LIMIT = 10;
const DEVICE_LIMIT = 20;
const MAX_SEATS = 5;

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, joinGameSchema);
    if (!parsed.ok) return parsed.response;

    const normalizedCode = normalizeJoinCode(parsed.data.code);
    if (!normalizedCode) {
      return jsonError(400, 'bad_request', 'That is not a valid game code.');
    }
    const displayName = parsed.data.displayName;

    // Rate limit runs before any database read of games, so a scan for valid
    // codes is throttled before it can probe. In production, no
    // CF-Connecting-IP means the request did not arrive through the tunnel
    // (finding S7); fail closed rather than fall back to a spoofable header.
    const ip = clientIp(req);
    if (!ip && process.env.NODE_ENV === 'production') {
      return jsonError(400, 'bad_request', 'Unrecognised request origin.');
    }
    const ipKey = `ip:${hashIp(ip ?? 'local')}`;
    const ipResult = await consume(ipKey, IP_LIMIT);
    if (!ipResult.allowed) {
      return jsonError(
        429,
        'rate_limited',
        'Too many join attempts. Try again shortly.',
        { retryAfter: ipResult.retryAfter },
        { headers: { 'Retry-After': String(ipResult.retryAfter) } },
      );
    }

    const existingDevice = await resolveDevice(req);
    if (existingDevice) {
      const devKey = `dev:${existingDevice.playerId}`;
      const devResult = await consume(devKey, DEVICE_LIMIT);
      if (!devResult.allowed) {
        return jsonError(
          429,
          'rate_limited',
          'Too many join attempts. Try again shortly.',
          { retryAfter: devResult.retryAfter },
          { headers: { 'Retry-After': String(devResult.retryAfter) } },
        );
      }
    }

    const device = await ensureDevice(req);
    const headers = new Headers();
    if (device.setCookie) headers.append('Set-Cookie', device.setCookie);

    const { data: game, error: gameError } = await db
      .from('games')
      .select('id, status')
      .eq('join_code', normalizedCode)
      .neq('status', 'ended')
      .maybeSingle();

    if (gameError) return jsonError(500, 'server_error', 'Something went wrong.');
    if (!game) {
      return jsonError(404, 'game_not_found', 'That game code was not found.');
    }

    const { data: existingSeat } = await db
      .from('game_players')
      .select('seat')
      .eq('game_id', game.id)
      .eq('player_id', device.playerId)
      .maybeSingle();

    if (game.status === 'active') {
      if (existingSeat) {
        headers.append(
          'Set-Cookie',
          seatCookieHeader({
            gid: game.id,
            code: normalizedCode,
            pid: device.playerId,
            seat: existingSeat.seat,
            iat: Math.floor(Date.now() / 1000),
          }),
        );
        await db.from('players').update({ display_name: displayName }).eq('id', device.playerId);
        return Response.json(
          { code: normalizedCode, seat: existingSeat.seat, playerId: device.playerId, status: 'active' },
          { headers },
        );
      }
      return jsonError(409, 'wrong_status', 'This game has already started.');
    }

    // status === 'lobby'
    if (existingSeat) {
      await db.from('players').update({ display_name: displayName }).eq('id', device.playerId);
      headers.append(
        'Set-Cookie',
        seatCookieHeader({
          gid: game.id,
          code: normalizedCode,
          pid: device.playerId,
          seat: existingSeat.seat,
          iat: Math.floor(Date.now() / 1000),
        }),
      );
      return Response.json(
        { code: normalizedCode, seat: existingSeat.seat, playerId: device.playerId, status: 'lobby' },
        { headers },
      );
    }

    const { data: seatRows, error: seatsError } = await db
      .from('game_players')
      .select('seat')
      .eq('game_id', game.id);

    if (seatsError) return jsonError(500, 'server_error', 'Something went wrong.');

    const takenSeats = (seatRows ?? []).map((r) => r.seat);
    if (takenSeats.length >= MAX_SEATS) {
      return jsonError(409, 'game_full', 'This game already has five players.');
    }
    const nextSeat = takenSeats.length === 0 ? 1 : Math.max(...takenSeats) + 1;

    const { error: gpError } = await db
      .from('game_players')
      .insert({ game_id: game.id, player_id: device.playerId, seat: nextSeat });
    if (gpError) {
      if (gpError.code === '23505') {
        return jsonError(409, 'game_full', 'This game already has five players.');
      }
      return jsonError(500, 'server_error', 'Could not join the game.');
    }

    const empty = emptySheet();
    const { error: sheetError } = await db.from('sheets').insert({
      game_id: game.id,
      player_id: device.playerId,
      crosses: empty.crosses,
      locks: empty.locks,
      penalties: 0,
      version: 0,
    });
    if (sheetError) return jsonError(500, 'server_error', 'Could not create the score sheet.');

    await db.from('players').update({ display_name: displayName }).eq('id', device.playerId);

    headers.append(
      'Set-Cookie',
      seatCookieHeader({
        gid: game.id,
        code: normalizedCode,
        pid: device.playerId,
        seat: nextSeat,
        iat: Math.floor(Date.now() / 1000),
      }),
    );

    return Response.json(
      { code: normalizedCode, seat: nextSeat, playerId: device.playerId, status: 'lobby' },
      { headers },
    );
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
