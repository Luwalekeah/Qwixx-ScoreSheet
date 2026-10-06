import { z } from 'zod';

const NO_CONTROL_CHARS = /^[^\x00-\x1f\x7f]*$/;

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a display name.')
  .max(24, 'Display names are 24 characters or fewer.')
  .refine((v) => NO_CONTROL_CHARS.test(v), 'Display names cannot contain control characters.');

export const createGameSchema = z.object({
  displayName: displayNameSchema,
});

export const joinGameSchema = z.object({
  code: z.string().min(1),
  displayName: displayNameSchema,
});

export const renamePlayerSchema = z.object({
  displayName: displayNameSchema,
});

export const mutationSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('mark'),
    color: z.enum(['red', 'yellow', 'green', 'blue']),
    index: z.number().int(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('penalty'),
  }),
  z.object({
    id: z.string(),
    type: z.literal('undo'),
    undoes: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('mark'),
        color: z.enum(['red', 'yellow', 'green', 'blue']),
        index: z.number().int(),
      }),
      z.object({
        type: z.literal('penalty'),
      }),
    ]),
  }),
]);

export const mutationsBatchSchema = z.object({
  baseVersion: z.number().int().min(0),
  mutations: z.array(mutationSchema).min(1).max(50),
});
