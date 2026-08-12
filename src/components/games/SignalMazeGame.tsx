import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RadioTower, RotateCcw } from 'lucide-react';

const COLS = 11;
const ROWS = 11;
const START = { x: 0, y: 0 };
const GOAL = { x: COLS - 1, y: ROWS - 1 };
const DIRECTIONS = [
  { dx: 0, dy: -1, wall: 0, opposite: 2 },
  { dx: 1, dy: 0, wall: 1, opposite: 3 },
  { dx: 0, dy: 1, wall: 2, opposite: 0 },
  { dx: -1, dy: 0, wall: 3, opposite: 1 },
] as const;

type Point = { x: number; y: number };
type Maze = boolean[][][];

const generateMaze = (): Maze => {
  const maze = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => [true, true, true, true]));
  const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const stack: Point[] = [{ ...START }];
  visited[0][0] = true;

  while (stack.length) {
    const current = stack[stack.length - 1];
    const options = DIRECTIONS.map((direction) => ({
      ...direction,
      x: current.x + direction.dx,
      y: current.y + direction.dy,
    })).filter((next) => next.x >= 0 && next.x < COLS && next.y >= 0 && next.y < ROWS && !visited[next.y][next.x]);
    if (!options.length) {
      stack.pop();
      continue;
    }
    const next = options[Math.floor(Math.random() * options.length)];
    maze[current.y][current.x][next.wall] = false;
    maze[next.y][next.x][next.opposite] = false;
    visited[next.y][next.x] = true;
    stack.push({ x: next.x, y: next.y });
  }
  return maze;
};

const SignalMazeGame = () => {
  const [maze, setMaze] = useState<Maze>(() => generateMaze());
  const [player, setPlayer] = useState<Point>({ ...START });
  const [moves, setMoves] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedMs, setFinishedMs] = useState<number | null>(null);
  const [bestMs, setBestMs] = useState(() => Number(window.localStorage.getItem('unihub:signal-maze:best') || 0));

  const won = player.x === GOAL.x && player.y === GOAL.y;

  const reset = useCallback(() => {
    setMaze(generateMaze());
    setPlayer({ ...START });
    setMoves(0);
    setStartedAt(null);
    setFinishedMs(null);
  }, []);

  const move = useCallback((directionIndex: number) => {
    if (won) return;
    if (maze[player.y][player.x][directionIndex]) return;
    const direction = DIRECTIONS[directionIndex];
    const startTime = startedAt ?? Date.now();
    if (startedAt === null) setStartedAt(startTime);
    const next = { x: player.x + direction.dx, y: player.y + direction.dy };
    setPlayer(next);
    setMoves((value) => value + 1);
    if (next.x === GOAL.x && next.y === GOAL.y) {
      const duration = Date.now() - startTime;
      setFinishedMs(duration);
      if (!bestMs || duration < bestMs) {
        setBestMs(duration);
        window.localStorage.setItem('unihub:signal-maze:best', String(duration));
      }
    }
  }, [bestMs, maze, player.x, player.y, startedAt, won]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const keyMap: Record<string, number> = { arrowup: 0, w: 0, arrowright: 1, d: 1, arrowdown: 2, s: 2, arrowleft: 3, a: 3 };
      const direction = keyMap[event.key.toLowerCase()];
      if (direction !== undefined) {
        event.preventDefault();
        move(direction);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move]);

  const formattedBest = useMemo(() => bestMs ? `${(bestMs / 1000).toFixed(1)}s` : '—', [bestMs]);

  return (
    <Card className="overflow-hidden border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-background to-sky-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-lg">
          <span className="flex items-center gap-2"><RadioTower className="h-5 w-5 text-emerald-500" />Signal Maze</span>
          <Badge variant="secondary">No game loop</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Route the teal signal to the amber receiver. Each maze is generated on your device and the game is idle between moves.</p>
        <div className="grid items-start gap-5 md:grid-cols-[minmax(240px,390px)_1fr]">
          <div className="mx-auto grid aspect-square w-full max-w-[390px] overflow-hidden rounded-xl border-2 border-slate-700 bg-slate-950 p-1" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
            {maze.flatMap((row, y) => row.map((walls, x) => {
              const isPlayer = player.x === x && player.y === y;
              const isGoal = GOAL.x === x && GOAL.y === y;
              return (
                <div key={`${x}-${y}`} className="relative aspect-square" style={{ borderTop: walls[0] ? '2px solid rgb(71 85 105)' : '2px solid transparent', borderRight: walls[1] ? '2px solid rgb(71 85 105)' : '2px solid transparent', borderBottom: walls[2] ? '2px solid rgb(71 85 105)' : '2px solid transparent', borderLeft: walls[3] ? '2px solid rgb(71 85 105)' : '2px solid transparent' }}>
                  {isGoal && <span className="absolute inset-[20%] rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.8)]" />}
                  {isPlayer && <span className="absolute inset-[15%] rounded-full bg-teal-400 shadow-[0_0_14px_rgba(45,212,191,0.9)]" />}
                </div>
              );
            }))}
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-center text-sm">
              <div className="rounded-lg border bg-background/70 p-3"><p className="text-xs text-muted-foreground">Moves</p><p className="text-xl font-semibold tabular-nums">{moves}</p></div>
              <div className="rounded-lg border bg-background/70 p-3"><p className="text-xs text-muted-foreground">Best time</p><p className="text-xl font-semibold tabular-nums">{formattedBest}</p></div>
            </div>
            {won && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-center text-sm font-medium">Signal connected in {moves} moves{finishedMs ? ` · ${(finishedMs / 1000).toFixed(1)}s` : ''}.</div>}
            <div className="mx-auto grid w-[176px] grid-cols-3 gap-2">
              <div /><Control label="Move up" onClick={() => move(0)}><ArrowUp className="h-5 w-5" /></Control><div />
              <Control label="Move left" onClick={() => move(3)}><ArrowLeft className="h-5 w-5" /></Control>
              <Control label="Move down" onClick={() => move(2)}><ArrowDown className="h-5 w-5" /></Control>
              <Control label="Move right" onClick={() => move(1)}><ArrowRight className="h-5 w-5" /></Control>
            </div>
            <Button className="w-full" variant="outline" onClick={reset}><RotateCcw className="mr-2 h-4 w-4" />New maze</Button>
            <p className="text-center text-xs text-muted-foreground">Arrow keys / WASD or touch controls</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const Control = ({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) => (
  <Button className="h-12 touch-manipulation" variant="secondary" onClick={onClick} aria-label={label}>{children}</Button>
);

export default SignalMazeGame;
