import { defineRoutes } from '../http/route';

// Duplicates, merge review, merges with undo and "Not the same person". The
// 0.25 automatic merge is gone: it deleted the other contacts for good,
// with their kept import details and without undo. The table is registered
// once in routes/index.ts.
export = defineRoutes({});
