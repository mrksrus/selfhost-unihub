import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bot, Gamepad2, Keyboard } from 'lucide-react';

const INITIAL_AI_INTERVAL = 980;
const MIN_AI_INTERVAL = 320;
const CONTROLLER_DEADZONE = 0.45;
const CONTROLLER_REPEAT_MS = 155;
const MOBILE_MAX_GRID_SIZE = 15;

type GameStatus = 'idle' | 'playing' | 'lost';
type GamePhase = 'combat' | 'upgrade_draft';
type Direction = 'up' | 'down' | 'left' | 'right';
type UpgradeOption = 'shield_boost' | 'threat_disruptor' | 'objective_trim';

interface Point {
  x: number;
  y: number;
}

interface GameState {
  status: GameStatus;
  phase: GamePhase;
  player: Point;
  ai: Point;
  target: Point;
  walls: string[];
  score: number;
  shields: number;
  startedAt: number | null;
  floor: number;
  floorProgress: number;
  floorTarget: number;
  threatLevel: number;
  gridSize: number;
  mapTier: number;
}

type Action =
  | { type: 'START' }
  | { type: 'MOVE_PLAYER'; direction: Direction }
  | { type: 'AI_TICK' }
  | { type: 'PICK_UPGRADE'; option: UpgradeOption }
  | { type: 'RESTART' };

const DIRECTION_VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const UPGRADE_OPTIONS: { value: UpgradeOption; label: string; description: string }[] = [
  {
    value: 'shield_boost',
    label: 'Shield Boost',
    description: '+1 shield for the next floor.',
  },
  {
    value: 'threat_disruptor',
    label: 'Threat Disruptor',
    description: '-1 threat level next floor (min 1).',
  },
  {
    value: 'objective_trim',
    label: 'Objective Trim',
    description: '-1 data node required next floor (min 3).',
  },
];

const toKey = ({ x, y }: Point) => `${x},${y}`;

const fromKey = (value: string): Point => {
  const [x, y] = value.split(',').map(Number);
  return { x, y };
};

const inBounds = ({ x, y }: Point, gridSize: number) => x >= 0 && x < gridSize && y >= 0 && y < gridSize;

const randomInt = (maxExclusive: number) => Math.floor(Math.random() * maxExclusive);

const getMapTierForFloor = (floor: number) => Math.min(5, 1 + Math.floor((floor - 1) / 8));

const getGridSizeForFloor = (floor: number) => {
  const earlyGrowth = Math.min(2, Math.floor((floor - 1) / 5));
  const earlySize = 9 + earlyGrowth * 2;
  if (floor <= 15) return earlySize;

  const lateGrowth = Math.floor((floor - 15) / 9);
  return Math.min(MOBILE_MAX_GRID_SIZE, earlySize + lateGrowth * 2);
};

const getWallDensity = (floor: number, mapTier: number) => {
  const baseDensity = 0.15;
  const tierBump = (mapTier - 1) * 0.012;
  const floorBump = Math.min(0.045, floor * 0.0018);
  return Math.min(0.24, baseDensity + tierBump + floorBump);
};

const getWallCount = (gridSize: number, floor: number, mapTier: number) => {
  const totalCells = gridSize * gridSize;
  const density = getWallDensity(floor, mapTier);
  const suggested = Math.round(totalCells * density);
  const reserved = 10;
  return Math.min(suggested, totalCells - reserved);
};

const getFloorTarget = (floor: number, mapTier: number) => Math.min(9, 3 + Math.floor((floor - 1) / 3) + Math.floor(mapTier / 2));

const getThreatLevel = (floor: number, mapTier: number) => 1 + Math.floor((floor - 1) / 2) + mapTier;

const randomOpenCell = (walls: Set<string>, excluded: Set<string>, gridSize: number) => {
  const options: Point[] = [];
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const key = toKey({ x, y });
      if (!walls.has(key) && !excluded.has(key)) {
        options.push({ x, y });
      }
    }
  }
  if (options.length === 0) return { x: 1, y: 1 };
  return options[randomInt(options.length)];
};

