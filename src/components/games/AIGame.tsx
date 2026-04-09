import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bot, Gamepad2, Keyboard } from 'lucide-react';
import {
  AI_UPGRADES,
  UPGRADE_MAP,
  type AITickEffectEvent,
  type CollisionEffectEvent,
  type FloorStartEffectEvent,
  type MoveEffectEvent,
} from './ai-game/upgrades';
import {
  getAIIntervalForFloor,
  getBandProgression,
  getEventChances,
  getFloorBand,
  getGridSizeForFloor,
  getMapTierForFloor,
  getWallDensity,
  type DeviceClass,
  type EnemyArchetype,
} from './ai-game/progression';
import {
  buildDailySeed,
  createSessionSeed,
  getUTCDateString,
  nextRandom,
  nextRandomInt,
  type GameMode,
  type RNGSnapshot,
} from './ai-game/rng';

const CONTROLLER_DEADZONE = 0.45;
const CONTROLLER_REPEAT_MS = 155;
const UPGRADE_DRAFT_SIZE = 3;
const MOBILE_CONTROL_FOOTER = 136;

type GameStatus = 'idle' | 'playing' | 'lost';
type GamePhase = 'combat' | 'upgrade_draft';
type Direction = 'up' | 'down' | 'left' | 'right';

interface Point {
  x: number;
  y: number;
}

type FloorEventModifier = 'dense_walls' | 'double_target' | 'storm_cycle' | 'shield_bonus';

interface Enemy {
  id: string;
  archetype: EnemyArchetype;
  position: Point;
  patrolDirection: Direction;
}

interface HazardTile {
  id: string;
  position: Point;
  pattern: 'pulse' | 'alternating' | 'storm';
  offset: number;
}

interface GameState {
  status: GameStatus;
  phase: GamePhase;
  mode: GameMode;
  dailySeedLabel: string | null;
  rngSeed: string;
  rngCursor: number;
  player: Point;
  enemies: Enemy[];
  target: Point;
  walls: string[];
  hazards: HazardTile[];
  floorEvents: FloorEventModifier[];
  tickCount: number;
  score: number;
  shields: number;
  startedAt: number | null;
  floor: number;
  floorProgress: number;
  floorTarget: number;
  threatLevel: number;
  gridSize: number;
  mapTier: number;
  ownedUpgrades: string[];
  upgradeChoices: string[];
  aiStunTicks: number;
  deviceClass: DeviceClass;
}

type Action =
  | { type: 'START'; deviceClass: DeviceClass; mode: GameMode }
  | { type: 'MOVE_PLAYER'; direction: Direction }
  | { type: 'AI_TICK' }
  | { type: 'PICK_UPGRADE'; upgradeId: string }
  | { type: 'RESTART'; deviceClass: DeviceClass };

const DIRECTION_VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const toKey = ({ x, y }: Point) => `${x},${y}`;

const fromKey = (value: string): Point => {
  const [x, y] = value.split(',').map(Number);
  return { x, y };
};

const inBounds = ({ x, y }: Point, gridSize: number) => x >= 0 && x < gridSize && y >= 0 && y < gridSize;

const DAILY_VERSION_SALT = 'v1';

interface RandomSource {
  next: () => number;
  nextInt: (maxExclusive: number) => number;
  snapshot: () => RNGSnapshot;
}

const createRandomSource = (seed: string, cursor = 0): RandomSource => {
  let state: RNGSnapshot = { seed, cursor };
  return {
    next: () => {
      const next = nextRandom(state);
      state = next.snapshot;
      return next.value;
    },
    nextInt: (maxExclusive: number) => {
      const next = nextRandomInt(state, maxExclusive);
      state = next.snapshot;
      return next.value;
    },
    snapshot: () => state,
  };
};

const getFloorEvents = (floor: number, random: RandomSource): FloorEventModifier[] => {
  const chances = getEventChances(floor);
  const events: FloorEventModifier[] = [];
  if (random.next() < chances.dense_walls) events.push('dense_walls');
  if (random.next() < chances.double_target) events.push('double_target');
  if (random.next() < chances.storm_cycle) events.push('storm_cycle');
  if (random.next() < chances.shield_bonus) events.push('shield_bonus');
  return events;
};

const getWallCount = (gridSize: number, floor: number, events: FloorEventModifier[]) => {
  const totalCells = gridSize * gridSize;
  const density = getWallDensity(floor, events);
  const suggested = Math.round(totalCells * density);
  const reserved = 14;
  return Math.min(suggested, totalCells - reserved);
};

const getFloorTarget = (floor: number, mapTier: number, events: FloorEventModifier[]) => {
  const base = Math.min(9, 3 + Math.floor((floor - 1) / 3) + Math.floor(mapTier / 2));
  return events.includes('double_target') ? Math.min(12, base + 2) : base;
};

const getThreatLevel = (floor: number, mapTier: number, events: FloorEventModifier[]) => {
  const base = 1 + Math.floor((floor - 1) / 2) + mapTier;
  return events.includes('storm_cycle') ? base + 1 : base;
};

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const randomOpenCell = (
  walls: Set<string>,
  excluded: Set<string>,
  gridSize: number,
  random: RandomSource,
  minDistanceFromPlayer = 0,
  player: Point = { x: 0, y: 0 }
) => {
  const options: Point[] = [];
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const key = toKey({ x, y });
      if (!walls.has(key) && !excluded.has(key)) {
        const point = { x, y };
        if (manhattan(point, player) >= minDistanceFromPlayer) options.push(point);
      }
    }
  }
  if (options.length === 0) return { x: 1, y: 1 };
  return options[random.nextInt(options.length)];
};

const chooseEnemyStart = (walls: Set<string>, gridSize: number, excluded: Set<string>, player: Point, random: RandomSource) => {
  const minSpawnDistance = gridSize >= 13 ? 7 : gridSize >= 11 ? 6 : 4;
  return randomOpenCell(walls, excluded, gridSize, random, minSpawnDistance, player);
};

