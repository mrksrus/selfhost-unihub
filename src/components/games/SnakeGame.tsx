import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';

const GRID_WIDTH = 18;
const GRID_HEIGHT = 14;
const CONTROLLER_DEADZONE = 0.45;
const CONTROLLER_REPEAT_MS = 130;

type Direction = 'up' | 'down' | 'left' | 'right';
type GameStatus = 'idle' | 'playing' | 'gameover';

interface Point {
  x: number;
  y: number;
}

const randomFood = (snake: Point[]): Point => {
  let candidate: Point = { x: 0, y: 0 };
  const occupied = new Set(snake.map((segment) => `${segment.x},${segment.y}`));
  do {
    candidate = {
      x: Math.floor(Math.random() * GRID_WIDTH),
      y: Math.floor(Math.random() * GRID_HEIGHT),
    };
  } while (occupied.has(`${candidate.x},${candidate.y}`));
  return candidate;
};

const moveHead = (head: Point, direction: Direction): Point => {
  if (direction === 'up') return { x: head.x, y: (head.y - 1 + GRID_HEIGHT) % GRID_HEIGHT };
  if (direction === 'down') return { x: head.x, y: (head.y + 1) % GRID_HEIGHT };
  if (direction === 'left') return { x: (head.x - 1 + GRID_WIDTH) % GRID_WIDTH, y: head.y };
  return { x: (head.x + 1) % GRID_WIDTH, y: head.y };
};

