import { api, get } from '../http';

/**
 * Two-step verification on the signed-in account.
 *
 * Every mutation carries the password. That is not the API being awkward: the
 * session alone is exactly what is in question when someone adds a factor the owner
 * did not ask for, or removes the one protecting them.
 */

export interface TwoFactorStatus {
  enabled: boolean;
  enrolled_at: string | null;
  recovery_codes_left: number;
}

export const twoFactorStatus = (): Promise<TwoFactorStatus> =>
  get<TwoFactorStatus>('/api/v1/me/two-factor');

export const startTotpEnrolment = (password: string): Promise<{ secret: string; otpauth_uri: string }> =>
  api('/api/v1/me/totp', { method: 'POST', body: { password } });

/** The only call that turns it on — and the only time the recovery codes exist. */
export const confirmTotpEnrolment = (code: string): Promise<{ recovery_codes: string[] }> =>
  api('/api/v1/me/totp/verify', { method: 'POST', body: { code } });

export const disableTotp = (input: {
  password: string;
  totp?: string;
  recovery_code?: string;
}): Promise<{ ok: boolean }> => api('/api/v1/me/totp', { method: 'DELETE', body: input });

export const regenerateRecoveryCodes = (password: string): Promise<{ recovery_codes: string[] }> =>
  api('/api/v1/me/totp/recovery-codes', { method: 'POST', body: { password } });
