import type { SessionUser } from '$lib/server/auth';
import type { HostKind } from '$lib/server/config';

declare global {
	namespace App {
		interface Error {
			message: string;
			id?: string;
		}
		interface Locals {
			/** Which of the two hostnames this request arrived on. Set by hooks.server.ts. */
			hostKind: HostKind;
			/** Session user for *this host*; a session from the other host is not accepted. */
			user: SessionUser | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