const generateWalls = (gridSize: number, floor: number, events: FloorEventModifier[], random: RandomSource) => {
  const walls = new Set<string>();
  const wallCount = getWallCount(gridSize, floor, events);
  const protectedCells = new Set<string>([
    toKey({ x: 0, y: 0 }),
    toKey({ x: 1, y: 0 }),
    toKey({ x: 0, y: 1 }),
    toKey({ x: gridSize - 1, y: gridSize - 1 }),
    toKey({ x: gridSize - 1, y: 0 }),
    toKey({ x: 0, y: gridSize - 1 }),
  ]);

  while (walls.size < wallCount) {
    const candidate = { x: random.nextInt(gridSize), y: random.nextInt(gridSize) };
    const key = toKey(candidate);
    if (protectedCells.has(key)) continue;
    walls.add(key);
  }

  return walls;
};

const chooseWeightedArchetype = (weights: Record<EnemyArchetype, number>, random: RandomSource) => {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return 'hunter';

  let roll = random.next() * total;
  const entries = Object.entries(weights) as Array<[EnemyArchetype, number]>;
  for (const [archetype, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return archetype;
  }

  return entries[entries.length - 1]?.[0] ?? 'hunter';
};

const generateEnemyComposition = (floor: number, random: RandomSource): EnemyArchetype[] => {
  const enemy = getBandProgression(floor).enemy;
  const countRange = enemy.maxCount - enemy.minCount + 1;
  const enemyCount = enemy.minCount + random.nextInt(Math.max(1, countRange));
  return Array.from({ length: enemyCount }, () => chooseWeightedArchetype(enemy.archetypeWeights, random));
};

const generateHazards = (
  floor: number,
  walls: Set<string>,
  gridSize: number,
  blocked: Set<string>,
  events: FloorEventModifier[],
  random: RandomSource
) => {
  const hazardConfig = getBandProgression(floor).hazard;
  const range = hazardConfig.max - hazardConfig.min + 1;
  const baseCount = hazardConfig.min + random.nextInt(Math.max(1, range));
  const stormBonus = events.includes('storm_cycle') ? 1 : 0;
  const rolledCount = Array.from({ length: baseCount }).filter(() => random.next() < hazardConfig.spawnChance).length;
  const hazardCount = Math.min(hazardConfig.max, Math.max(hazardConfig.min, rolledCount + stormBonus));
  const hazards: HazardTile[] = [];

  for (let i = 0; i < hazardCount; i += 1) {
    const point = randomOpenCell(walls, blocked, gridSize, random, 2, { x: 0, y: 0 });
    const key = toKey(point);
    blocked.add(key);
    const pattern: HazardTile['pattern'] = events.includes('storm_cycle') && random.next() < hazardConfig.stormPatternChance
      ? 'storm'
      : i % 2 === 0
        ? 'pulse'
        : 'alternating';

    hazards.push({
      id: `hazard-${i}`,
      position: point,
      pattern,
      offset: random.nextInt(4),
    });
  }

  return hazards;
};

const generateFloorLayout = (floor: number, gridSize: number, events: FloorEventModifier[], random: RandomSource) => {
  const walls = generateWalls(gridSize, floor, events, random);
  const player = { x: 0, y: 0 };

  const composition = generateEnemyComposition(floor, random);
  const blocked = new Set<string>([toKey(player)]);
  const enemies = composition.map((archetype, index) => {
    const position = chooseEnemyStart(walls, gridSize, blocked, player, random);
    blocked.add(toKey(position));
    return {
      id: `enemy-${index}`,
      archetype,
      position,
      patrolDirection: index % 2 === 0 ? 'right' : 'down',
    } as Enemy;
  });

  const target = randomOpenCell(walls, blocked, gridSize, random, 3, player);
  blocked.add(toKey(target));
  const hazards = generateHazards(floor, walls, gridSize, blocked, events, random);

  return {
    player,
    enemies,
    target,
    walls: Array.from(walls),
    hazards,
  };
};

const getDirectionFromGamepad = (gp: Gamepad): Direction | null => {
  const dpadUp = gp.buttons[12]?.pressed;
  const dpadDown = gp.buttons[13]?.pressed;
  const dpadLeft = gp.buttons[14]?.pressed;
  const dpadRight = gp.buttons[15]?.pressed;

  if (dpadUp) return 'up';
  if (dpadDown) return 'down';
  if (dpadLeft) return 'left';
  if (dpadRight) return 'right';

  const hat = gp.axes[9];
  if (typeof hat === 'number') {
    if (hat <= -0.9) return 'up';
    if (hat <= -0.4) return 'right';
    if (hat <= 0.1) return 'down';
    if (hat <= 0.6) return 'left';
  }

  const primaryX = gp.axes[0] ?? 0;
  const primaryY = gp.axes[1] ?? 0;
  const altX = gp.axes[2] ?? 0;
  const altY = gp.axes[3] ?? 0;
  const x = Math.abs(primaryX) > Math.abs(altX) ? primaryX : altX;
  const y = Math.abs(primaryY) > Math.abs(altY) ? primaryY : altY;

  const useRotatedAxes = gp.mapping !== 'standard';
  const horizontal = useRotatedAxes ? y : x;
  const vertical = useRotatedAxes ? x : y;

  if (Math.abs(horizontal) > Math.abs(vertical)) {
    if (horizontal < -CONTROLLER_DEADZONE) return useRotatedAxes ? 'up' : 'left';
    if (horizontal > CONTROLLER_DEADZONE) return useRotatedAxes ? 'down' : 'right';
    return null;
  }

  if (vertical < -CONTROLLER_DEADZONE) return useRotatedAxes ? 'left' : 'up';
  if (vertical > CONTROLLER_DEADZONE) return useRotatedAxes ? 'right' : 'down';
  return null;
};

const getOwnedUpgradeDefs = (ownedUpgrades: string[]) => ownedUpgrades.map((id) => UPGRADE_MAP.get(id)).filter(Boolean);

const runUpgradeHook = <TEvent,>(ownedUpgrades: string[], hook: 'on_move' | 'on_ai_tick' | 'on_collision' | 'on_floor_start', event: TEvent) => {
  const upgradeDefs = getOwnedUpgradeDefs(ownedUpgrades);
  for (const upgrade of upgradeDefs) {
    const handler = upgrade.hooks[hook] as ((payload: TEvent) => void) | undefined;
    if (handler) handler(event);
  }
};

const isUpgradeCompatible = (upgradeId: string, ownedSet: Set<string>) => {
  const upgrade = UPGRADE_MAP.get(upgradeId);
  if (!upgrade) return false;
  const { compatibility } = upgrade;
  if (!compatibility.stackable && ownedSet.has(upgradeId)) return false;
  if (compatibility.requires?.some((required) => !ownedSet.has(required))) return false;
  if (compatibility.excludes?.some((excluded) => ownedSet.has(excluded))) return false;
  return true;
};

const rollWeightedUpgrades = (candidates: string[], count: number, floor: number, random: RandomSource) => {
  const selected: string[] = [];
  const available = [...candidates];
  const rarityWeights = getBandProgression(floor).upgradeRarityWeights;

  while (selected.length < count && available.length > 0) {
    const weighted = available.map((id) => {
      const upgrade = UPGRADE_MAP.get(id);
      if (!upgrade) return { id, weight: 0 };
      const rarityWeight = rarityWeights[upgrade.rarity] ?? 1;
      const boost = upgrade.compatibility.draftWeight ?? 1;
      return { id, weight: Math.max(1, rarityWeight * boost) };
    });

    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    let roll = random.next() * totalWeight;
    let picked = weighted[weighted.length - 1]?.id;

    for (const item of weighted) {
      roll -= item.weight;
      if (roll <= 0) {
        picked = item.id;
        break;
      }
    }

    if (!picked) break;
    selected.push(picked);

    const pickedIndex = available.indexOf(picked);
    if (pickedIndex >= 0) available.splice(pickedIndex, 1);
  }

  return selected;
};

const buildUpgradeChoices = (
  state: Pick<GameState, 'ownedUpgrades' | 'floor' | 'score' | 'shields' | 'threatLevel' | 'floorTarget'>,
  random: RandomSource
) => {
  const ownedSet = new Set(state.ownedUpgrades);
  const snapshot = {
    floor: state.floor,
    score: state.score,
    shields: state.shields,
    threatLevel: state.threatLevel,
    floorTarget: state.floorTarget,
  };

  const filtered = AI_UPGRADES.filter((upgrade) => {
    if (!isUpgradeCompatible(upgrade.id, ownedSet)) return false;
    if (upgrade.isUseful && !upgrade.isUseful(snapshot, ownedSet)) return false;
    return true;
  }).map((upgrade) => upgrade.id);

  if (filtered.length === 0) return [];

  const primary = rollWeightedUpgrades(filtered, UPGRADE_DRAFT_SIZE, state.floor, random);
  if (primary.length >= UPGRADE_DRAFT_SIZE || filtered.length <= UPGRADE_DRAFT_SIZE) return primary;

  const remainder = filtered.filter((id) => !primary.includes(id));
  return [...primary, ...remainder.slice(0, UPGRADE_DRAFT_SIZE - primary.length)];
};

const createGameState = (
  deviceClass: DeviceClass = 'standard',
  mode: GameMode = 'normal',
  seed = createSessionSeed(mode, getUTCDateString(), DAILY_VERSION_SALT),
  dailySeedLabel: string | null = mode === 'daily' ? buildDailySeed(getUTCDateString(), DAILY_VERSION_SALT) : null
): GameState => {
  const random = createRandomSource(seed);
  const floor = 1;
  const mapTier = getMapTierForFloor(floor);
  const gridSize = getGridSizeForFloor(floor, deviceClass);
  const floorEvents = getFloorEvents(floor, random);
  const layout = generateFloorLayout(floor, gridSize, floorEvents, random);
  const randomSnapshot = random.snapshot();

  return {
    status: 'idle',
    phase: 'combat',
    mode,
    dailySeedLabel,
    rngSeed: randomSnapshot.seed,
    rngCursor: randomSnapshot.cursor,
    ...layout,
    floorEvents,
    tickCount: 0,
    score: 0,
    shields: floorEvents.includes('shield_bonus') ? 2 : 1,
    startedAt: null,
    floor,
    floorProgress: 0,
    floorTarget: getFloorTarget(floor, mapTier, floorEvents),
    threatLevel: getThreatLevel(floor, mapTier, floorEvents),
    gridSize,
    mapTier,
    ownedUpgrades: [],
    upgradeChoices: [],
    aiStunTicks: 0,
    deviceClass,
  };
};

const tryMove = (origin: Point, direction: Direction, wallsSet: Set<string>, gridSize: number, ignoreWalls = false) => {
  const next = {
    x: origin.x + DIRECTION_VECTORS[direction].x,
    y: origin.y + DIRECTION_VECTORS[direction].y,
  };
  if (!inBounds(next, gridSize)) return origin;
  if (!ignoreWalls && wallsSet.has(toKey(next))) return origin;
  return next;
};

const findPathStep = (start: Point, goal: Point, wallsSet: Set<string>, gridSize: number) => {
  const startKey = toKey(start);
  const goalKey = toKey(goal);
  if (startKey === goalKey) return start;

  const queue: Point[] = [start];
  const visited = new Set<string>([startKey]);
  const previous = new Map<string, string>();
  const directions: Direction[] = ['up', 'down', 'left', 'right'];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (toKey(current) === goalKey) break;

    for (const direction of directions) {
      const next = tryMove(current, direction, wallsSet, gridSize);
      const nextKey = toKey(next);
      if (nextKey === toKey(current) || visited.has(nextKey)) continue;
      visited.add(nextKey);
      previous.set(nextKey, toKey(current));
      queue.push(next);
    }
  }

  if (!visited.has(goalKey)) return start;

  let currentKey = goalKey;
  let parent = previous.get(currentKey);
  while (parent && parent !== startKey) {
    currentKey = parent;
    parent = previous.get(currentKey);
  }

  return fromKey(currentKey);
};

