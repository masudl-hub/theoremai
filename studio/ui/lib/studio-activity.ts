/**
 * `transport`, calling `note` before each request it sends. `describe` only reads the profile,
 * so it doesn't count.
 */
export function noting<T extends object>(transport: T, note: () => void): T {
	return new Proxy(transport, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key);
			if (typeof value !== 'function' || key === 'describe') return value;
			return (...args: unknown[]): unknown => {
				note();
				return Reflect.apply(value, target, args);
			};
		},
	});
}