const chooseAIStart = (walls: Set<string>, gridSize: number) => {
  const corners: Point[] = [
    { x: gridSize - 1, y: gridSize - 1 },
    { x: gridSize - 1, y: 0 },
    { x: 0, y: gridSize - 1 },
    { x: 0, y: 0 },
  ];
  for (const corner of corners) {
    if (!walls.has(toKey(corner))) return corner;
  }
  return randomOpenCell(walls, new Set([toKey({ x: 0, y: 0 })]), gridSize);
};

const generateWalls = (gridSize: number, floor: number, mapTier: number) => {
  const walls = new Set<string>();
  const wallCount = getWallCount(gridSize, floor, mapTier);
  const protectedCells = new Set<string>([
    toKey({ x: 0, y: 0 }),
    toKey({ x: gridSize - 1, y: gridSize - 1 }),
    toKey({ x: gridSize - 1, y: 0 }),
    toKey({ x: 0, y: gridSize - 1 }),
  ]);

  while (walls.size < wallCount) {
    const candidate = { x: randomInt(gridSize), y: randomInt(gridSize) };
    const key = toKey(candidate);
    if (protectedCells.has(key)) continue;
    walls.add(key);
  }

  return walls;
};

const generateFloorLayout = (floor: number, mapTier: number, gridSize: number) => {
  const walls = generateWalls(gridSize, floor, mapTier);
  const player = { x: 0, y: 0 };
  const ai = chooseAIStart(walls, gridSize);
  const target = randomOpenCell(walls, new Set([toKey(player), toKey(ai)]), gridSize);

  return {
    player,
    ai,
    target,
    walls: Array.from(walls),
  };
};

const getAIInterval = (threatLevel: number) => Math.max(MIN_AI_INTERVAL, INITIAL_AI_INTERVAL - threatLevel * 58);

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

const createGameState = (): GameState => {
  const floor = 1;
  const mapTier = getMapTierForFloor(floor);
  const gridSize = getGridSizeForFloor(floor);
  const layout = generateFloorLayout(floor, mapTier, gridSize);

  return {
    status: 'idle',
    phase: 'combat',
    ...layout,
    score: 0,
    shields: 1,
    startedAt: null,
    floor,
    floorProgress: 0,
    floorTarget: getFloorTarget(floor, mapTier),
    threatLevel: getThreatLevel(floor, mapTier),
    gridSize,
    mapTier,
  };
};

const tryMove = (origin: Point, direction: Direction, wallsSet: Set<string>, gridSize: number) => {
  const next = {
    x: origin.x + DIRECTION_VECTORS[direction].x,
    y: origin.y + DIRECTION_VECTORS[direction].y,
  };
  if (!inBounds(next, gridSize)) return origin;
  if (wallsSet.has(toKey(next))) return origin;
  return next;
};

const moveAI = (state: GameState, wallsSet: Set<string>) => {
  const startKey = toKey(state.ai);
  const goalKey = toKey(state.player);
  if (startKey === goalKey) return state.ai;

  const queue: Point[] = [state.ai];
  const visited = new Set<string>([startKey]);
  const previous = new Map<string, string>();
  const directions: Direction[] = ['up', 'down', 'left', 'right'];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (toKey(current) === goalKey) break;

    for (const direction of directions) {
      const next = tryMove(current, direction, wallsSet, state.gridSize);
      const nextKey = toKey(next);
      if (nextKey === toKey(current) || visited.has(nextKey)) continue;
      visited.add(nextKey);
      previous.set(nextKey, toKey(current));
      queue.push(next);
    }
  }

  if (!visited.has(goalKey)) {
    const choices = directions
      .map((direction) => tryMove(state.ai, direction, wallsSet, state.gridSize))
      .filter((candidate) => toKey(candidate) !== toKey(state.ai));
    if (choices.length === 0) return state.ai;
    return choices[randomInt(choices.length)];
  }

  let currentKey = goalKey;
  let parent = previous.get(currentKey);
  while (parent && parent !== startKey) {
    currentKey = parent;
    parent = previous.get(currentKey);
  }

  return fromKey(currentKey);
};

