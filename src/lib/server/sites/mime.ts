/**
 * Content-Type comes from our own extension table, never from the S3 object metadata:
 * the uploader controls that metadata, and a `text/html` label on an attacker-chosen file
 * is exactly the primitive we do not want to hand out.
 *
 * Unknown extensions get `application/octet-stream`, which browsers download instead of
 * rendering — the safe direction to be wrong in.
 */

const TYPES: Record<string, string> = {
	// documents
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	xhtml: 'application/xhtml+xml; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	pdf: 'application/pdf',
	// code
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	cjs: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	map: 'application/json; charset=utf-8',
	wasm: 'application/wasm',
	xml: 'application/xml; charset=utf-8',
	xsl: 'application/xml; charset=utf-8',
	csv: 'text/csv; charset=utf-8',
	// images
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	bmp: 'image/bmp',
	// fonts
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	eot: 'application/vnd.ms-fontobject',
	// media
	mp4: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	flac: 'audio/flac',
	// data / misc
	webmanifest: 'application/manifest+json',
	manifest: 'application/manifest+json',
	zip: 'application/zip',
	gz: 'application/gzip',
	br: 'application/octet-stream',
	atom: 'application/atom+xml',
	rss: 'application/rss+xml',
	vtt: 'text/vtt; charset=utf-8'
};

export const DEFAULT_TYPE = 'application/octet-stream';

/** Extension of a path in lower case, without the dot. '' when there is none. */
export function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function contentTypeFor(path: string): string {
	return TYPES[extensionOf(path)] ?? DEFAULT_TYPE;
}

/** Text-ish types worth looking for a precompressed `.br`/`.gz` sibling of. */
const COMPRESSIBLE = new Set([
	'html',
	'htm',
	'js',
	'mjs',
	'cjs',
	'css',
	'json',
	'map',
	'svg',
	'xml',
	'txt',
	'md',
	'csv',
	'wasm',
	'webmanifest'
]);

export function isCompressible(path: string): boolean {
	return COMPRESSIBLE.has(extensionOf(path));
}

export function isHtml(path: string): boolean {
	const ext = extensionOf(path);
	return ext === 'html' || ext === 'htm';
}
