export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string>;

  constructor(status: number, code: string, details: Record<string, string> = {}) {
    super(code);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
