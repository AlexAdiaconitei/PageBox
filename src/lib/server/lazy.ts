/**
 * Defers construction of a singleton until it is first used.
 *
 * Needed because SvelteKit imports every server module during `vite build`: a client, a
 * pool or a parsed config created at import time would be constructed on a build machine
 * that has no database, no S3 and no environment. Methods are bound to the real instance
 * so classes with private fields keep working through the proxy.
 */
export function lazy<T extends object>(factory: () => T): T {
	let instance: T | undefined;
	const get = () => (instance ??= factory());

	return new Proxy({} as T, {
		get(_target, prop, receiver) {
			const target = get();
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
		set(_target, prop, value) {
			return Reflect.set(get(), prop, value);
		},
		has(_target, prop) {
			return Reflect.has(get(), prop);
		},
		ownKeys() {
			return Reflect.ownKeys(get());
		},
		getOwnPropertyDescriptor(_target, prop) {
			const descriptor = Reflect.getOwnPropertyDescriptor(get(), prop);
			// Proxy invariants: reported keys must look configurable on a fresh target.
			return descriptor ? { ...descriptor, configurable: true } : undefined;
		}
	});
}
