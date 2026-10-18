// mail_engine_jobs.kind: the durable scheduler's job kinds. The policy lists
// are spelled here once; SQL IN (...) lists are built from them so a literal in
// a query cannot drift from the scheduler's own view of which kinds read and
// which write.
const JOB_KINDS = ['sync', 'recent', 'flags', 'history', 'presence', 'body', 'prune', 'operation', 'reconcile'] as const;
type JobKind = (typeof JOB_KINDS)[number];
// Each literal is checked against the union; the lists stay plain string
// arrays so a database column value (string) can be looked up in them.
const kinds = (...list: JobKind[]): readonly string[] => list;

// Provider reads and local policy. 'prune' never contacts the provider; it
// applies Sync policy to local copies and yields to interactive work like the
// provider read jobs.
const READ_ONLY_KINDS = kinds('sync', 'recent', 'flags', 'history', 'presence', 'body', 'prune');
// Provider writes and their outcome checks. Accepted user changes run as these.
const MUTATION_KINDS = kinds('operation', 'reconcile');
// A manual refresh only promotes a scan of new mail, flags or presence.
const MANUAL_REFRESH_KINDS = kinds('sync', 'flags', 'presence');

// Values come from the registries above (lower-case identifiers); the quote
// escape only guards a future value, never user input.
function sqlList(values: readonly string[]) {
  return values.map(value => `'${value.replace(/'/g, "''")}'`).join(',');
}

export { JOB_KINDS, READ_ONLY_KINDS, MUTATION_KINDS, MANUAL_REFRESH_KINDS, sqlList };
export type { JobKind };
