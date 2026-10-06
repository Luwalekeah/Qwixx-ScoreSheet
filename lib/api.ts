// Typed fetch wrappers for every /api route. Browser only. Relative URLs
// only, never an absolute origin, per the tunnel hostname constraint.

import type { Color, LockedRows, RejectReason, Standing } from './scoring';
import type { QueuedMutation } from './idb';

export interface ApiErrorBody {
  error: string;
  message: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (res.status === 304) {
    return undefined as T;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? { error: 'server_error', message: 'Something went wrong.' });
  }

  return body as T;
}

export interface MeResponse {
  // null when the caller has no valid device cookie yet: GET /api/me is
  // read-only and never creates an identity as a side effect (finding S1).
  playerId: string | null;
  displayName: string | null;
  activeSeat: { code: string; seat: number } | null;
}

export function getMe(): Promise<MeResponse> {
  return request('/api/me');
}

export interface CreateGameResponse {
  code: string;
  seat: 1;
  playerId: string;
}

export function createGame(displayName: string): Promise<CreateGameResponse> {
  return request('/api/games', { method: 'POST', body: JSON.stringify({ displayName }) });
}

export interface JoinGameResponse {
  code: string;
  seat: number;
  playerId: string;
  status: 'lobby' | 'active';
}

export function joinGame(code: string, displayName: string): Promise<JoinGameResponse> {
  return request('/api/games/join', { method: 'POST', body: JSON.stringify({ code, displayName }) });
}

export interface GamePlayerView {
  playerId: string;
  seat: number;
  displayName: string;
  crosses: Record<Color, number[]>;
  locks: Record<Color, boolean>;
  penalties: number;
  version: number;
  rows: Record<Color, number>;
  total: number;
  finalScore: number | null;
  updatedAt: string;
}

export interface GameStateResponse {
  game: {
    code: string;
    status: 'lobby' | 'active' | 'ended';
    lockedRows: LockedRows;
    endReason: 'penalties' | 'two_locks' | 'abandoned' | 'host_ended' | null;
    winnerPlayerId: string | null;
    endedAt: string | null;
    hostPlayerId: string;
  };
  you: { playerId: string; seat: number; displayName: string; version: number };
  players: GamePlayerView[];
  standings: Standing[] | null;
}

export function getGame(code: string, etag?: string | null): Promise<GameStateResponse | undefined> {
  return request(`/api/games/${code}`, {
    headers: etag ? { 'If-None-Match': etag } : undefined,
  });
}

export function startGame(code: string): Promise<{ status: 'active' }> {
  return request(`/api/games/${code}/start`, { method: 'POST' });
}

export interface MutationsRequestBody {
  baseVersion: number;
  mutations: QueuedMutation[];
}

export interface MutationsResponse {
  version: number;
  sheet: { crosses: Record<Color, number[]>; locks: Record<Color, boolean>; penalties: number };
  lockedRows: LockedRows;
  gameStatus: 'active' | 'ended';
  endReason: 'penalties' | 'two_locks' | null;
}

export interface MutationErrorBody extends ApiErrorBody {
  version: number;
  sheet: { crosses: Record<Color, number[]>; locks: Record<Color, boolean>; penalties: number };
  lockedRows: LockedRows;
  gameStatus: 'active' | 'ended';
  index?: number;
  reason?: RejectReason;
}

export function postMutations(code: string, body: MutationsRequestBody): Promise<MutationsResponse> {
  return request(`/api/games/${code}/mutations`, { method: 'POST', body: JSON.stringify(body) });
}

export function renamePlayer(code: string, displayName: string): Promise<{ displayName: string }> {
  return request(`/api/games/${code}/player`, { method: 'PATCH', body: JSON.stringify({ displayName }) });
}

export function endGame(
  code: string,
): Promise<{ status: 'ended'; endReason: string; winnerPlayerId: string | null; standings: Standing[] }> {
  return request(`/api/games/${code}/end`, { method: 'POST' });
}

export interface HistoryResponse {
  games: Array<{
    gameId: string;
    code: string;
    endedAt: string;
    endReason: 'penalties' | 'two_locks' | 'abandoned' | 'host_ended';
    abandoned: boolean;
    winnerPlayerId: string | null;
    youWon: boolean;
    players: Array<{
      playerId: string;
      displayName: string;
      seat: number;
      finalScore: number | null;
      rows: Record<Color, number>;
      penalties: number;
    }>;
  }>;
  nextCursor: string | null;
}

export function getHistory(cursor?: string | null): Promise<HistoryResponse> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request(`/api/history${params}`);
}

export interface ProfileResponse {
  playerId: string;
  displayName: string;
  gamesPlayed: number;
  gamesWon: number;
  winRate: number;
  averageScore: number;
  bestScore: number;
  bestRow: { color: Color; points: number } | null;
  abandonedGames: number;
}

export function getProfile(): Promise<ProfileResponse> {
  return request('/api/profile');
}
