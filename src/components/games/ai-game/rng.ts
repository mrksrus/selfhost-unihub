export type GameMode = 'normal' | 'daily';

const UINT32_MAX = 0x1_0000_0000;

const hashString = (input: string) => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export interface RNGSnapshot {
  seed: string;
  cursor: number;
}

export const nextRandom = (snapshot: RNGSnapshot) => {
  const hashed = hashString(`${snapshot.seed}:${snapshot.cursor}`);
  return {
    value: hashed / UINT32_MAX,
    snapshot: {
      ...snapshot,
      cursor: snapshot.cursor + 1,
    },
  };
};

export const nextRandomInt = (snapshot: RNGSnapshot, maxExclusive: number) => {
  if (maxExclusive <= 1) {
    return {
      value: 0,
      snapshot,
    };
  }

  const next = nextRandom(snapshot);
  return {
    value: Math.floor(next.value * maxExclusive),
    snapshot: next.snapshot,
  };
};

export const getUTCDateString = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const buildDailySeed = (utcDate: string, versionSalt?: string) =>
  versionSalt ? `${utcDate}:${versionSalt}` : utcDate;

export const createSessionSeed = (mode: GameMode, utcDate: string, versionSalt?: string) => {
  if (mode === 'daily') {
    return buildDailySeed(utcDate, versionSalt);
  }

  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
};
