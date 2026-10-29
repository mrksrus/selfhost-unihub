import { defineRoutes } from '../http/route';

// Contact import and export (vCard 4.0/3.0/2.1 and CSV, two-step import with
// preview). The 0.25 routes are gone: their import and export dropped every
// field beyond names, emails, phones, organisation, title and notes. The
// table is registered once in routes/index.ts.
export = defineRoutes({});
