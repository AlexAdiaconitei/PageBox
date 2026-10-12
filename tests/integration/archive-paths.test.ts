import { siteRequest } from './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import {
	actionResult,
	buildZip,
	configured,
	post,
	request,
	signIn,
	sitesHost,
	tag,
	upload,
	type Jar
} from './helpers';

const run = configured ? describe : describe.skip;
run('archive and serving path regressions', () => {
	const slug = `paths-${tag()}`;
	let jar: Jar;
	beforeAll(async () => {
		jar = await signIn();
		expect(
			(
				await actionResult(
					await post('/sites?/create', jar, { slug, name: slug, visibility: 'public' })
				)
			).type
		).toBe('redirect');
	});
	it('serves encoded names and stores no hidden content', async () => {
		const result = await upload(
			slug,
			buildZip({
				'out/index.html': 'public',
				'out/hello world.txt': 'space',
				'out/café.txt': 'unicode',
				'out/.env': 'secret',
				'.git/config': 'secret'
			}),
			{ jar }
		);
		expect(result.status).toBe(201);
		expect(result.body.root).toBe('out');
		expect(result.body.fileCount).toBe(3);
		for (const [name, body] of [
			['hello%20world.txt', 'space'],
			['caf%C3%A9.txt', 'unicode']
		]) {
			const res = await siteRequest(`/s/${slug}/${name}`, { host: sitesHost });
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(body);
		}
		for (const path of ['config', '.env', '%2eenv', 'a%2fb.txt', 'a%5cb.txt', '%252eenv']) {
			expect((await siteRequest(`/s/${slug}/${path}`, { host: sitesHost })).status, path).toBe(404);
		}
	});
	it('rejects a hidden-only ZIP without replacing the active deployment', async () => {
		const result = await upload(
			slug,
			buildZip({ '.git/config': 'secret', '.git/HEAD': 'secret' }),
			{ jar }
		);
		expect(result.status).toBe(400);
		expect(result.body.reason).toBe('empty');
		expect(await (await siteRequest(`/s/${slug}/`, { host: sitesHost })).text()).toBe('public');
	});
	it('keeps partial precompression working after a sibling miss', async () => {
		const body = 'compressed-asset-marker';
		const zip = zipSync(
			{
				'index.html': strToU8('partial'),
				'plain.js': strToU8('plain'),
				'encoded.js': strToU8(body),
				'encoded.js.br': brotliCompressSync(strToU8(body))
			},
			{ level: 0 }
		);
		expect((await upload(slug, zip, { jar })).status).toBe(201);
		const plain = await siteRequest(`/s/${slug}/plain.js`, {
			host: sitesHost,
			headers: { 'accept-encoding': 'br' }
		});
		expect(plain.headers.get('content-encoding')).toBeNull();
		expect(plain.headers.get('vary')).toContain('Accept-Encoding');
		const encoded = await siteRequest(`/s/${slug}/encoded.js`, {
			host: sitesHost,
			headers: { 'accept-encoding': 'br' }
		});
		expect(encoded.headers.get('content-encoding')).toBe('br');
		expect(await encoded.text()).toBe(body);
	});

	it('uses an accepted gzip sibling when brotli is unavailable', async () => {
		const body = 'gzip-fallback-marker';
		const zip = zipSync(
			{
				'index.html': strToU8('fallback'),
				'fallback.js': strToU8(body),
				'fallback.js.gz': gzipSync(strToU8(body))
			},
			{ level: 0 }
		);
		expect((await upload(slug, zip, { jar })).status).toBe(201);
		const response = await siteRequest(`/s/${slug}/fallback.js`, {
			headers: { 'accept-encoding': 'br, gzip' }
		});
		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(await response.text()).toBe(body);
	});
});
