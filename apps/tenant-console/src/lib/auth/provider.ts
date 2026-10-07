import type { AuthSession } from '@agentos/ui-foundation/auth';

export interface SignInResult {
  readonly accessToken: string;
  readonly session: AuthSession;
}

export interface AuthProvider {
  signIn(email: string, password: string): Promise<SignInResult>;
  getSession(request: Request): Promise<AuthSession | null>;
  signOut(request: Request): Promise<void>;
}
