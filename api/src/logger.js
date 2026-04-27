const fs = require('fs');

// Debug logging helper - write to container filesystem and console
const DEBUG_LOG_PATH = '/app/debug.log';
const debugLog = (location, message, data, hypothesisId, runId = 'run1') => {
  try {
    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      location,
      message,
      data,
      runId,
      hypothesisId,
    };
    const logLine = JSON.stringify(logEntry);
    // Write to file
    fs.appendFileSync(DEBUG_LOG_PATH, logLine + '\n');
    // Also log to console for Docker logs visibility
    console.log(`[DEBUG] ${location}: ${message}`, JSON.stringify(data));
  } catch (e) {
    // Fallback to console only if file write fails
    console.log(`[DEBUG] ${location}: ${message}`, JSON.stringify(data), `[LOG ERROR: ${e.message}]`);
  }
};

module.exports = {
  DEBUG_LOG_PATH,
  debugLog,
};