const rotatePatrolDirection = (direction: Direction): Direction => {
  switch (direction) {
    case 'up':
      return 'right';
    case 'right':
      return 'down';
    case 'down':
      return 'left';
    default:
      return 'up';
  }
};

const moveEnemy = (enemy: Enemy, state: GameState, wallsSet: Set<string>, random: RandomSource) => {
  if (enemy.archetype === 'hunter') {
    const next = findPathStep(enemy.position, state.player, wallsSet, state.gridSize);
    if (toKey(next) === toKey(enemy.position)) {
      const directions: Direction[] = ['up', 'down', 'left', 'right'];
      const options = directions
        .map((direction) => tryMove(enemy.position, direction, wallsSet, state.gridSize))
        .filter((candidate) => toKey(candidate) !== toKey(enemy.position));
      const fallbackIndex = random.nextInt(options.length);
      return { ...enemy, position: options.length > 0 ? options[fallbackIndex] : enemy.position };
    }
    return { ...enemy, position: next };
  }

  if (enemy.archetype === 'elite') {
    let current = enemy.position;
    for (let i = 0; i < 2; i += 1) {
      const step = findPathStep(current, state.player, wallsSet, state.gridSize);
      if (toKey(step) === toKey(current)) break;
      current = step;
      if (toKey(current) === toKey(state.player)) break;
    }
    return { ...enemy, position: current };
  }

  let patrolDirection = enemy.patrolDirection;
  let next = tryMove(enemy.position, patrolDirection, wallsSet, state.gridSize);
  if (toKey(next) === toKey(enemy.position)) {
    patrolDirection = rotatePatrolDirection(patrolDirection);
    next = tryMove(enemy.position, patrolDirection, wallsSet, state.gridSize);
  }

  if (toKey(next) === toKey(enemy.position) || random.next() < 0.2) {
    patrolDirection = rotatePatrolDirection(patrolDirection);
    next = tryMove(enemy.position, patrolDirection, wallsSet, state.gridSize);
  }

  return { ...enemy, position: next, patrolDirection };
};

