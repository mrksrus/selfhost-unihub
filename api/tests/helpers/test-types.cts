// Tests deliberately supply partial database rows, malformed HTTP bodies and
// provider doubles. Keep their open shapes separate from production types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FixtureValue = any;

// The branches of a union result that carry a property, for a test asserting
// one known outcome of a call.
export type With<T, K extends PropertyKey> = Extract<T, Record<K, unknown>>;

// A route handler returns a union of its responses. When every member is an
// object literal, TypeScript lets a test read any member's property (the absent
// ones become `?: undefined`); a response built by a helper such as routeError()
// is not a literal and loses that. RouteTable restores the reading for a whole
// route module: `require(...) as RouteTable<typeof import('../src/routes/mail')>`.
type UnionKeys<U> = U extends unknown ? keyof U : never;
// `All` is computed from the whole union before the conditional distributes over its members.
type Normalized<U, All extends PropertyKey = UnionKeys<U>> = U extends unknown ? U & { [K in Exclude<All, keyof U>]?: undefined } : never;
// A module converted to route specs keeps the handler under `handler`.
type NormalizedHandler<H> = H extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<Normalized<R>> : H;
export type RouteTable<T> = { [K in keyof T]: T[K] extends { handler: infer H } ? Omit<T[K], 'handler'> & { handler: NormalizedHandler<H> } : NormalizedHandler<T[K]> };
