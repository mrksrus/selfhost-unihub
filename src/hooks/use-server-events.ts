import { createContext, useContext } from 'react';

/** True while GET /api/events is connected; polling hooks then slow down. */
export const ServerEventsContext = createContext(false);

/** Without a provider (tests, signed out, offline) hooks keep their polling. */
export const useServerEventsConnected = () => useContext(ServerEventsContext);
