/**
 * Client API minimal pour le backend Split. Le token JWT (stub de dev) est
 * conservé en mémoire/localStorage et attaché à chaque requête authentifiée.
 */

const TOKEN_STORAGE_KEY = 'split_token';
const USER_STORAGE_KEY = 'split_user';

export interface AuthUser {
  userId: string;
  username: string;
  balance: number;
}

export function getStoredAuth(): { token: string; user: AuthUser } | null {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  const rawUser = localStorage.getItem(USER_STORAGE_KEY);
  if (!token || !rawUser) return null;
  try {
    return { token, user: JSON.parse(rawUser) as AuthUser };
  } catch {
    return null;
  }
}

function storeAuth(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const stored = getStoredAuth();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (stored) {
    headers.Authorization = `Bearer ${stored.token}`;
  }

  const res = await fetch(`/api${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.message ?? body.error ?? 'Erreur inconnue');
  }
  return body as T;
}

export async function devLogin(username: string): Promise<AuthUser> {
  const body = await request<{ token: string; userId: string; username: string; balance: number }>(
    '/auth/dev-login',
    { method: 'POST', body: JSON.stringify({ username }) },
  );
  const user: AuthUser = { userId: body.userId, username: body.username, balance: body.balance };
  storeAuth(body.token, user);
  return user;
}

export interface StartGameResponse {
  gameId: string;
  balance: number;
  roundNumber: number;
  cumulativeMultiplier: number;
  status: 'active' | 'busted' | 'cashed_out';
}

export function startGame(betAmount: number): Promise<StartGameResponse> {
  return request('/split/start', { method: 'POST', body: JSON.stringify({ betAmount }) });
}

export interface PlayRoundResponse {
  roundNumber: number;
  chosenSide: 'left' | 'right';
  safeSide: 'left' | 'right';
  survived: boolean;
  cumulativeMultiplier: number;
  status: 'active' | 'busted' | 'cashed_out';
}

export function playRound(direction: 'left' | 'right'): Promise<PlayRoundResponse> {
  return request('/split/round', { method: 'POST', body: JSON.stringify({ direction }) });
}

export interface CashOutResponse {
  payout: number;
  balance: number;
  cumulativeMultiplier: number;
}

export function cashOut(): Promise<CashOutResponse> {
  return request('/split/cashout', { method: 'POST' });
}

export interface SessionInfo {
  id: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  isActive: boolean;
  revealedAt: string | null;
}

export function getSession(userId: string): Promise<SessionInfo> {
  return request(`/split/session/${userId}`);
}

export interface RotateSessionResponse {
  revealed: { sessionId: string; serverSeed: string; serverSeedHash: string; clientSeed: string; nonce: number } | null;
  next: SessionInfo;
}

export function rotateSession(clientSeed?: string): Promise<RotateSessionResponse> {
  return request('/split/session/rotate', { method: 'POST', body: JSON.stringify({ clientSeed }) });
}

export interface VerifyRoundInfo {
  roundNumber: number;
  chosenSide: 'left' | 'right';
  safeSide: 'left' | 'right';
  survived: boolean;
  hmac: string;
  valid: boolean;
}

export interface VerifySessionResponse {
  sessionId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  revealedAt: string | null;
  allRoundsValid: boolean;
  rounds: VerifyRoundInfo[];
}

export function verifySession(sessionId: string): Promise<VerifySessionResponse> {
  return request(`/split/verify/${sessionId}`);
}

export { ApiError };
