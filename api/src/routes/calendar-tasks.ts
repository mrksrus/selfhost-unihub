import type { RouteRequest } from '../types';
import type { TaskMoveCancelResponse, TaskMoveResponse, TaskPositionResponse } from '../contracts/tasks';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import { log } from '../log';
import { place } from '../services/task-order';
import { cancelMove, moveTask } from '../services/calendar-move';
import { calendarErrorResponse } from '../services/calendar-sync';

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

  // Moving a task (or event) to another calendar or list
  // (services/calendar-move.ts). No destructive policy (F13): the old copy is
  // removed only after the new calendar holds the item, so a move keeps it.
  // 202 while a calendar server has not confirmed a step yet.
  'POST /api/calendar/events/:id/move': { ...taskRoute, body: { limit: SMALL_BODY }, handler: async (req: Request, userId: string, body: unknown) => {
    try {
      const answer: TaskMoveResponse = await moveTask(userId, req.params.id, body);
      return answer.pending ? { ...answer, status: 202 } : { ...answer };
    } catch (error) {
      // A calendar server's answer is translated (its 401 is not this
      // session's); anything without a status is a failure of our own.
      if (typeof (error as { status?: unknown })?.status === 'number') return calendarErrorResponse(error, 'Could not move the item');
      return failed(error, 'Could not move the item');
    }
  } },

  // Cancelling a move whose new copy is not confirmed: the item stays in its
  // old list, and nothing is deleted at any server. If the new calendar got
  // the copy anyway, it appears there as its own item after the next sync;
  // the person deletes it if they don't want it. No destructive policy (F13):
  // nothing is removed.
  'DELETE /api/calendar/events/:id/move': { ...taskRoute, handler: async (req: Request, userId: string) => {
    try {
      const answer: TaskMoveCancelResponse = await cancelMove(userId, req.params.id);
      return { ...answer };
    } catch (error) { return failed(error, 'Could not cancel the move'); }
  } },
});
