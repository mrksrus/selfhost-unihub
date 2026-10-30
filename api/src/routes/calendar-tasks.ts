import type { RouteRequest } from '../types';
import type { TaskPositionResponse } from '../contracts/tasks';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { place } from '../services/task-order';

// Task order and moves (0.27). Every route is gated by the Calendar module
// (Calendar and ToDo share it) and refused while the calendar section is
// restored. Order and moves are owner-scoped: nothing here is shared.
type Request = RouteRequest & { url: string; params: Record<string, string> };

const taskRoute = { auth: 'user' as const, module: 'calendar', restoreSection: 'calendar' };
const SMALL_BODY = 4 * 1024;

function failed(error: unknown, fallback: string) {
  const answer = clientError(error, fallback);
  if (answer.status >= 500) log.error('calendar', fallback, error);
  return answer;
}

export = defineRoutes({
  'PUT /api/calendar/events/:id/position': { ...taskRoute, body: { limit: SMALL_BODY }, handler: async (req: Request, userId: string, body: unknown) => {
    try {
      const answer: TaskPositionResponse = await place(userId, req.params.id, body);
      return { ...answer };
    } catch (error) { return failed(error, 'Failed to reorder the task'); }
  } },

  // Moving a task (or event) to another calendar or list: stream B's block
  // (services/calendar-move.ts). No destructive policy (F13): the source copy
  // is removed only after the target holds the item, so a move keeps it.
  'POST /api/calendar/events/:id/move': { ...taskRoute, body: { limit: SMALL_BODY }, handler: async () => {
    return { error: 'Moving to another list is not available yet.', status: 501, code: 'NOT_IMPLEMENTED' };
  } },
});
