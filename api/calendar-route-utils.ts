function parseRoutePathParts(rawUrl: string, host = 'localhost') {
  const parsedUrl = new URL(rawUrl, `http://${host}`);
  return parsedUrl.pathname.split('/').filter(Boolean);
}

function getCalendarEventIdFromPath(rawUrl: string, host = 'localhost') {
  const parts = parseRoutePathParts(rawUrl, host);
  return parts[3] || null;
}

function getCalendarSubtaskIdFromPath(rawUrl: string, host = 'localhost') {
  const parts = parseRoutePathParts(rawUrl, host);
  const subtasksIndex = parts.indexOf('subtasks');
  if (subtasksIndex === -1) return null;
  return parts[subtasksIndex + 1] || null;
}

export {
  parseRoutePathParts,
  getCalendarEventIdFromPath,
  getCalendarSubtaskIdFromPath,
};
