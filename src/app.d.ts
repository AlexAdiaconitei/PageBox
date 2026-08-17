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
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
