export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this.') => new AppError(403, 'forbidden', message);
/** Used for missing *and* not-owned resources so ownership never leaks existence. */
export const notFound = (message = 'We could not find that.') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
export const tooManyRequests = (message: string) => new AppError(429, 'rate_limited', message);