const resolveState = (state: GameState, wallsSet: Set<string>): GameState => {
  if (toKey(state.player) === toKey(state.ai)) {
    if (state.shields > 0) {
      const resetAI = chooseAIStart(wallsSet, state.gridSize);
      return {
        ...state,
        ai: resetAI,
        shields: state.shields - 1,
      };
    }
    return { ...state, status: 'lost' };
  }

  if (toKey(state.player) === toKey(state.target)) {
    const nextProgress = state.floorProgress + 1;
    const nextScore = state.score + 1;
    const shieldBonus = nextScore % 4 === 0 ? 1 : 0;

    if (nextProgress >= state.floorTarget) {
      return {
        ...state,
        score: nextScore,
        shields: state.shields + shieldBonus,
        floorProgress: nextProgress,
        phase: 'upgrade_draft',
      };
    }

    const nextTarget = randomOpenCell(wallsSet, new Set([toKey(state.player), toKey(state.ai)]), state.gridSize);

    return {
      ...state,
      score: nextScore,
      shields: state.shields + shieldBonus,
      floorProgress: nextProgress,
      target: nextTarget,
    };
  }

  return state;
};

const gameReducer = (state: GameState, action: Action): GameState => {
  if (action.type === 'START' || action.type === 'RESTART') {
    const fresh = createGameState();
    return {
      ...fresh,
      status: 'playing',
      startedAt: Date.now(),
    };
  }

  if (action.type === 'PICK_UPGRADE') {
    if (state.status !== 'playing' || state.phase !== 'upgrade_draft') return state;

    const nextFloor = state.floor + 1;
    const nextMapTier = getMapTierForFloor(nextFloor);
    const nextGridSize = getGridSizeForFloor(nextFloor);
    const nextLayout = generateFloorLayout(nextFloor, nextMapTier, nextGridSize);

    let nextShields = state.shields;
    let nextThreatLevel = getThreatLevel(nextFloor, nextMapTier);
    let nextFloorTarget = getFloorTarget(nextFloor, nextMapTier);

    if (action.option === 'shield_boost') {
      nextShields += 1;
    }
    if (action.option === 'threat_disruptor') {
      nextThreatLevel = Math.max(1, nextThreatLevel - 1);
    }
    if (action.option === 'objective_trim') {
      nextFloorTarget = Math.max(3, nextFloorTarget - 1);
    }

    return {
      ...state,
      ...nextLayout,
      phase: 'combat',
      floor: nextFloor,
      floorProgress: 0,
      floorTarget: nextFloorTarget,
      threatLevel: nextThreatLevel,
      shields: nextShields,
      gridSize: nextGridSize,
      mapTier: nextMapTier,
    };
  }

  const wallsSet = new Set(state.walls);
  if (state.status !== 'playing' || state.phase !== 'combat') return state;

  if (action.type === 'MOVE_PLAYER') {
    const movedPlayer = tryMove(state.player, action.direction, wallsSet, state.gridSize);
    return resolveState({ ...state, player: movedPlayer }, wallsSet);
  }

  if (action.type === 'AI_TICK') {
    const nextAi = moveAI(state, wallsSet);
    return resolveState({ ...state, ai: nextAi }, wallsSet);
  }

  return state;
};

