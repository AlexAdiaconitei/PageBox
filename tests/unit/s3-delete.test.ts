import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { deletePrefix } from '../../src/lib/server/s3';

afterEach(() => vi.restoreAllMocks());
describe('partial S3 deletes', () => {
	it('refuses an HTTP-success response containing per-object errors', async () => {
		vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
			if (command instanceof ListObjectsV2Command)
				return { Contents: [{ Key: 'fixture/a' }, { Key: 'fixture/b' }] };
			if (command instanceof DeleteObjectsCommand)
				return { Errors: [{ Key: 'fixture/b', Code: 'AccessDenied' }] };
			throw new Error('Unexpected command');
		});
		await expect(deletePrefix('fixture/')).rejects.toThrow('AccessDenied');
	});
	it('counts only completed batches', async () => {
		vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
			if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: 'fixture/a' }] };
			return {};
		});
		expect(await deletePrefix('fixture/')).toBe(1);
	});
});
