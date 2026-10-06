import { db } from '@/lib/supabase/server';
import { requireSeat } from '@/lib/auth';
import { jsonError, parseBody } from '@/lib/apiError';
import { mutationsBatchSchema } from '@/lib/validation';
import { runEndOfGameWrite } from '@/lib/gameEnd';
import {
  applyCross,
  applyPenalty,
  undoCross,
  undoPenalty,
  checkGameEnd,
  emptySheet,
  COLORS,
  type Sheet,
  type LockedRows,
  type RejectReason,
  type GameState,
} from '@/lib/scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SheetDbShape {
  crosses: Sheet['crosses'];
  locks: Sheet['locks'];
  penalties: number;
}

function toSheet(row: SheetDbShape): Sheet {
  return { crosses: row.crosses, locks: row.locks, penalties: row.penalties };
}

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

    const parsed = await parseBody(req, mutationsBatchSchema);
    if (!parsed.ok) return parsed.response;
    const { baseVersion, mutations } = parsed.data;

    const { data: game, error: gameError } = await db
      .from('games')
      .select('id, status, locked_rows')
      .eq('join_code', code)
      .maybeSingle();

    // A transient read failure (e.g. a Supabase pod restart mid-rollout) is
    // not the same as the game genuinely not existing. Collapsing both into
    // 404 used to make lib/sync.ts treat a one-off blip as "you are no
    // longer in this game" and permanently delete the player's unsynced
    // queue (finding C4). Reserve 404 for a real, empty read.
    if (gameError) {
      return jsonError(500, 'server_error', 'Something went wrong.');
    }
    if (!game) {
      return jsonError(404, 'game_not_found', 'That game was not found.');
    }
    if (game.status !== 'active') {
      return jsonError(409, 'wrong_status', 'This game is not active.');
    }

    const { data: sheetRow, error: sheetError } = await db
      .from('sheets')
      .select('crosses, locks, penalties, version')
      .eq('game_id', game.id)
      .eq('player_id', auth.playerId)
      .maybeSingle();

    if (sheetError) {
      return jsonError(500, 'server_error', 'Something went wrong.');
    }
    if (!sheetRow) {
      return jsonError(404, 'game_not_found', 'That game was not found.');
    }

    if (sheetRow.version !== baseVersion) {
      return jsonError(409, 'version_conflict', 'The sheet changed since your last update.', {
        version: sheetRow.version,
        sheet: toSheet(sheetRow),
        lockedRows: game.locked_rows,
        gameStatus: game.status,
      });
    }

    let workingSheet: Sheet = toSheet(sheetRow);
    let workingLockedRows: LockedRows = game.locked_rows;

    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];
      try {
        if (mutation.type === 'mark') {
          const result = applyCross(workingSheet, workingLockedRows, mutation.color, mutation.index, auth.playerId);
          workingSheet = result.sheet;
          workingLockedRows = result.lockedRows;
        } else if (mutation.type === 'penalty') {
          workingSheet = applyPenalty(workingSheet);
        } else {
          // undo
          if (mutation.undoes.type === 'mark') {
            const result = undoCross(
              workingSheet,
              workingLockedRows,
              mutation.undoes.color,
              mutation.undoes.index,
              auth.playerId,
            );
            workingSheet = result.sheet;
            workingLockedRows = result.lockedRows;
          } else {
            workingSheet = undoPenalty(workingSheet);
          }
        }
      } catch (err) {
        const reason = (err instanceof Error ? err.message : 'nothing_to_undo') as RejectReason;
        return jsonError(422, 'mutation_rejected', 'A mutation in the batch was illegal.', {
          index: i,
          reason,
          version: sheetRow.version,
          sheet: toSheet(sheetRow),
          lockedRows: game.locked_rows,
          gameStatus: game.status,
        });
      }
    }

    const newVersion = baseVersion + 1;
    const { data: updatedSheet, error: updateSheetError } = await db
      .from('sheets')
      .update({
        crosses: workingSheet.crosses,
        locks: workingSheet.locks,
        penalties: workingSheet.penalties,
        updated_at: new Date().toISOString(),
        version: newVersion,
      })
      .eq('game_id', game.id)
      .eq('player_id', auth.playerId)
      .eq('version', baseVersion)
      .select('version')
      .maybeSingle();

    if (updateSheetError) return jsonError(500, 'server_error', 'Something went wrong.');
    if (!updatedSheet) {
      // Lost the optimistic-concurrency race. Re-read authoritative state.
      const { data: freshSheet } = await db
        .from('sheets')
        .select('crosses, locks, penalties, version')
        .eq('game_id', game.id)
        .eq('player_id', auth.playerId)
        .maybeSingle();
      return jsonError(409, 'version_conflict', 'The sheet changed since your last update.', {
        version: freshSheet?.version ?? sheetRow.version,
        sheet: freshSheet ? toSheet(freshSheet) : toSheet(sheetRow),
        lockedRows: game.locked_rows,
        gameStatus: game.status,
      });
    }

    const lockedRowsChanged = COLORS.some((c) => workingLockedRows[c] !== game.locked_rows[c]);
    if (lockedRowsChanged) {
      // A bare `update ... .eq('id', game.id)` here was a read-modify-write
      // with no compare-and-swap: two players locking two different colours
      // in overlapping requests both computed from the same stale
      // game.locked_rows, and the second write silently erased the first's
      // colour (finding C2). merge_locked_rows does a per-colour CAS in one
      // atomic statement: a colour is only overwritten with this request's
      // value if nobody else changed it since game.locked_rows was read
      // above; otherwise the concurrent writer's value is kept for that one
      // colour. The merged, authoritative result is what game-end detection
      // below must use, not this request's own possibly-stale computation.
      const { data: merged, error: mergeError } = await db.rpc('merge_locked_rows', {
        p_game_id: game.id,
        p_prev: game.locked_rows,
        p_next: workingLockedRows,
      });
      if (mergeError || !merged) return jsonError(500, 'server_error', 'Something went wrong.');
      workingLockedRows = merged as LockedRows;
    }

    const { data: otherPlayers, error: otherError } = await db
      .from('game_players')
      .select('player_id, seat')
      .eq('game_id', game.id);

    if (otherError || !otherPlayers) return jsonError(500, 'server_error', 'Something went wrong.');

    const { data: otherSheets, error: otherSheetsError } = await db
      .from('sheets')
      .select('player_id, crosses, locks, penalties')
      .eq('game_id', game.id);

    if (otherSheetsError || !otherSheets) return jsonError(500, 'server_error', 'Something went wrong.');

    const sheetsByPlayer = new Map(otherSheets.map((s) => [s.player_id, toSheet(s)]));
    sheetsByPlayer.set(auth.playerId, workingSheet);

    const gameState: GameState = {
      players: otherPlayers.map((p) => ({
        playerId: p.player_id,
        seat: p.seat,
        sheet: sheetsByPlayer.get(p.player_id) ?? emptySheet(),
      })),
      lockedRows: workingLockedRows,
    };

    const { ended, reason } = checkGameEnd(gameState);

    let gameStatus: 'active' | 'ended' = 'active';
    let endReason: 'penalties' | 'two_locks' | null = null;

    if (ended && reason) {
      await runEndOfGameWrite(game.id, gameState, reason);
      gameStatus = 'ended';
      endReason = reason;
    }

    const headers = new Headers();
    if (auth.setCookie) headers.append('Set-Cookie', auth.setCookie);

    return Response.json(
      {
        version: newVersion,
        sheet: { crosses: workingSheet.crosses, locks: workingSheet.locks, penalties: workingSheet.penalties },
        lockedRows: workingLockedRows,
        gameStatus,
        endReason,
      },
      { headers },
    );
  } catch {
    return jsonError(500, 'server_error', 'Something went wrong.');
  }
}
