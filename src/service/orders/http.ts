import type { FastifyReply } from 'fastify';
import type { TransitionResult } from './repo.js';

/** Shared mapping from a transition result to an HTTP response, so every route reports conflicts identically. */
export function respond(reply: FastifyReply, result: TransitionResult, view: (o: object) => object = (o) => o) {
  switch (result.kind) {
    case 'ok':
      return { order: view(result.order) };
    case 'not_found':
      return reply.code(404).send({ error: 'not_found', message: 'No such order' });
    case 'conflict':
      return reply
        .code(409)
        .send({ error: result.code, message: result.message, currentStatus: result.currentStatus });
  }
}

export const MAX_REASON_LENGTH = 200;

/** Body schema fragment for an optional, length-limited cancellation reason. */
export const reasonSchema = { type: 'string', maxLength: MAX_REASON_LENGTH } as const;

/** Trim; blank means no reason. */
export function cleanReason(reason: string | undefined): string | null {
  return reason?.trim() || null;
}
