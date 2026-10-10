// Tests deliberately supply partial database rows, malformed HTTP bodies and
// provider doubles. Keep their open shapes separate from production types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FixtureValue = any;

// The branches of a union result that carry a property, for a test asserting
// one known outcome of a call.
export type With<T, K extends PropertyKey> = Extract<T, Record<K, unknown>>;
