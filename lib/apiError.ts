import 'server-only';
import type { ZodSchema } from 'zod';

// Shared error envelope for every non-2xx route handler response.

export type ErrorCode =
  | 'bad_request'
  | 'no_device'
  | 'not_seated'
  | 'not_host'
  | 'game_not_found'
  | 'wrong_status'
  | 'version_conflict'
  | 'game_full'
  | 'mutation_rejected'
  | 'rate_limited'
  | 'server_error';

export function errorBody(error: ErrorCode, message: string, extra?: Record<string, unknown>) {
  return { error, message, ...extra };
}

export function jsonError(
  status: number,
  error: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
  init?: ResponseInit,
): Response {
  return Response.json(errorBody(error, message, extra), { status, ...init });
}

export async function parseBody<T>(
  req: Request,
  schema: ZodSchema<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return {
      ok: false,
      response: jsonError(400, 'bad_request', 'The request body is not valid JSON.'),
    };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      response: jsonError(400, 'bad_request', 'The request body failed validation.', {
        detail: result.error.flatten(),
      }),
    };
  }

  return { ok: true, data: result.data };
}