const AIGame = () => {
  const [state, dispatch] = useReducer(gameReducer, undefined, createGameState);
  const [now, setNow] = useState(Date.now());
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const stateRef = useRef(state);
  const prevARef = useRef(false);
  const heldDirectionRef = useRef<Direction | null>(null);
  const lastMoveTsRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (state.status !== 'playing') return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [state.status]);

  useEffect(() => {
    if (state.status !== 'playing' || state.phase !== 'combat') return;
    const interval = window.setInterval(
      () => dispatch({ type: 'AI_TICK' }),
      getAIInterval(state.threatLevel)
    );
    return () => window.clearInterval(interval);
  }, [state.phase, state.status, state.threatLevel]);

  const startOrRestart = useCallback(() => {
    dispatch({ type: state.status === 'idle' ? 'START' : 'RESTART' });
  }, [state.status]);

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
          startOrRestart();
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
    [handleDirection, startOrRestart]
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
        startOrRestart();
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
  }, [handleDirection, startOrRestart]);

  const elapsedSeconds = useMemo(() => {
    if (!state.startedAt) return 0;
    return Math.floor((now - state.startedAt) / 1000);
  }, [now, state.startedAt]);

  const statusLabel = useMemo(() => {
    if (state.status === 'idle') return 'Clear each floor objective to reach the next sector.';
    if (state.status === 'lost') return 'Hunter caught you. Run it back.';
    if (state.phase === 'upgrade_draft') return 'Floor cleared. Choose one upgrade to push deeper.';
    return 'Steal data and avoid the hunter. Threat increases every floor.';
  }, [state.phase, state.status]);

  const wallsSet = useMemo(() => new Set(state.walls), [state.walls]);

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
        </div>

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

        <div className="rounded-lg border bg-muted/20 p-2">
          <div
            className="grid gap-1 mx-auto"
            style={{
              gridTemplateColumns: `repeat(${state.gridSize}, minmax(0, 1fr))`,
              maxWidth: '420px',
            }}
          >
            {Array.from({ length: state.gridSize * state.gridSize }).map((_, index) => {
              const x = index % state.gridSize;
              const y = Math.floor(index / state.gridSize);
              const point = { x, y };
              const key = toKey(point);
              const isWall = wallsSet.has(key);
              const isPlayer = toKey(state.player) === key;
              const isAI = toKey(state.ai) === key;
              const isTarget = toKey(state.target) === key;

              let cellClass = 'bg-background';
              if (isWall) cellClass = 'bg-slate-500/25';
              if (isTarget) cellClass = 'bg-cyan-500/25';
              if (isAI) cellClass = 'bg-red-500/30';
              if (isPlayer) cellClass = 'bg-accent/50';

              return (
                <div
                  key={key}
                  className={`relative aspect-square rounded-[4px] border border-border/40 ${cellClass}`}
                  onClick={() => handleGridCellClick(x, y)}
                  onPointerDown={() => handleGridCellClick(x, y)}
                >
                  {isTarget && !isPlayer && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] text-cyan-900 dark:text-cyan-200">
                      DATA
                    </span>
                  )}
                  {isAI && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] text-red-900 dark:text-red-100">
                      AI
                    </span>
                  )}
                  {isPlayer && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-accent-foreground">
                      YOU
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {state.status === 'playing' && state.phase === 'upgrade_draft' && (
          <div className="rounded-md border bg-background/80 p-3 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upgrade Draft</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {UPGRADE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant="outline"
                  className="h-auto flex-col items-start gap-1 p-3 text-left"
                  onClick={() => dispatch({ type: 'PICK_UPGRADE', option: option.value })}
                >
                  <span className="font-semibold text-sm">{option.label}</span>
                  <span className="text-[11px] text-muted-foreground whitespace-normal">{option.description}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {state.status === 'playing' ? (
            <Button variant="outline" className="w-full" onClick={() => dispatch({ type: 'RESTART' })}>
              New Run
            </Button>
          ) : (
            <Button className="w-full" onClick={startOrRestart}>
              {state.status === 'idle' ? 'Start Run' : 'Play Again'}
            </Button>
          )}
        </div>

        <div className="sm:hidden pt-1">
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
