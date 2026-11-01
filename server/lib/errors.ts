export class HttpError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'unauthorized', message);
/** The message is shown to the user as the reason, e.g. "You own this task". */
export const forbidden = (message: string, code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'This item does not exist or you do not have access to it.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooMany = (message: string) => new HttpError(429, 'rate_limited', message);
export const unavailable = (message: string, code = 'unavailable') => new HttpError(503, code, message);
export const invalid = (fields: Record<string, string>, message = 'Check the highlighted fields.') => new HttpError(422, 'validation_failed', message, fields);
