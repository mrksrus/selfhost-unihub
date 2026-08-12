import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTetrisLocalStorageKey,
  readLocalTetrisScores,
  saveLocalTetrisScore,
  sortTetrisScores,
  type LocalTetrisScore,
} from '@/components/games/tetris-leaderboard';

const score = (id: string, points: number, lines: number, playedAt: number): LocalTetrisScore => ({
  id,
  score: points,
  lines,
  level: Math.floor(lines / 10) + 1,
  playedAt,
});

describe('Tetris local leaderboard', () => {
  beforeEach(() => window.localStorage.clear());

  it('sorts by score, lines, then earliest achievement', () => {
    const sorted = sortTetrisScores([
      score('later', 500, 4, 20),
      score('lower', 400, 20, 1),
      score('more-lines', 500, 5, 30),
      score('earlier', 500, 4, 10),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['more-lines', 'earlier', 'later', 'lower']);
  });

  it('stores only the ten best runs for the current user', () => {
    for (let index = 0; index < 12; index += 1) {
      saveLocalTetrisScore('user-1', score(String(index), index * 100, index, index));
    }
    const saved = readLocalTetrisScores('user-1');
    expect(saved).toHaveLength(10);
    expect(saved[0].score).toBe(1100);
    expect(saved.at(-1)?.score).toBe(200);
    expect(window.localStorage.getItem(getTetrisLocalStorageKey('other-user'))).toBeNull();
  });

  it('ignores malformed local storage data', () => {
    window.localStorage.setItem(getTetrisLocalStorageKey('user-1'), '{bad json');
    expect(readLocalTetrisScores('user-1')).toEqual([]);
  });
});
