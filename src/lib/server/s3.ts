import {
	CreateBucketCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { getConfig } from './config';
import { lazy } from './lazy';

/**
 * Garage and MinIO both need path-style addressing; virtual-host style is off by default
 * in Garage and needs extra DNS in MinIO. One client, both backends.
 */
export const s3 = lazy(() => {
	const config = getConfig();
	return new S3Client({
		endpoint: config.S3_ENDPOINT,
		region: config.S3_REGION,
		forcePathStyle: config.S3_FORCE_PATH_STYLE,
		credentials: {
			accessKeyId: config.S3_ACCESS_KEY,
			secretAccessKey: config.S3_SECRET_KEY
		}
	});
});

const bucket = () => getConfig().S3_BUCKET;

/** `sites/<siteId>/<deploymentId>/<path>` — deployments never overwrite each other. */
export function objectKey(siteId: string, deploymentId: string, path: string): string {
	return `sites/${siteId}/${deploymentId}/${path.replace(/^\/+/, '')}`;
}

export function deploymentPrefix(siteId: string, deploymentId: string): string {
	return `sites/${siteId}/${deploymentId}/`;
}

/** Everything a site holds, every deployment of it. Used when the site itself goes. */
export function sitePrefix(siteId: string): string {
	return `sites/${siteId}/`;
}

/**
 * Creates the bucket when missing, so `docker compose up` against a fresh MinIO works
 * with no manual step. On Garage the key usually lacks bucket-creation rights: that is
 * fine, we only report it.
 */
export async function ensureBucket(): Promise<'exists' | 'created'> {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: bucket() }));
		return 'exists';
	} catch (err) {
		const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
		if (status !== 404 && status !== 403 && status !== 301) throw err;
		if (status !== 404) {
			throw new Error(
				`bucket "${bucket()}" is not reachable with the configured credentials (HTTP ${status})`
			);
		}
		await s3.send(new CreateBucketCommand({ Bucket: bucket() }));
		return 'created';
	}
}

export type ObjectBody = {
	body: Readable;
	contentLength: number;
	etag?: string;
	lastModified?: Date;
	contentRange?: string;
	status: 200 | 206;
};

/** Range is passed straight through to S3 — never read a whole object to slice it. */
export async function getObject(key: string, range?: string): Promise<ObjectBody | null> {
	try {
		const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: range }));
		return {
			body: res.Body as Readable,
			contentLength: Number(res.ContentLength ?? 0),
			etag: res.ETag ?? undefined,
			lastModified: res.LastModified,
			contentRange: res.ContentRange,
			status: res.ContentRange ? 206 : 200
		};
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}

export type ObjectHead = { size: number; etag?: string; lastModified?: Date };

export async function headObject(key: string): Promise<ObjectHead | null> {
	try {
		const res = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
		return {
			size: Number(res.ContentLength ?? 0),
			etag: res.ETag ?? undefined,
			lastModified: res.LastModified
		};
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}

export async function putObject(
	key: string,
	body: Buffer | Uint8Array | Readable,
	opts: { contentType?: string; contentLength?: number } = {}
): Promise<void> {
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket(),
			Key: key,
			Body: body,
			ContentType: opts.contentType,
			ContentLength: opts.contentLength
		})
	);
}

/** Deletes every object under a prefix, in batches. Used to drop dead deployments. */
export async function deletePrefix(prefix: string): Promise<number> {
	let deleted = 0;
	let token: string | undefined;
	do {
		const listed = await s3.send(
			new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token })
		);
		const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
		if (keys.length) {
			await s3.send(
				new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys, Quiet: true } })
			);
			deleted += keys.length;
		}
		token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
	} while (token);
	return deleted;
}

function isNotFound(err: unknown): boolean {
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}
