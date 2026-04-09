import { getUTCDateString, type GameMode } from './rng';

const STORAGE_KEY = 'unihub.ai-game.progress.v1';

const UNLOCK_THRESHOLDS = {
  varietyPool: 12,
  starterKit: 28,
  cosmeticLabel: 45,
} as const;

type UnlockId = keyof typeof UNLOCK_THRESHOLDS;

interface ModeBest {
  bestFloor: number;
  bestScore: number;
  lastPlayedOn: string | null;
}

interface UnlockState {
  varietyPool: boolean;
  starterKit: boolean;
  cosmeticLabel: boolean;
}

interface PersistedPayload {
  normal: ModeBest;
  daily: ModeBest;
  dailyStreak: number;
  lastDailyPlayedOn: string | null;
  unlockPoints: number;
  lifetimeCompletedFloors: number;
  unlocks: UnlockState;
}

export interface RunResult {
  mode: GameMode;
  reachedFloor: number;
  score: number;
  completedFloors: number;
  playedOn?: string;
}

export interface UnlockSummary {
  tier: number;
  unlockedPools: string[];
  cosmeticLabel: string;
  points: number;
  nextUnlockAt: number | null;
}

export interface AIGameCardSummary {
  bestFloor: number;
  bestFloorNormal: number;
  bestFloorDaily: number;
  playedDailyToday: boolean;
  dailyStreak: number;
  unlockSummary: UnlockSummary;
}

const defaultModeBest = (): ModeBest => ({
  bestFloor: 1,
  bestScore: 0,
  lastPlayedOn: null,
});

const defaultState = (): PersistedPayload => ({
  normal: defaultModeBest(),
  daily: defaultModeBest(),
  dailyStreak: 0,
  lastDailyPlayedOn: null,
  unlockPoints: 0,
  lifetimeCompletedFloors: 0,
  unlocks: {
    varietyPool: false,
    starterKit: false,
    cosmeticLabel: false,
  },
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const coerceModeBest = (value: unknown): ModeBest => {
  if (!isObject(value)) return defaultModeBest();
  return {
    bestFloor: Number.isFinite(value.bestFloor) ? Math.max(1, Math.floor(Number(value.bestFloor))) : 1,
    bestScore: Number.isFinite(value.bestScore) ? Math.max(0, Math.floor(Number(value.bestScore))) : 0,
    lastPlayedOn: typeof value.lastPlayedOn === 'string' ? value.lastPlayedOn : null,
  };
};

const coerceState = (value: unknown): PersistedPayload => {
  if (!isObject(value)) return defaultState();

  const unlocksRaw = isObject(value.unlocks) ? value.unlocks : {};
  return {
    normal: coerceModeBest(value.normal),
    daily: coerceModeBest(value.daily),
    dailyStreak: Number.isFinite(value.dailyStreak) ? Math.max(0, Math.floor(Number(value.dailyStreak))) : 0,
    lastDailyPlayedOn: typeof value.lastDailyPlayedOn === 'string' ? value.lastDailyPlayedOn : null,
    unlockPoints: Number.isFinite(value.unlockPoints) ? Math.max(0, Math.floor(Number(value.unlockPoints))) : 0,
    lifetimeCompletedFloors: Number.isFinite(value.lifetimeCompletedFloors)
      ? Math.max(0, Math.floor(Number(value.lifetimeCompletedFloors)))
      : 0,
    unlocks: {
      varietyPool: Boolean(unlocksRaw.varietyPool),
      starterKit: Boolean(unlocksRaw.starterKit),
      cosmeticLabel: Boolean(unlocksRaw.cosmeticLabel),
    },
  };
};

const getYesterdayDateString = (dateString: string) => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const withUnlocksApplied = (state: PersistedPayload): PersistedPayload => ({
  ...state,
  unlocks: {
    varietyPool: state.unlockPoints >= UNLOCK_THRESHOLDS.varietyPool,
    starterKit: state.unlockPoints >= UNLOCK_THRESHOLDS.starterKit,
    cosmeticLabel: state.unlockPoints >= UNLOCK_THRESHOLDS.cosmeticLabel,
  },
});

const readState = (): PersistedPayload => {
  if (typeof window === 'undefined') return defaultState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return withUnlocksApplied(coerceState(JSON.parse(raw)));
  } catch {
    return defaultState();
  }
};

const writeState = (state: PersistedPayload) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withUnlocksApplied(state)));
  } catch {
    // localStorage may be unavailable in private contexts.
  }
};

export const getAIGamePersistenceSnapshot = (): PersistedPayload => readState();

export const markDailyParticipation = (playedOn = getUTCDateString()) => {
  const state = readState();
  if (state.lastDailyPlayedOn === playedOn) return;

  const yesterday = getYesterdayDateString(playedOn);
  const nextStreak = state.lastDailyPlayedOn === yesterday ? state.dailyStreak + 1 : 1;

  writeState({
    ...state,
    dailyStreak: nextStreak,
    lastDailyPlayedOn: playedOn,
  });
};

export const recordAIGameRun = ({ mode, reachedFloor, score, completedFloors, playedOn = getUTCDateString() }: RunResult) => {
  const state = readState();
  const modeState = state[mode];

  const nextModeState: ModeBest = {
    bestFloor: Math.max(modeState.bestFloor, Math.max(1, Math.floor(reachedFloor))),
    bestScore: Math.max(modeState.bestScore, Math.max(0, Math.floor(score))),
    lastPlayedOn: playedOn,
  };

  const safeCompletedFloors = Math.max(0, Math.floor(completedFloors));
  const pointsAwarded = safeCompletedFloors;

  const nextState: PersistedPayload = {
    ...state,
    [mode]: nextModeState,
    unlockPoints: state.unlockPoints + pointsAwarded,
    lifetimeCompletedFloors: state.lifetimeCompletedFloors + safeCompletedFloors,
  };

  writeState(nextState);
};

export const getUnlockSummary = (state = readState()): UnlockSummary => {
  const unlockedPools: string[] = ['Core pool'];
  if (state.unlocks.varietyPool) unlockedPools.push('Variety pool');
  if (state.unlocks.starterKit) unlockedPools.push('Starter options');

  const pending = Object.values(UNLOCK_THRESHOLDS)
    .filter((threshold) => threshold > state.unlockPoints)
    .sort((a, b) => a - b);

  return {
    tier: unlockedPools.length,
    unlockedPools,
    cosmeticLabel: state.unlocks.cosmeticLabel ? 'Operator Banner unlocked' : 'Operator Banner locked',
    points: state.unlockPoints,
    nextUnlockAt: pending[0] ?? null,
  };
};

export const getAIGameCardSummary = (today = getUTCDateString()): AIGameCardSummary => {
  const state = readState();
  const unlockSummary = getUnlockSummary(state);
  return {
    bestFloor: Math.max(state.normal.bestFloor, state.daily.bestFloor),
    bestFloorNormal: state.normal.bestFloor,
    bestFloorDaily: state.daily.bestFloor,
    playedDailyToday: state.lastDailyPlayedOn === today,
    dailyStreak: state.dailyStreak,
    unlockSummary,
  };
};

export const getAIGameStartingBonuses = () => {
  const state = readState();
  return {
    bonusShields: state.unlocks.starterKit ? 1 : 0,
    bonusScore: state.unlocks.starterKit ? 1 : 0,
    hasVarietyPool: state.unlocks.varietyPool,
    cosmeticLabel: state.unlocks.cosmeticLabel ? 'Operator' : null,
  };
};
