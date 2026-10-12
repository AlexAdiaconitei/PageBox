import { decodeSubpath, isForbiddenPath } from '../sites/paths';

const invalidPath = (value: string) =>
	!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value);

export function safeLoginDestination(
	value: string | null,
	kind: 'admin' | 'sites',
	prefix: string
): string {
	if (!value || invalidPath(value)) return '/';
	try {
		const url = new URL(value, 'https://login.invalid');
		if (url.origin !== 'https://login.invalid' || decodeSubpath(url.pathname.slice(1)) === null)
			return '/';
		if (kind === 'sites' && url.pathname !== '/access' && !url.pathname.startsWith(prefix + '/'))
			return '/';
		return url.pathname + url.search;
	} catch {
		return '/';
	}
}

export function safeReaderDestination(
	value: string | null,
	address: { origin: string; basePath: string }
): string {
	if (!value || invalidPath(value)) return address.basePath;
	try {
		const url = new URL(value, address.origin);
		if (url.origin !== new URL(address.origin).origin) return address.basePath;
		if (url.pathname === address.basePath.slice(0, -1)) return address.basePath + url.search;
		if (!url.pathname.startsWith(address.basePath)) return address.basePath;
		const subpath = decodeSubpath(url.pathname.slice(address.basePath.length));
		if (subpath === null || isForbiddenPath(subpath)) return address.basePath;
		return url.pathname + url.search;
	} catch {
		return address.basePath;
	}
}
