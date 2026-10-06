import { db } from '@/lib/supabase/server';
import { resolveDevice } from '@/lib/auth';
import { verifyCookie, SEAT_COOKIE_NAME, SEAT_COOKIE_MAX_AGE, type SeatCookiePayload } from '@/lib/cookies';
import { jsonError } from '@/lib/apiError';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Read-only. A GET must never create state: identity is created only by
 * POST /api/games and POST /api/games/join. This route used to call
 * ensureDevice(), which inserted a qwixx.players row for any caller with no
 * valid device cookie -- including crawlers, link-preview bots, and prefetch,
 * none of which carry a cookie. Unlimited unauthenticated row creation in a
 * database shared with other services was a storage-exhaustion risk on the
 * cluster (finding S1). A caller with no device identity yet simply gets a
 * null identity here, exactly like /api/profile and /api/history already do.
 */
export async function GET(req: Request) {
  try {
    const device = await resolveDevice(req);
    if (!device) {
      return Response.json({ playerId: null, displayName: null, activeSeat: null });
    }

    let activeSeat: { code: string; seat: number } | null = null;
    const seatRaw = readCookie(req, SEAT_COOKIE_NAME);
    const seatPayload = verifyCookie<SeatCookiePayload>(seatRaw, SEAT_COOKIE_MAX_AGE);
    // The seat cookie must belong to THIS device. resolveSeat() enforces
    // seatPayload.pid === device.playerId (lib/auth.ts) and this route did
    // not, so a captured qx_seat paired with any qx_device disclosed that
    // player's game code and seat number. The game code is the join
    // credential, so that is a real leak (finding L1).
    if (seatPayload && seatPayload.pid === device.playerId) {
      const { data: game } = await db
        .from('games')
        .select('status')
        .eq('id', seatPayload.gid)
        .maybeSingle();
      if (game && (game.status === 'lobby' || game.status === 'active')) {
        activeSeat = { code: seatPayload.code, seat: seatPayload.seat };
      }
    }

    return Response.json({ playerId: device.playerId, displayName: device.displayName, activeSeat });
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
