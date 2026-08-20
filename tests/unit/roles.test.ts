import { describe, expect, it } from 'vitest';
import { manages } from '../../src/lib/server/perms';

/**
 * `manages()` is the whole boundary between two admins, so it is worth pinning down on its
 * own rather than only through the pages that call it. Everything the Users and Groups
 * routes do — reset a password, suspend, change a role, add someone to a group — goes
 * through this one predicate, because an admin who can reach an account can sign in as that
 * person and reach whichever sites they reach.
 */

const seat = { id: 'su', role: 'superadmin', createdByUserId: null };
const adminA = { id: 'a', role: 'admin', createdByUserId: 'su' };
const adminB = { id: 'b', role: 'admin', createdByUserId: 'su' };
const usersA = { id: 'ua', role: 'user', createdByUserId: 'a' };
const usersB = { id: 'ub', role: 'user', createdByUserId: 'b' };
const orphan = { id: 'old', role: 'user', createdByUserId: null };

describe('manages', () => {
	it('lets the superadmin administer everyone else', () => {
		expect(manages(seat, adminA)).toBe(true);
		expect(manages(seat, usersA)).toBe(true);
		expect(manages(seat, usersB)).toBe(true);
		expect(manages(seat, orphan)).toBe(true);
	});

	it('lets an admin administer the accounts it issued', () => {
		expect(manages(adminA, usersA)).toBe(true);
		expect(manages(adminB, usersB)).toBe(true);
	});

	// The hole this whole tier rests on closing: a password reset on somebody else's user
	// is a way into the sites that user reaches.
	it('stops an admin reaching another admin’s accounts', () => {
		expect(manages(adminA, usersB)).toBe(false);
		expect(manages(adminB, usersA)).toBe(false);
	});

	it('stops an admin reaching its peers', () => {
		expect(manages(adminA, adminB)).toBe(false);
		expect(manages(adminB, adminA)).toBe(false);
	});

	// The seat is not a row anybody edits — not suspended, not demoted, not reset. It moves
	// by being handed over, which is a different action with its own transaction.
	it('makes the superadmin untouchable, including by itself', () => {
		expect(manages(adminA, seat)).toBe(false);
		expect(manages(seat, seat)).toBe(false);
	});

	it('refuses everyone their own row', () => {
		expect(manages(adminA, adminA)).toBe(false);
		expect(manages(usersA, usersA)).toBe(false);
	});

	// Accounts that predate created_by_user_id, and anything the superadmin made, carry no
	// issuer. They stay the superadmin's rather than falling to whoever asks first.
	it('leaves unattributed accounts to the superadmin', () => {
		expect(manages(adminA, orphan)).toBe(false);
		expect(manages(adminB, orphan)).toBe(false);
		expect(manages(seat, orphan)).toBe(true);
	});

	it('gives a plain user nobody', () => {
		expect(manages(usersA, usersB)).toBe(false);
		expect(manages(usersA, orphan)).toBe(false);
		expect(manages(usersA, adminA)).toBe(false);
	});
});
