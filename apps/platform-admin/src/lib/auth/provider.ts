import type { AuthSession } from '@agentos/ui-foundation/auth';

export interface SignInResult {
  readonly session: AuthSession;
  readonly sessionId: string;
  readonly cookieValue: string;
  readonly csrfToken: string;
  readonly cookieExpiresAt: string;
}

export interface AuthProvider {
  signIn(email: string, password: string): Promise<SignInResult>;
  getSession(request: Request): Promise<AuthSession | null>;
  signOut(request: Request): Promise<void>;
}

export class AuthProviderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: string;

  constructor(status: number, code: string, retryAfter?: string) {
    super(code);
    this.name = 'AuthProviderError';
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export class ExpiredSessionError extends AuthProviderError {
  constructor() {
    super(401, 'expired');
    this.name = 'ExpiredSessionError';
  }
}
