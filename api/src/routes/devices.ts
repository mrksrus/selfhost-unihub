import type { RouteRequest } from '../types';
import type { CurrentDeviceResponse, DeviceKeyResponse, DeviceLockStateResponse, DeviceRemovedResponse, DevicesResponse } from '../contracts/devices';

import { getAuthTokenFromRequest } from '../auth';
import { defineRoutes } from '../http/route';
import { adoptDeviceKey, describeCurrentDevice, listDevices, removeDevice, reportDeviceLock, reportLockState } from '../services/devices';

type Request = RouteRequest & { url: string; params: Record<string, string> };

// The person's devices (F5): one browser profile, installed web app or
// Android app installation each (services/devices.ts). A device's record is
// installation state, so nothing here is gated by a restore. The routes of
// the current device stay open to a device without the app lock its person's
// policies require: they are how it reports and sets the lock up.
export = defineRoutes({
  'GET /api/devices': { auth: 'user', module: null, handler: async (req: Request, userId: string) => {
    return { devices: await listDevices(userId, getAuthTokenFromRequest(req)) } satisfies DevicesResponse;
  } },
  'GET /api/devices/current': { auth: 'user', module: null, appLock: 'exempt', handler: async (req: Request, userId: string) => {
    return { ...await describeCurrentDevice(userId, getAuthTokenFromRequest(req)) } satisfies CurrentDeviceResponse;
  } },
  'POST /api/devices/current/key': { auth: 'user', module: null, restoreSection: null, appLock: 'exempt', body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await adoptDeviceKey(userId, getAuthTokenFromRequest(req), body) } satisfies DeviceKeyResponse;
  } },
  'PUT /api/devices/current/lock': { auth: 'user', module: null, restoreSection: null, appLock: 'exempt', body: { limit: 2048 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await reportDeviceLock(userId, getAuthTokenFromRequest(req), body) } satisfies CurrentDeviceResponse;
  } },
  'POST /api/devices/current/lock-state': { auth: 'user', module: null, restoreSection: null, appLock: 'exempt', body: { limit: 256 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await reportLockState(userId, getAuthTokenFromRequest(req), body) } satisfies DeviceLockStateResponse;
  } },
  // Signs one of the person's other devices out; the current one signs out
  // with POST /api/auth/signout.
  'DELETE /api/devices/:id': { auth: 'user', module: null, restoreSection: null, handler: async (req: Request, userId: string) => {
    return { ...await removeDevice(userId, getAuthTokenFromRequest(req), req.params.id, req) } satisfies DeviceRemovedResponse;
  } },
});