const respawnEnemies = (state: GameState, wallsSet: Set<string>, random: RandomSource) => {
  const blocked = new Set<string>([toKey(state.player), toKey(state.target), ...state.hazards.map((hazard) => toKey(hazard.position))]);
  return state.enemies.map((enemy) => {
    const position = chooseEnemyStart(wallsSet, state.gridSize, blocked, state.player, random);
    blocked.add(toKey(position));
    return { ...enemy, position };
  });
};

const isHazardActive = (hazard: HazardTile, tickCount: number, stormCycle: boolean) => {
  const cycleTick = tickCount + hazard.offset;
  if (hazard.pattern === 'pulse') return cycleTick % 4 >= 2;
  if (hazard.pattern === 'alternating') return cycleTick % 2 === 0;
  if (stormCycle) return cycleTick % 3 !== 1;
  return cycleTick % 3 === 0;
};

const resolveCollision = (state: GameState, wallsSet: Set<string>, random: RandomSource) => {
  const collided = state.enemies.some((enemy) => toKey(enemy.position) === toKey(state.player));
  if (!collided) return state;

  const collisionEvent: CollisionEffectEvent = {
    random: random.next,
    hadShield: state.shields > 0,
    consumeShield: state.shields > 0,
    preventLoss: false,
    stunAiTicks: 0,
  };

  runUpgradeHook(state.ownedUpgrades, 'on_collision', collisionEvent);

  if (collisionEvent.consumeShield && state.shields > 0) {
    return {
      ...state,
      shields: state.shields - 1,
      enemies: respawnEnemies(state, wallsSet, random),
      aiStunTicks: Math.max(state.aiStunTicks, collisionEvent.stunAiTicks),
    };
  }

  if (collisionEvent.preventLoss) {
    return {
      ...state,
      enemies: respawnEnemies(state, wallsSet, random),
      aiStunTicks: Math.max(state.aiStunTicks, collisionEvent.stunAiTicks),
    };
  }

  return { ...state, status: 'lost' };
};

const resolveHazardDamage = (state: GameState, wallsSet: Set<string>, random: RandomSource) => {
  const stormCycle = state.floorEvents.includes('storm_cycle');
  const playerOnActiveHazard = state.hazards.some(
    (hazard) => toKey(hazard.position) === toKey(state.player) && isHazardActive(hazard, state.tickCount, stormCycle)
  );
  if (!playerOnActiveHazard) return state;

  if (state.shields > 0) {
    return {
      ...state,
      shields: state.shields - 1,
      enemies: respawnEnemies(state, wallsSet, random),
    };
  }

  return { ...state, status: 'lost' };
};

