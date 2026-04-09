import type { UpgradeRarity } from './upgrades';

export type DeviceClass = 'narrow' | 'standard';
export type FloorBandKey = 'early' | 'mid' | 'late';
export type EnemyArchetype = 'hunter' | 'elite' | 'patrol';

const INITIAL_AI_INTERVAL = 980;
const MIN_AI_INTERVAL = 320;

const GRID_GROWTH_FLOORS = [1, 6, 11, 19, 28, 38, 47] as const;
const GRID_BASE_SIZE = 9;
const GRID_STEP_SIZE = 2;

const GRID_CAP_BY_DEVICE: Record<DeviceClass, number> = {
  narrow: 13,
  standard: 17,
};

const EVENT_CHANCE_BY_BAND: Record<FloorBandKey, Record<'dense_walls' | 'double_target' | 'storm_cycle' | 'shield_bonus', number>> = {
  early: {
    dense_walls: 0,
    double_target: 0,
    storm_cycle: 0,
    shield_bonus: 0,
  },
  mid: {
    dense_walls: 0.34,
    double_target: 0,
    storm_cycle: 0,
    shield_bonus: 0.24,
  },
  late: {
    dense_walls: 0.45,
    double_target: 0.45,
    storm_cycle: 0.5,
    shield_bonus: 0.35,
  },
};

interface HazardProgression {
  min: number;
  max: number;
  spawnChance: number;
  stormPatternChance: number;
}

interface EnemyProgression {
  minCount: number;
  maxCount: number;
  archetypeWeights: Record<EnemyArchetype, number>;
}

interface WallProgression {
  baseDensity: number;
  perFloorDensity: number;
  denseWallBonus: number;
  maxDensity: number;
}

interface BandProgression {
  aiSpeedMultiplier: number;
  enemy: EnemyProgression;
  wall: WallProgression;
  hazard: HazardProgression;
  upgradeRarityWeights: Record<UpgradeRarity, number>;
}

const BAND_PROGRESSION: Record<FloorBandKey, BandProgression> = {
  early: {
    aiSpeedMultiplier: 0.96,
    enemy: {
      minCount: 1,
      maxCount: 1,
      archetypeWeights: {
        hunter: 1,
        patrol: 0,
        elite: 0,
      },
    },
    wall: {
      baseDensity: 0.15,
      perFloorDensity: 0.0012,
      denseWallBonus: 0.04,
      maxDensity: 0.24,
    },
    hazard: {
      min: 0,
      max: 0,
      spawnChance: 0,
      stormPatternChance: 0,
    },
    upgradeRarityWeights: {
      common: 70,
      uncommon: 22,
      rare: 7,
      epic: 1,
    },
  },
  mid: {
    aiSpeedMultiplier: 1,
    enemy: {
      minCount: 1,
      maxCount: 3,
      archetypeWeights: {
        hunter: 0.58,
        patrol: 0.3,
        elite: 0.12,
      },
    },
    wall: {
      baseDensity: 0.162,
      perFloorDensity: 0.0017,
      denseWallBonus: 0.045,
      maxDensity: 0.28,
    },
    hazard: {
      min: 0,
      max: 2,
      spawnChance: 0.42,
      stormPatternChance: 0.15,
    },
    upgradeRarityWeights: {
      common: 64,
      uncommon: 25,
      rare: 9,
      epic: 2,
    },
  },
  late: {
    aiSpeedMultiplier: 1.08,
    enemy: {
      minCount: 2,
      maxCount: 4,
      archetypeWeights: {
        hunter: 0.4,
        patrol: 0.3,
        elite: 0.3,
      },
    },
    wall: {
      baseDensity: 0.172,
      perFloorDensity: 0.0019,
      denseWallBonus: 0.05,
      maxDensity: 0.31,
    },
    hazard: {
      min: 1,
      max: 4,
      spawnChance: 0.6,
      stormPatternChance: 0.5,
    },
    upgradeRarityWeights: {
      common: 56,
      uncommon: 28,
      rare: 12,
      epic: 4,
    },
  },
};

export const getFloorBand = (floor: number): FloorBandKey => {
  if (floor <= 4) return 'early';
  if (floor <= 11) return 'mid';
  return 'late';
};

export const getMapTierForFloor = (floor: number) => Math.min(5, 1 + Math.floor((floor - 1) / 8));

export const getGridSizeForFloor = (floor: number, deviceClass: DeviceClass) => {
  const bumps = GRID_GROWTH_FLOORS.filter((growthFloor) => floor >= growthFloor).length - 1;
  const uncappedSize = GRID_BASE_SIZE + Math.max(0, bumps) * GRID_STEP_SIZE;
  return Math.min(uncappedSize, GRID_CAP_BY_DEVICE[deviceClass]);
};

export const getBandProgression = (floor: number) => BAND_PROGRESSION[getFloorBand(floor)];

export const getEventChances = (floor: number) => EVENT_CHANCE_BY_BAND[getFloorBand(floor)];

export const getWallDensity = (floor: number, events: Array<'dense_walls' | 'double_target' | 'storm_cycle' | 'shield_bonus'>) => {
  const wall = getBandProgression(floor).wall;
  const denseWallBump = events.includes('dense_walls') ? wall.denseWallBonus : 0;
  return Math.min(wall.maxDensity, wall.baseDensity + floor * wall.perFloorDensity + denseWallBump);
};

export const getAIIntervalForFloor = (floor: number, threatLevel: number) => {
  const multiplier = getBandProgression(floor).aiSpeedMultiplier;
  return Math.max(MIN_AI_INTERVAL, Math.round((INITIAL_AI_INTERVAL - threatLevel * 58) / multiplier));
};
