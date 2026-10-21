import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { badRequest } from './errors';

/**
 * Session cookie names. Over HTTPS the __Host- prefix makes browsers refuse the
 * cookie unless it is Secure, host-only and Path=/, so a subdomain can never
 * plant or overwrite it.
 */
export function cookieNames(secure: boolean) {
  return secure ? { user: '__Host-gullak_session', operator: '__Host-gullak_ops' } : { user: 'gullak_session', operator: 'gullak_ops' };
}

export function clearSessionCookie(reply: FastifyReply, name: string, secure: boolean): void {
  reply.clearCookie(name, { path: '/', secure, httpOnly: true, sameSite: 'strict' });
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    userId: string | null;
    operatorId: string | null;
    /** Set when the rate-limit key generator already validated the user session for this request. */
    sessionUserId?: string | null;
  }
}

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest('validation_error', first ? `${first.path.join('.') || 'request'}: ${first.message}` : 'Invalid request.', result.error.issues);
  }
  return result.data;
}

export function userIdOf(request: FastifyRequest): string {
  if (!request.userId) throw new Error('userIdOf called outside an authenticated scope');
  return request.userId;
}

export function operatorIdOf(request: FastifyRequest): string {
  if (!request.operatorId) throw new Error('operatorIdOf called outside an operator scope');
  return request.operatorId;
}

export function setSessionCookie(reply: FastifyReply, name: string, token: string, secure: boolean, maxAgeSeconds: number): void {
  reply.setCookie(name, token, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: maxAgeSeconds });
}