const resolveTargetCollection = (
  state: GameState,
  wallsSet: Set<string>,
  direction: Direction,
  moved: boolean,
  blocked: boolean,
  random: RandomSource
) => {
  const collectedTarget = toKey(state.player) === toKey(state.target);
  const moveEvent: MoveEffectEvent = {
    random: random.next,
    direction,
    moved,
    blocked,
    collectedTarget,
    extraSteps: 0,
    bonusScore: 0,
    ignoreWallsForExtraStep: false,
  };

  runUpgradeHook(state.ownedUpgrades, 'on_move', moveEvent);

  let upgradedState = state;

  if (moveEvent.extraSteps > 0) {
    for (let i = 0; i < moveEvent.extraSteps; i += 1) {
      const extraStep = tryMove(
        upgradedState.player,
        direction,
        wallsSet,
        upgradedState.gridSize,
        moveEvent.ignoreWallsForExtraStep
      );
      if (toKey(extraStep) === toKey(upgradedState.player)) break;
      upgradedState = { ...upgradedState, player: extraStep };
    }
  }

  const didCollectAfterEffects = toKey(upgradedState.player) === toKey(upgradedState.target);

  if (!didCollectAfterEffects) {
    if (moveEvent.bonusScore > 0) {
      return { ...upgradedState, score: upgradedState.score + moveEvent.bonusScore };
    }
    return upgradedState;
  }

  const nextProgress = upgradedState.floorProgress + 1;
  const shieldBonus = (upgradedState.score + 1) % 4 === 0 ? 1 : 0;
  const totalScoreGain = 1 + moveEvent.bonusScore;
  const nextScore = upgradedState.score + totalScoreGain;

  if (nextProgress >= upgradedState.floorTarget) {
    return {
      ...upgradedState,
      score: nextScore,
      shields: upgradedState.shields + shieldBonus,
      floorProgress: nextProgress,
      phase: 'upgrade_draft',
      upgradeChoices: buildUpgradeChoices({
        ownedUpgrades: upgradedState.ownedUpgrades,
        floor: upgradedState.floor,
        score: nextScore,
        shields: upgradedState.shields + shieldBonus,
        threatLevel: upgradedState.threatLevel,
        floorTarget: upgradedState.floorTarget,
      }, random),
    };
  }

  const enemyKeys = upgradedState.enemies.map((enemy) => toKey(enemy.position));
  const hazardKeys = upgradedState.hazards.map((hazard) => toKey(hazard.position));
  const nextTarget = randomOpenCell(
    wallsSet,
    new Set([toKey(upgradedState.player), ...enemyKeys, ...hazardKeys]),
    upgradedState.gridSize,
    random,
    2,
    upgradedState.player
  );

  return {
    ...upgradedState,
    score: nextScore,
    shields: upgradedState.shields + shieldBonus,
    floorProgress: nextProgress,
    target: nextTarget,
  };
};

const gameReducer = (state: GameState, action: Action): GameState => {
  if (action.type === 'START') {
    const utcDate = getUTCDateString();
    const dailySeed = buildDailySeed(utcDate, DAILY_VERSION_SALT);
    const seed = createSessionSeed(action.mode, utcDate, DAILY_VERSION_SALT);
    const fresh = createGameState(action.deviceClass, action.mode, seed, action.mode === 'daily' ? dailySeed : null);
    return {
      ...fresh,
      status: 'playing',
      startedAt: Date.now(),
    };
  }

  if (action.type === 'RESTART') {
    const mode = state.mode;
    const utcDate = getUTCDateString();
    const dailySeed = mode === 'daily' ? buildDailySeed(utcDate, DAILY_VERSION_SALT) : null;
    const seed = mode === 'daily' ? state.rngSeed : createSessionSeed('normal', utcDate, DAILY_VERSION_SALT);
    const fresh = createGameState(action.deviceClass, mode, seed, dailySeed);
    return {
      ...fresh,
      status: 'playing',
      startedAt: Date.now(),
    };
  }

  const random = createRandomSource(state.rngSeed, state.rngCursor);

  if (action.type === 'PICK_UPGRADE') {
    if (state.status !== 'playing' || state.phase !== 'upgrade_draft') return state;
    if (!state.upgradeChoices.includes(action.upgradeId)) return state;

    const nextFloor = state.floor + 1;
    const nextMapTier = getMapTierForFloor(nextFloor);
    const nextGridSize = getGridSizeForFloor(nextFloor, state.deviceClass);
    const nextFloorEvents = getFloorEvents(nextFloor, random);
    const nextLayout = generateFloorLayout(nextFloor, nextGridSize, nextFloorEvents, random);
    const nextOwnedUpgrades = [...state.ownedUpgrades, action.upgradeId];

    const floorEvent: FloorStartEffectEvent = {
      random: random.next,
      floor: nextFloor,
      bonusShields: 0,
      threatDelta: 0,
      floorTargetDelta: 0,
      bonusScore: 0,
    };

    runUpgradeHook(nextOwnedUpgrades, 'on_floor_start', floorEvent);

    const baseThreat = getThreatLevel(nextFloor, nextMapTier, nextFloorEvents);
    const baseTarget = getFloorTarget(nextFloor, nextMapTier, nextFloorEvents);

    return {
      ...state,
      ...nextLayout,
      phase: 'combat',
      floor: nextFloor,
      floorProgress: 0,
      floorEvents: nextFloorEvents,
      tickCount: 0,
      floorTarget: Math.max(3, baseTarget + floorEvent.floorTargetDelta),
      threatLevel: Math.max(1, baseThreat + floorEvent.threatDelta),
      shields: Math.max(0, state.shields + floorEvent.bonusShields + (nextFloorEvents.includes('shield_bonus') ? 1 : 0)),
      score: state.score + floorEvent.bonusScore,
      gridSize: nextGridSize,
      mapTier: nextMapTier,
      ownedUpgrades: nextOwnedUpgrades,
      upgradeChoices: [],
      rngCursor: random.snapshot().cursor,
    };
  }

  const wallsSet = new Set(state.walls);
  if (state.status !== 'playing' || state.phase !== 'combat') return state;

  if (action.type === 'MOVE_PLAYER') {
    const movedPlayer = tryMove(state.player, action.direction, wallsSet, state.gridSize);
    const moved = toKey(movedPlayer) !== toKey(state.player);
    const blocked = !moved;

    const afterMove = resolveTargetCollection({ ...state, player: movedPlayer }, wallsSet, action.direction, moved, blocked, random);
    const resolved = resolveCollision(resolveHazardDamage(afterMove, wallsSet, random), wallsSet, random);
    return {
      ...resolved,
      rngCursor: random.snapshot().cursor,
    };
  }

  if (action.type === 'AI_TICK') {
    if (state.aiStunTicks > 0) {
      const resolved = resolveHazardDamage({ ...state, aiStunTicks: state.aiStunTicks - 1, tickCount: state.tickCount + 1 }, wallsSet, random);
      return {
        ...resolved,
        rngCursor: random.snapshot().cursor,
      };
    }

    const aiEvent: AITickEffectEvent = {
      random: random.next,
      skipMove: false,
      bonusScore: 0,
    };

    runUpgradeHook(state.ownedUpgrades, 'on_ai_tick', aiEvent);

    const movedEnemies = aiEvent.skipMove
      ? state.enemies
      : state.enemies.map((enemy) => moveEnemy(enemy, state, wallsSet, random));
    const nextState = {
      ...state,
      enemies: movedEnemies,
      tickCount: state.tickCount + 1,
      score: state.score + aiEvent.bonusScore,
    };
    const resolved = resolveCollision(resolveHazardDamage(nextState, wallsSet, random), wallsSet, random);
    return {
      ...resolved,
      rngCursor: random.snapshot().cursor,
    };
  }

  return state;
};