const SnakeGame = () => {
  const [snake, setSnake] = useState<Point[]>([
    { x: 6, y: 7 },
    { x: 5, y: 7 },
    { x: 4, y: 7 },
  ]);
  const [direction, setDirection] = useState<Direction>('right');
  const [food, setFood] = useState<Point>({ x: 10, y: 7 });
  const [status, setStatus] = useState<GameStatus>('idle');
  const [score, setScore] = useState(0);
  const [gamepadConnected, setGamepadConnected] = useState(false);

  const directionRef = useRef<Direction>('right');
  const statusRef = useRef<GameStatus>('idle');
  const heldDirectionRef = useRef<Direction | null>(null);
  const lastMoveTsRef = useRef(0);
  const prevStartRef = useRef(false);

  useEffect(() => {
    directionRef.current = direction;
  }, [direction]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const tickMs = useMemo(() => Math.max(95, 230 - Math.floor(score / 4) * 7), [score]);

  const restart = useCallback(() => {
    const initialSnake = [
      { x: 6, y: 7 },
      { x: 5, y: 7 },
      { x: 4, y: 7 },
    ];
    setSnake(initialSnake);
    setDirection('right');
    setFood(randomFood(initialSnake));
    setScore(0);
    setStatus('playing');
  }, []);

  const setDirectionSafe = useCallback((nextDirection: Direction) => {
    const current = directionRef.current;
    const isOpposite =
      (current === 'up' && nextDirection === 'down') ||
      (current === 'down' && nextDirection === 'up') ||
      (current === 'left' && nextDirection === 'right') ||
      (current === 'right' && nextDirection === 'left');
    if (isOpposite) return;
    setDirection(nextDirection);
  }, []);

  useEffect(() => {
    if (status !== 'playing') return;
    const timer = window.setInterval(() => {
      setSnake((prevSnake) => {
        const nextHead = moveHead(prevSnake[0], directionRef.current);
        const hitsSelf = prevSnake.some((segment) => segment.x === nextHead.x && segment.y === nextHead.y);
        if (hitsSelf) {
          setStatus('gameover');
          return prevSnake;
        }

        const ateFood = nextHead.x === food.x && nextHead.y === food.y;
        const nextSnake = ateFood ? [nextHead, ...prevSnake] : [nextHead, ...prevSnake.slice(0, -1)];
        if (ateFood) {
          setScore((prev) => prev + 1);
          setFood(randomFood(nextSnake));
        }
        return nextSnake;
      });
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [food, status, tickMs]);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'enter' || key === 'r' || key === ' ') {
        event.preventDefault();
        if (statusRef.current !== 'playing') restart();
        return;
      }

      if (key === 'arrowup' || key === 'w') setDirectionSafe('up');
      if (key === 'arrowdown' || key === 's') setDirectionSafe('down');
      if (key === 'arrowleft' || key === 'a') setDirectionSafe('left');
      if (key === 'arrowright' || key === 'd') setDirectionSafe('right');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [restart, setDirectionSafe]);

  useEffect(() => {
    let frame = 0;
    const pollGamepads = () => {
      const now = Date.now();
      const gamepads = navigator.getGamepads?.();
      let nextDirection: Direction | null = null;
      let startPressed = false;

      if (gamepads) {
        for (let i = 0; i < gamepads.length; i += 1) {
          const gp = gamepads[i];
          if (!gp) continue;
          const xAxis = gp.axes[0] ?? 0;
          const yAxis = gp.axes[1] ?? 0;
          if (gp.buttons[12]?.pressed || yAxis < -CONTROLLER_DEADZONE) nextDirection = 'up';
          else if (gp.buttons[13]?.pressed || yAxis > CONTROLLER_DEADZONE) nextDirection = 'down';
          else if (gp.buttons[14]?.pressed || xAxis < -CONTROLLER_DEADZONE) nextDirection = 'left';
          else if (gp.buttons[15]?.pressed || xAxis > CONTROLLER_DEADZONE) nextDirection = 'right';

          startPressed = startPressed || gp.buttons[0]?.pressed || gp.buttons[9]?.pressed;
        }
      }

      if (startPressed && !prevStartRef.current && statusRef.current !== 'playing') {
        restart();
      }
      prevStartRef.current = startPressed;

      if (nextDirection) {
        const canMove =
          heldDirectionRef.current !== nextDirection || now - lastMoveTsRef.current > CONTROLLER_REPEAT_MS;
        if (canMove) {
          setDirectionSafe(nextDirection);
          heldDirectionRef.current = nextDirection;
          lastMoveTsRef.current = now;
        }
      } else {
        heldDirectionRef.current = null;
      }

      frame = requestAnimationFrame(pollGamepads);
    };

    frame = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(frame);
  }, [restart, setDirectionSafe]);

  return (
    <Card className="border bg-gradient-to-br from-emerald-500/5 via-background to-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center justify-between gap-2">
          <span>Snake (Wrap)</span>
          {gamepadConnected && <Badge variant="outline">Controller</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Endless easy mode with border teleportation. Move with keyboard, controller, or touch arrows.
        </p>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Score</div>
            <div className="font-semibold">{score}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Speed</div>
            <div className="font-semibold">{Math.round(1000 / tickMs)} Hz</div>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/20 p-2">
          <div
            className="grid gap-[2px] mx-auto"
            style={{
              gridTemplateColumns: `repeat(${GRID_WIDTH}, minmax(0, 1fr))`,
              maxWidth: '420px',
            }}
          >
            {Array.from({ length: GRID_WIDTH * GRID_HEIGHT }).map((_, index) => {
              const x = index % GRID_WIDTH;
              const y = Math.floor(index / GRID_WIDTH);
              const isHead = snake[0]?.x === x && snake[0]?.y === y;
              const isBody = snake.some((segment, segmentIndex) => segmentIndex > 0 && segment.x === x && segment.y === y);
              const isFood = food.x === x && food.y === y;

              let className = 'bg-background';
              if (isFood) className = 'bg-amber-500/80';
              if (isBody) className = 'bg-emerald-500/60';
              if (isHead) className = 'bg-emerald-500';

              return (
                <div key={`${x}-${y}`} className={`aspect-square rounded-[2px] border border-border/20 ${className}`} />
              );
            })}
          </div>
        </div>

        <div className="flex gap-2">
          {status === 'playing' ? (
            <Button variant="outline" className="w-full" onClick={restart}>
              New Run
            </Button>
          ) : (
            <Button className="w-full" onClick={restart}>
              {status === 'idle' ? 'Start Run' : 'Play Again'}
            </Button>
          )}
        </div>

        <div className="sm:hidden pt-1">
          <div className="mx-auto grid w-[176px] grid-cols-3 gap-2">
            <div />
            <Button variant="secondary" size="icon" onClick={() => setDirectionSafe('up')} aria-label="Move up">
              <ArrowUp className="h-4 w-4" />
            </Button>
            <div />
            <Button variant="secondary" size="icon" onClick={() => setDirectionSafe('left')} aria-label="Move left">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={() => setDirectionSafe('down')} aria-label="Move down">
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={() => setDirectionSafe('right')} aria-label="Move right">
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default SnakeGame;
