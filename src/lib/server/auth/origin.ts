import type { RequestEvent } from '@sveltejs/kit';
import { config, type HostKind } from '../config';

export function sameOriginMutation(event: RequestEvent, kind: HostKind): boolean {
	if (['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)) return true;
	const api = event.url.pathname.startsWith('/api/v1/');
	if (
		kind === 'admin' &&
		api &&
		/^Bearer /i.test(event.request.headers.get('authorization') ?? '')
	) {
		return true;
	}
	const host = kind === 'admin' ? config.PAGEBOX_ADMIN_HOST : config.PAGEBOX_SITES_HOST;
	try {
		return (
			new URL(event.request.headers.get('origin') ?? '').origin ===
			`${config.PAGEBOX_PUBLIC_SCHEME}://${host}`
		);
	} catch {
		return false;
	}
}