const getRarityClass = (rarity: string) => {
  switch (rarity) {
    case 'epic':
      return 'text-fuchsia-400 border-fuchsia-400/30';
    case 'rare':
      return 'text-sky-400 border-sky-400/30';
    case 'uncommon':
      return 'text-emerald-400 border-emerald-400/30';
    default:
      return 'text-muted-foreground border-border';
  }
};

const getCameraWindowSize = (gridSize: number) => {
  if (gridSize >= 16) return 9;
  if (gridSize >= 13) return 11;
  return gridSize;
};

const getTierThreatPreview = (tier: number) => {
  if (tier >= 4) {
    return {
      title: 'Tier Surge Detected',
      notes: ['Elite squads can close distance quickly.', 'Hazard storms stay active longer.'],
    };
  }

  if (tier === 3) {
    return {
      title: 'Advanced Grid Online',
      notes: ['Patrol coverage widens with larger maps.', 'Wall clusters create longer choke lanes.'],
    };
  }

  if (tier === 2) {
    return {
      title: 'Threat Escalation',
      notes: ['Enemy composition now includes tougher mixes.', 'Objectives require more secure pathing.'],
    };
  }

  return {
    title: 'Sector Update',
    notes: ['New floor modifiers may appear.', 'Watch for hazard rhythm shifts.'],
  };
};

