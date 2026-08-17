import { cache } from './cache';
import { getConfig } from './config';

/**
 * Failure counter for credential endpoints.
 *
 * better-auth has its own rate limiter, but it lives in its HTTP handler — and PageBox
 * calls `auth.api.*` directly so the site host does not expose better-auth's route set.
 * Password guessing therefore has to be throttled here; without this the login form is
 * unlimited, which a quick loop against /login makes obvious.
 *
 * Only *failed* attempts count. Someone who knows their password can sign in as often as
 * they like; someone who does not gets ten tries per five minutes.
 *
 * The window is not atomic across replicas: with a shared Valkey two processes can
 * interleave and let an attempt or two through. That is an acceptable rounding error on a
 * limit whose job is to make guessing slow, not to be exact.
 */

export type LimitVerdict = { blocked: boolean; retryAfterSeconds: number };

type Window = { count: number; resetAt: number };

export type AttemptKey = {
	/** What is being guessed, e.g. `login:admin` or `password-change`. */
	scope: string;
	ip: string | null;
	/** Email or user id: the account being attacked. */
	identifier: string;
	limit?: number;
	windowSeconds?: number;
};

/**
 * Two counters per attempt: one for the caller and one for the account. The IP counter
 * stops one machine working through many accounts; the account counter stops many
 * machines working on one account. Either alone leaves the other attack open.
 */
function keysFor(attempt: AttemptKey): string[] {
	return [
		`rl:${attempt.scope}:ip:${attempt.ip ?? 'unknown'}`,
		`rl:${attempt.scope}:id:${attempt.identifier.toLowerCase()}`
	];
}

export async function isRateLimited(attempt: AttemptKey): Promise<LimitVerdict> {
	const limit = attempt.limit ?? getConfig().LOGIN_MAX_ATTEMPTS;
	const now = Date.now();

	for (const key of keysFor(attempt)) {
		const window = await cache.get<Window>(key);
		if (window && window.resetAt > now && window.count >= limit) {
			return {
				blocked: true,
				retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000))
			};
		}
	}
	return { blocked: false, retryAfterSeconds: 0 };
}

export async function recordFailedAttempt(attempt: AttemptKey): Promise<void> {
	const windowSeconds = attempt.windowSeconds ?? getConfig().LOGIN_WINDOW_SECONDS;
	const now = Date.now();

	for (const key of keysFor(attempt)) {
		const window = await cache.get<Window>(key);
		if (!window || window.resetAt <= now) {
			await cache.set(key, { count: 1, resetAt: now + windowSeconds * 1000 }, windowSeconds);
			continue;
		}
		const remaining = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
		await cache.set(key, { count: window.count + 1, resetAt: window.resetAt }, remaining);
	}
}
