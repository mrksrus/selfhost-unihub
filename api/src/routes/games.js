const { db } = require('../state');

const TETRIS_LEADERBOARD_LIMIT = 20;
const MAX_TETRIS_SCORE = 100_000_000;
const MAX_TETRIS_LINES = 1_000_000;

function parseWholeNumber(value, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return null;
  return parsed;
}

function isPlausibleTetrisScore(score, lines) {
  if (lines === 0) return score === 0;
  const fullTetrises = Math.floor(lines / 4);
  const remainingLines = lines % 4;
  const remainderMaximums = [0, 130, 320, 570];
  const minimum = lines * 130;
  const maximum = fullTetrises * 880 + remainderMaximums[remainingLines];
  return score >= minimum && score <= maximum && (score - minimum) % 60 === 0;
}

async function loadTetrisLeaderboard(userId) {
  const [rows] = await db.execute(
    `SELECT
       scores.user_id,
       scores.score,
       scores.\`lines\`,
       scores.level,
       scores.achieved_at,
       COALESCE(NULLIF(TRIM(users.full_name), ''), CONCAT('Player ', LEFT(scores.user_id, 4))) AS player_name
     FROM tetris_scores AS scores
     INNER JOIN users ON users.id = scores.user_id
     WHERE users.is_active = TRUE
     ORDER BY scores.score DESC, scores.\`lines\` DESC, scores.achieved_at ASC
     LIMIT ${TETRIS_LEADERBOARD_LIMIT}`
  );

  const [personalRows] = await db.execute(
    `SELECT score, \`lines\`, level, achieved_at
     FROM tetris_scores
     WHERE user_id = ?
     LIMIT 1`,
    [userId]
  );

  return {
    leaderboard: (rows || []).map((row) => ({
      score: Number(row.score) || 0,
      lines: Number(row.lines) || 0,
      level: Number(row.level) || 1,
      achieved_at: row.achieved_at,
      player_name: row.player_name,
      is_you: row.user_id === userId,
    })),
    personal_best: personalRows?.[0]
      ? {
          score: Number(personalRows[0].score) || 0,
          lines: Number(personalRows[0].lines) || 0,
          level: Number(personalRows[0].level) || 1,
          achieved_at: personalRows[0].achieved_at,
        }
      : null,
  };
}

module.exports = {
  'GET /api/games/tetris/leaderboard': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return await loadTetrisLeaderboard(userId);
    } catch (error) {
      console.error('Load Tetris leaderboard error:', error);
      return { error: 'Failed to load the server leaderboard', status: 500 };
    }
  },

  'POST /api/games/tetris/score': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const score = parseWholeNumber(body?.score, MAX_TETRIS_SCORE);
    const lines = parseWholeNumber(body?.lines, MAX_TETRIS_LINES);
    if (score === null || lines === null || !isPlausibleTetrisScore(score, lines)) {
      return { error: 'Score and lines do not describe a valid completed run', status: 400 };
    }

    const level = Math.floor(lines / 10) + 1;
    try {
      await db.execute(
        `INSERT INTO tetris_scores (user_id, score, \`lines\`, level, achieved_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           \`lines\` = IF(VALUES(score) > score, VALUES(\`lines\`), \`lines\`),
           level = IF(VALUES(score) > score, VALUES(level), level),
           achieved_at = IF(VALUES(score) > score, CURRENT_TIMESTAMP, achieved_at),
           score = GREATEST(score, VALUES(score))`,
        [userId, score, lines, level]
      );
      return await loadTetrisLeaderboard(userId);
    } catch (error) {
      console.error('Save Tetris score error:', error);
      return { error: 'Failed to save the score', status: 500 };
    }
  },
};