const AIGame = () => {
  const [state, dispatch] = useReducer(gameReducer, undefined, createGameState);
  const [now, setNow] = useState(Date.now());
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth));
  const [viewportHeight, setViewportHeight] = useState(() => (typeof window === 'undefined' ? 768 : window.innerHeight));
  const [showFullMap, setShowFullMap] = useState(false);
  const [tierPreview, setTierPreview] = useState<{ tier: number; floor: number; title: string; notes: string[] } | null>(null);
  const stateRef = useRef(state);
  const prevARef = useRef(false);
  const heldDirectionRef = useRef<Direction | null>(null);
  const lastMoveTsRef = useRef(0);
  const prevTierRef = useRef(state.mapTier);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (state.status !== 'playing') return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [state.status]);

  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (state.gridSize <= 12 && showFullMap) {
      setShowFullMap(false);
    }
  }, [showFullMap, state.gridSize]);

  useEffect(() => {
    if (state.status !== 'playing' || state.phase !== 'combat') {
      prevTierRef.current = state.mapTier;
      return;
    }

    const previousTier = prevTierRef.current;
    if (state.mapTier > previousTier) {
      const preview = getTierThreatPreview(state.mapTier);
      setTierPreview({ tier: state.mapTier, floor: state.floor, ...preview });
      const timeout = window.setTimeout(() => setTierPreview(null), 4200);
      prevTierRef.current = state.mapTier;
      return () => window.clearTimeout(timeout);
    }

    prevTierRef.current = state.mapTier;
    return undefined;
  }, [state.floor, state.mapTier, state.phase, state.status]);

  useEffect(() => {
    if (state.status !== 'playing' || state.phase !== 'combat') return;
    const interval = window.setInterval(
      () => dispatch({ type: 'AI_TICK' }),
      getAIIntervalForFloor(state.floor, state.threatLevel)
    );
    return () => window.clearInterval(interval);
  }, [state.floor, state.phase, state.status, state.threatLevel]);

  const getDeviceClass = useCallback(
    (): DeviceClass => (typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches ? 'narrow' : 'standard'),
    []
  );

  const startNormal = useCallback(() => {
    dispatch({ type: 'START', deviceClass: getDeviceClass(), mode: 'normal' });
  }, [getDeviceClass]);

  const restartCurrent = useCallback(() => {
    dispatch({ type: 'RESTART', deviceClass: getDeviceClass() });
  }, [getDeviceClass]);

  const startDaily = useCallback(() => {
    dispatch({ type: 'START', deviceClass: getDeviceClass(), mode: 'daily' });
  }, [getDeviceClass]);

  const handleDirection = useCallback((direction: Direction) => {
    if (stateRef.current.status !== 'playing' || stateRef.current.phase !== 'combat') return;
    dispatch({ type: 'MOVE_PLAYER', direction });
  }, []);

  const handleGridCellClick = useCallback(
    (x: number, y: number) => {
      const current = stateRef.current;
      if (current.status !== 'playing' || current.phase !== 'combat') return;

      const dx = x - current.player.x;
      const dy = y - current.player.y;
      if (Math.abs(dx) + Math.abs(dy) !== 1) return;

      if (dx === 1) handleDirection('right');
      if (dx === -1) handleDirection('left');
      if (dy === 1) handleDirection('down');
      if (dy === -1) handleDirection('up');
    },
    [handleDirection]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (key === ' ' || key === 'enter' || key === 'r') {
        event.preventDefault();
        if (stateRef.current.status !== 'playing') {
          startNormal();
        }
        return;
      }

      const keyToDirection: Record<string, Direction> = {
        arrowup: 'up',
        w: 'up',
        arrowdown: 'down',
        s: 'down',
        arrowleft: 'left',
        a: 'left',
        arrowright: 'right',
        d: 'right',
      };
      const direction = keyToDirection[key];
      if (!direction) return;

      event.preventDefault();
      handleDirection(direction);
    },
    [handleDirection, startNormal]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    const onConnectChange = () => {
      setGamepadConnected(navigator.getGamepads?.().some((gamepad) => gamepad !== null) ?? false);
    };

    window.addEventListener('gamepadconnected', onConnectChange);
    window.addEventListener('gamepaddisconnected', onConnectChange);
    onConnectChange();

    return () => {
      window.removeEventListener('gamepadconnected', onConnectChange);
      window.removeEventListener('gamepaddisconnected', onConnectChange);
    };
  }, []);

  useEffect(() => {
    let frame = 0;

    const pollGamepads = () => {
      const gamepads = navigator.getGamepads?.();
      const current = Date.now();

      let direction: Direction | null = null;
      let aPressed = false;

      if (gamepads) {
        for (let i = 0; i < gamepads.length; i += 1) {
          const gp = gamepads[i];
          if (!gp) continue;
          const nextDirection = getDirectionFromGamepad(gp);
          if (nextDirection && !direction) {
            direction = nextDirection;
          }

          aPressed = aPressed || gp.buttons[0]?.pressed || gp.buttons[9]?.pressed;
        }
      }

      if (aPressed && !prevARef.current && stateRef.current.status !== 'playing') {
        startNormal();
      }
      prevARef.current = aPressed;

      if (direction) {
        const canMove =
          heldDirectionRef.current !== direction || current - lastMoveTsRef.current > CONTROLLER_REPEAT_MS;
        if (canMove) {
          handleDirection(direction);
          lastMoveTsRef.current = current;
          heldDirectionRef.current = direction;
        }
      } else {
        heldDirectionRef.current = null;
      }

      frame = requestAnimationFrame(pollGamepads);
    };

    frame = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(frame);
  }, [handleDirection, startNormal]);

  const elapsedSeconds = useMemo(() => {
    if (!state.startedAt) return 0;
    return Math.floor((now - state.startedAt) / 1000);
  }, [now, state.startedAt]);

  const statusLabel = useMemo(() => {
    if (state.status === 'idle') return 'Clear each floor objective to reach the next sector.';
    if (state.status === 'lost') return 'You were intercepted. Reboot and try a new route.';
    if (state.phase === 'upgrade_draft') return 'Floor cleared. Choose one upgrade to push deeper.';
    return 'Steal data, track hazard timing, and avoid enemy squads.';
  }, [state.phase, state.status]);

  const wallsSet = useMemo(() => new Set(state.walls), [state.walls]);
  const ownedUpgradeDetails = useMemo(() => getOwnedUpgradeDefs(state.ownedUpgrades), [state.ownedUpgrades]);
  const draftChoices = useMemo(
    () => state.upgradeChoices.map((id) => UPGRADE_MAP.get(id)).filter(Boolean),
    [state.upgradeChoices]
  );

  const stormCycle = state.floorEvents.includes('storm_cycle');
  const isMobileLayout = viewportWidth < 640;
  const boardWrapPadding = isMobileLayout ? 20 : 16;
  const availableWidth = Math.max(220, Math.min(viewportWidth - boardWrapPadding * 2, 560));
  const mobileBoardBudget = Math.max(190, viewportHeight - MOBILE_CONTROL_FOOTER - 280);
  const boardMaxPixel = isMobileLayout ? Math.min(availableWidth, mobileBoardBudget) : Math.min(availableWidth, 520);
  const cellPixel = Math.max(16, Math.floor(boardMaxPixel / state.gridSize));
  const cameraWindow = getCameraWindowSize(state.gridSize);
  const shouldUseCamera = state.gridSize > cameraWindow && !showFullMap;
  const halfCamera = Math.floor(cameraWindow / 2);
  const startX = shouldUseCamera ? Math.max(0, Math.min(state.gridSize - cameraWindow, state.player.x - halfCamera)) : 0;
  const startY = shouldUseCamera ? Math.max(0, Math.min(state.gridSize - cameraWindow, state.player.y - halfCamera)) : 0;
  const visibleGridSize = shouldUseCamera ? cameraWindow : state.gridSize;
  const visibleCells = useMemo(() => {
    return Array.from({ length: visibleGridSize * visibleGridSize }).map((_, index) => {
      const x = startX + (index % visibleGridSize);
      const y = startY + Math.floor(index / visibleGridSize);
      return { x, y, key: toKey({ x, y }) };
    });
  }, [startX, startY, visibleGridSize]);

  const floorEventLabels: Record<FloorEventModifier, string> = {
    dense_walls: 'Dense Walls',
    double_target: 'Double Target',
    storm_cycle: 'Storm Cycle',
    shield_bonus: 'Shield Bonus',
  };

  return (
    <Card className="border bg-gradient-to-br from-violet-500/5 via-background to-cyan-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-accent" />
            AI Game
          </span>
          {gamepadConnected && (
            <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
              <Gamepad2 className="h-3.5 w-3.5" />
              Controller
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{statusLabel}</p>

        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="text-[11px] gap-1">
            <Keyboard className="h-3 w-3" />
            WASD / Arrows
          </Badge>
          <Badge variant="secondary" className="text-[11px] gap-1">
            <Gamepad2 className="h-3 w-3" />
            D-pad / Stick + A
          </Badge>
          <Badge variant="outline" className="text-[11px]">
            Touch pad on mobile
          </Badge>
          {state.mode === 'daily' && state.dailySeedLabel && (
            <Badge variant="outline" className="text-[11px] border-cyan-500/40 text-cyan-700 dark:text-cyan-200">
              Daily · {state.dailySeedLabel}
            </Badge>
          )}
        </div>

        {state.floorEvents.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {state.floorEvents.map((modifier) => (
              <Badge key={modifier} variant="outline" className="text-[11px] border-amber-400/40 text-amber-700 dark:text-amber-200">
                {floorEventLabels[modifier]}
              </Badge>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Floor</div>
            <div className="font-semibold">{state.floor} (Tier {state.mapTier})</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Map Size</div>
            <div className="font-semibold">{state.gridSize} × {state.gridSize}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Objective</div>
            <div className="font-semibold">{state.floorProgress} / {state.floorTarget} DATA</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Shield</div>
            <div className="font-semibold">{state.shields}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Threat</div>
            <div className="font-semibold">Lv {state.threatLevel}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Time</div>
            <div className="font-semibold">{elapsedSeconds}s</div>
          </div>
        </div>

        {ownedUpgradeDetails.length > 0 && (
          <div className="rounded-md border bg-background/70 p-2 space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Active Upgrades</div>
            <div className="flex flex-wrap gap-2">
              {ownedUpgradeDetails.map((upgrade) => (
                <div key={upgrade.id} className={`rounded border px-2 py-1 text-[11px] ${getRarityClass(upgrade.rarity)}`}>
                  <span className="font-semibold">{upgrade.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tierPreview && (
          <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs">
            <div className="font-semibold text-amber-900 dark:text-amber-100">
              {tierPreview.title} · Tier {tierPreview.tier} (Floor {tierPreview.floor})
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-900/90 dark:text-amber-100/90">
              {tierPreview.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        {state.gridSize > 12 && (
          <div className="flex items-center justify-between rounded-md border bg-background/70 px-3 py-2 text-xs">
            <div className="text-muted-foreground">
              {shouldUseCamera
                ? `Focused view centered near your position (${cameraWindow}×${cameraWindow}).`
                : 'Full-map overview enabled for scouting.'}
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowFullMap((prev) => !prev)}>
              {showFullMap ? 'Focus Camera' : 'Show Full Map'}
            </Button>
          </div>
        )}

        <div className="relative rounded-lg border bg-muted/20 p-2">
          <div
            className="grid gap-1 mx-auto"
            style={{
              gridTemplateColumns: `repeat(${visibleGridSize}, ${cellPixel}px)`,
              maxWidth: `${visibleGridSize * cellPixel}px`,
            }}
          >
            {visibleCells.map(({ x, y, key }) => {
              const isWall = wallsSet.has(key);
              const isPlayer = toKey(state.player) === key;
              const enemy = state.enemies.find((unit) => toKey(unit.position) === key);
              const isTarget = toKey(state.target) === key;
              const hazard = state.hazards.find((tile) => toKey(tile.position) === key);
              const isHazardActiveNow = hazard ? isHazardActive(hazard, state.tickCount, stormCycle) : false;

              let cellClass = 'bg-background/95';
              if (isWall) cellClass = 'bg-slate-700/35 border-slate-500/70';
              if (hazard) {
                cellClass = isHazardActiveNow
                  ? 'bg-orange-600/40 ring-1 ring-orange-400/90 border-orange-300/80'
                  : 'bg-orange-500/15 border-orange-400/45';
              }
              if (isTarget) cellClass = 'bg-cyan-500/30 border-cyan-300/80';
              if (enemy) {
                cellClass =
                  enemy.archetype === 'elite'
                    ? 'bg-fuchsia-500/35 border-fuchsia-300/90'
                    : enemy.archetype === 'patrol'
                      ? 'bg-amber-500/35 border-amber-300/90'
                      : 'bg-red-500/30 border-red-300/90';
              }
              if (isPlayer) cellClass = 'bg-emerald-500/45 border-emerald-200';

              return (
                <div
                  key={key}
                  className={`relative rounded-[5px] border ${cellClass}`}
                  style={{ width: `${cellPixel}px`, height: `${cellPixel}px` }}
                  onClick={() => handleGridCellClick(x, y)}
                  onPointerDown={() => handleGridCellClick(x, y)}
                >
                  {isWall && !isTarget && !enemy && !isPlayer && (
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-slate-300">▦</span>
                  )}
                  {isTarget && !isPlayer && (
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-cyan-950 dark:text-cyan-100">
                      ◈
                    </span>
                  )}
                  {hazard && !enemy && !isPlayer && (
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-orange-950 dark:text-orange-50">
                      {isHazardActiveNow ? '⚠' : '△'}
                    </span>
                  )}
                  {enemy && (
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-red-950 dark:text-red-100">
                      {enemy.archetype === 'hunter' ? '◆' : enemy.archetype === 'elite' ? '✦' : '▸'}
                    </span>
                  )}
                  {isPlayer && (
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-emerald-950 dark:text-emerald-50">
                      ⬢
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">⬢ Player</span>
            <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">◈ Target</span>
            <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">▦ Wall</span>
            <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">△/⚠ Hazard</span>
            <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">▸/◆/✦ Enemy</span>
          </div>

          {state.status === 'playing' && state.phase === 'upgrade_draft' && (
            <div className="absolute inset-0 bg-background/80 backdrop-blur-[1px] rounded-lg p-3 flex items-center">
              <div className="w-full space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upgrade Draft</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {draftChoices.map((option) => (
                    <Button
                      key={option.id}
                      type="button"
                      variant="outline"
                      className="h-auto flex-col items-start gap-1 p-3 text-left"
                      onClick={() => dispatch({ type: 'PICK_UPGRADE', upgradeId: option.id })}
                    >
                      <span className="font-semibold text-sm">{option.name}</span>
                      <span className="text-[11px] text-muted-foreground capitalize">{option.rarity}</span>
                      <span className="text-[11px] text-muted-foreground whitespace-normal">{option.description}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          {state.status === 'playing' ? (
            <Button variant="outline" className="w-full" onClick={restartCurrent}>
              New Run
            </Button>
          ) : (
            <>
              <Button className="w-full" onClick={startNormal}>
                {state.status === 'idle' ? 'Start Normal' : 'Play Normal'}
              </Button>
              <Button variant="outline" className="w-full" onClick={startDaily}>
                {state.status === 'idle' ? 'Start Daily' : 'Play Daily'}
              </Button>
            </>
          )}
        </div>

        <div className="sm:hidden sticky bottom-0 z-10 -mx-4 mt-1 border-t bg-background/95 px-4 pb-2 pt-2 backdrop-blur">
          <div className="mx-auto grid w-[176px] grid-cols-3 gap-2">
            <div />
            <Button variant="secondary" size="icon" onClick={() => handleDirection('up')} aria-label="Move up">
              <ArrowUp className="h-4 w-4" />
            </Button>
            <div />
            <Button variant="secondary" size="icon" onClick={() => handleDirection('left')} aria-label="Move left">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={() => handleDirection('down')} aria-label="Move down">
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={() => handleDirection('right')} aria-label="Move right">
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default AIGame;
