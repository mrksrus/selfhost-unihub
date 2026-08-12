const test = require('node:test');
const assert = require('node:assert/strict');

function loadGamesRoutes(t, execute) {
  const routePath = require.resolve('../src/routes/games');
  const statePath = require.resolve('../src/state');
  const originalRoute = require.cache[routePath];
  const originalState = require.cache[statePath];

  t.after(() => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
  });

  delete require.cache[routePath];
  require.cache[statePath] = {
    id: statePath,
    filename: statePath,
    loaded: true,
    exports: { db: { execute } },
  };
  return require('../src/routes/games');
}

test('Tetris score route validates whole non-negative values', async (t) => {
  const routes = loadGamesRoutes(t, async () => {
    throw new Error('database should not be called');
  });
  const result = await routes['POST /api/games/tetris/score']({}, 'user-1', { score: -1, lines: 3 });
  assert.equal(result.status, 400);
  assert.match(result.error, /valid completed run/);
});

test('Tetris score route rejects scores that cannot match the submitted lines', async (t) => {
  const routes = loadGamesRoutes(t, async () => {
    throw new Error('database should not be called');
  });
  const result = await routes['POST /api/games/tetris/score']({}, 'user-1', { score: 999999, lines: 1 });
  assert.equal(result.status, 400);
});

test('Tetris score route upserts a personal best and returns ranked scores', async (t) => {
  const calls = [];
  const routes = loadGamesRoutes(t, async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('INNER JOIN users')) {
      return [[{
        user_id: 'user-1',
        score: 880,
        lines: 4,
        level: 1,
        achieved_at: '2026-08-12T12:00:00.000Z',
        player_name: 'Ada',
      }]];
    }
    if (sql.includes('FROM tetris_scores') && sql.includes('WHERE user_id')) {
      return [[{ score: 880, lines: 4, level: 1, achieved_at: '2026-08-12T12:00:00.000Z' }]];
    }
    return [{ affectedRows: 1 }];
  });

  const result = await routes['POST /api/games/tetris/score']({}, 'user-1', { score: 880, lines: 4 });
  assert.deepEqual(calls[0].params, ['user-1', 880, 4, 1]);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(result.leaderboard[0].is_you, true);
  assert.equal(result.leaderboard[0].score, 880);
  assert.equal(result.personal_best.score, 880);
});
