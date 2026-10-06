// Shared domain types and DB row types. No logic lives here.

export type Color = 'red' | 'yellow' | 'green' | 'blue';

export type GameStatus = 'lobby' | 'active' | 'ended';

export type EndReasonDb = 'penalties' | 'two_locks' | 'abandoned' | 'host_ended';

export interface PlayerRow {
  id: string;
  display_name: string;
  created_at: string;
}

export interface GameRow {
  id: string;
  join_code: string;
  status: GameStatus;
  created_at: string;
  ended_at: string | null;
  end_reason: EndReasonDb | null;
  winner_player_id: string | null;
  locked_rows: Record<Color, string | null>;
}

export interface GamePlayerRow {
  game_id: string;
  player_id: string;
  seat: number;
  claimed_at: string;
  final_score: number | null;
}

export interface SheetRow {
  game_id: string;
  player_id: string;
  crosses: Record<Color, number[]>;
  locks: Record<Color, boolean>;
  penalties: number;
  updated_at: string;
  version: number;
}
