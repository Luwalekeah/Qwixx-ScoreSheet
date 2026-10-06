import 'server-only';
import { db } from './supabase/server';
import {
  verifyCookie,
  seatCookieHeader,
  deviceCookieHeader,
  DEVICE_COOKIE_NAME,
  SEAT_COOKIE_NAME,
  DEVICE_COOKIE_MAX_AGE,
  SEAT_COOKIE_MAX_AGE,
  type DeviceCookiePayload,
  type SeatCookiePayload,
} from './cookies';

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function resolveDevice(
  req: Request,
): Promise<{ playerId: string; displayName: string } | null> {
  const raw = readCookie(req, DEVICE_COOKIE_NAME);
  const payload = verifyCookie<DeviceCookiePayload>(raw, DEVICE_COOKIE_MAX_AGE);
  if (!payload) return null;

  const { data, error } = await db
    .from('players')
    .select('id, display_name')
    .eq('id', payload.pid)
    .maybeSingle();

  if (error || !data) return null;

  return { playerId: data.id, displayName: data.display_name };
}

/**
 * Bootstraps a device identity. If qx_device verifies and resolves to a real
 * players row, returns it with no cookie to set. Otherwise inserts a new
 * qwixx.players row with display_name 'Player' and returns a Set-Cookie the
 * caller must attach to its response.
 */
export async function ensureDevice(
  req: Request,
): Promise<{ playerId: string; displayName: string; setCookie: string | null }> {
  const existing = await resolveDevice(req);
  if (existing) return { ...existing, setCookie: null };

  const { data, error } = await db
    .from('players')
    .insert({ display_name: 'Player' })
    .select('id, display_name')
    .single();

  if (error || !data) {
    throw new Error(`failed to create device identity: ${error?.message ?? 'no data'}`);
  }

  const setCookie = deviceCookieHeader({ pid: data.id, iat: Math.floor(Date.now() / 1000) });

  return { playerId: data.id, displayName: data.display_name, setCookie };
}

export async function resolveSeat(
  req: Request,
  code: string,
): Promise<{ gameId: string; playerId: string; seat: number; setCookie: string | null } | null> {
  const device = await resolveDevice(req);
  if (!device) return null;

  const seatRaw = readCookie(req, SEAT_COOKIE_NAME);
  const seatPayload = verifyCookie<SeatCookiePayload>(seatRaw, SEAT_COOKIE_MAX_AGE);
  if (seatPayload && seatPayload.code === code && seatPayload.pid === device.playerId) {
    return {
      gameId: seatPayload.gid,
      playerId: device.playerId,
      seat: seatPayload.seat,
      setCookie: null,
    };
  }

  const { data: game, error: gameError } = await db
    .from('games')
    .select('id')
    .eq('join_code', code)
    .maybeSingle();

  if (gameError || !game) return null;

  const { data: gp, error: gpError } = await db
    .from('game_players')
    .select('seat')
    .eq('game_id', game.id)
    .eq('player_id', device.playerId)
    .maybeSingle();

  if (gpError || !gp) return null;

  const setCookie = seatCookieHeader({
    gid: game.id,
    code,
    pid: device.playerId,
    seat: gp.seat,
    iat: Math.floor(Date.now() / 1000),
  });

  return { gameId: game.id, playerId: device.playerId, seat: gp.seat, setCookie };
}

export type SeatAuthResult =
  | { ok: true; gameId: string; playerId: string; seat: number; setCookie: string | null }
  | { ok: false; status: 401 | 403; error: 'no_device' | 'not_seated' };

/**
 * Combines resolveDevice and resolveSeat into the two distinct failure modes
 * every route handler under /api/games/[code]/* needs: 401 when the device
 * cookie itself is missing or invalid, 403 when the device is real but holds
 * no seat in this game.
 */
export async function requireSeat(req: Request, code: string): Promise<SeatAuthResult> {
  const device = await resolveDevice(req);
  if (!device) return { ok: false, status: 401, error: 'no_device' };

  const seat = await resolveSeat(req, code);
  if (!seat) return { ok: false, status: 403, error: 'not_seated' };

  return { ok: true, ...seat };
}
