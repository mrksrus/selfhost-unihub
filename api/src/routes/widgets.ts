import type { RouteRequest } from '../types';
import type { WidgetsResponse } from '../contracts/widgets';
import { defineRoutes } from '../http/route';
import { widgets } from '../services/widgets';

// The Android home-screen widgets (contracts/widgets.ts). A Calendar route
// with the normal gates: a module switched off, an ended two-factor grace or
// a missing app lock refuse it, and the app then empties its widgets.
type Request = RouteRequest & { url: string };

export = defineRoutes({
  'GET /api/widgets': { auth: 'user', module: 'calendar', handler: async (req: Request, userId: string) => {
    // The phone's zone, for a person who has set none.
    const zone = new URL(req.url, 'http://unihub.invalid').searchParams.get('tz');
    return { ...await widgets(userId, zone) } satisfies WidgetsResponse;
  } },
});
