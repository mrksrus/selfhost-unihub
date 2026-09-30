export interface LocalTetrisScore {
  id: string;
  score: number;
  lines: number;
  level: number;
  playedAt: number;
}

const LOCAL_SCORE_LIMIT = 10;

export const getTetrisLocalStorageKey = (userId: string) => `unihub:tetris:scores:v1:${userId}`;

export const sortTetrisScores = <T extends Pick<LocalTetrisScore, 'score' | 'lines' | 'playedAt'>>(scores: T[]) =>
  [...scores].sort((left, right) =>
    right.score - left.score || right.lines - left.lines || left.playedAt - right.playedAt
  );

export const readLocalTetrisScores = (userId: string): LocalTetrisScore[] => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(getTetrisLocalStorageKey(userId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return sortTetrisScores(
      parsed.filter((entry): entry is LocalTetrisScore =>
        Boolean(
          entry &&
          typeof entry.id === 'string' &&
          Number.isSafeInteger(entry.score) && entry.score >= 0 &&
          Number.isSafeInteger(entry.lines) && entry.lines >= 0 &&
          Number.isSafeInteger(entry.level) && entry.level >= 1 &&
          Number.isFinite(entry.playedAt)
        )
      )
    ).slice(0, LOCAL_SCORE_LIMIT);
  } catch {
    return [];
  }
};

export const saveLocalTetrisScore = (userId: string, entry: LocalTetrisScore) => {
  const scores = sortTetrisScores([...readLocalTetrisScores(userId), entry]).slice(0, LOCAL_SCORE_LIMIT);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(getTetrisLocalStorageKey(userId), JSON.stringify(scores));
  }
  return scores;
};
