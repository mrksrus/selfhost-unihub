import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Gamepad2 } from 'lucide-react';

const GRAVITY = 0.6;
const JUMP_VELOCITY = -12;
const GROUND_Y = 0.75; // fraction of canvas height
const DINO_WIDTH = 28;
const DINO_HEIGHT = 32;
const CACTUS_WIDTH = 16;
const CACTUS_HEIGHT = 28;
const OBSTACLE_MIN_GAP = 280;
const OBSTACLE_MAX_GAP = 420;
const GAME_SPEED = 8;
const SCORE_PER_FRAME = 0.5;

type GameStatus = 'idle' | 'playing' | 'gameover';

interface GameState {
  status: GameStatus;
  dinoY: number;
  dinoVy: number;
  obstacles: { x: number; width: number; height: number }[];
  score: number;
  lastSpawn: number;
  speed: number;
}

export const TestGame = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameStateRef = useRef<GameState>({
    status: 'idle',
    dinoY: 0,
    dinoVy: 0,
    obstacles: [],
    score: 0,
    lastSpawn: 0,
    speed: GAME_SPEED,
  });
  const rafRef = useRef<number>(0);
  const prevJumpRef = useRef<boolean>(false);
  const prevStartRef = useRef<boolean>(false);
  const [score, setScore] = useState(0);
  const [status, setStatus] = useState<GameStatus>('idle');
  const [gamepadConnected, setGamepadConnected] = useState(false);

  const getGroundY = useCallback((canvas: HTMLCanvasElement) => {
    return canvas.height * GROUND_Y;
  }, []);

  const jump = useCallback(() => {
    const state = gameStateRef.current;
    if (state.status !== 'playing') return;
    const groundY = canvasRef.current ? getGroundY(canvasRef.current) : 0;
    const dinoBottom = groundY - state.dinoY - DINO_HEIGHT;
    if (dinoBottom <= 0) {
      state.dinoVy = JUMP_VELOCITY;
    }
  }, [getGroundY]);

  const startGame = useCallback(() => {
    const state = gameStateRef.current;
    if (state.status !== 'idle' && state.status !== 'gameover') return;
    state.status = 'playing';
    state.dinoY = 0;
    state.dinoVy = JUMP_VELOCITY;
    state.obstacles = [];
    state.score = 0;
    state.lastSpawn = 0;
    setStatus('playing');
    setScore(0);
  }, []);

  const gameLoop = useCallback(
    (timestamp: number) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafRef.current = requestAnimationFrame(gameLoop);
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rafRef.current = requestAnimationFrame(gameLoop);
        return;
      }

      const state = gameStateRef.current;
      const groundY = getGroundY(canvas);

      if (state.status === 'playing') {
        state.dinoVy += GRAVITY;
        state.dinoY += state.dinoVy;
        if (state.dinoY > 0) {
          state.dinoY = 0;
          state.dinoVy = 0;
        }

        state.score += SCORE_PER_FRAME;
        setScore(Math.floor(state.score));

        state.obstacles.forEach((obs) => {
          obs.x -= state.speed;
        });
        state.obstacles = state.obstacles.filter((obs) => obs.x + obs.width > 0);

        if (timestamp - state.lastSpawn > (OBSTACLE_MIN_GAP + Math.random() * (OBSTACLE_MAX_GAP - OBSTACLE_MIN_GAP))) {
          state.obstacles.push({
            x: canvas.width,
            width: CACTUS_WIDTH,
            height: CACTUS_HEIGHT,
          });
          state.lastSpawn = timestamp;
        }

        const dinoLeft = 60;
        const dinoRight = dinoLeft + DINO_WIDTH;
        const dinoTop = groundY - DINO_HEIGHT - state.dinoY;
        const dinoBottom = groundY - state.dinoY;

        for (const obs of state.obstacles) {
          const obsLeft = obs.x;
          const obsRight = obs.x + obs.width;
          const obsTop = groundY - obs.height;
          const obsBottom = groundY;
          if (dinoRight > obsLeft && dinoLeft < obsRight && dinoBottom > obsTop && dinoTop < obsBottom) {
            state.status = 'gameover';
            setStatus('gameover');
            break;
          }
        }

        const gamepads = navigator.getGamepads?.();
        if (gamepads) {
          let anyJump = false;
          for (let i = 0; i < gamepads.length; i++) {
            const gp = gamepads[i];
            if (!gp) continue;
            const jumpPressed = gp.buttons[0]?.pressed || gp.buttons[12]?.pressed;
            anyJump = anyJump || jumpPressed;
            if (jumpPressed && !prevJumpRef.current) jump();
          }
          prevJumpRef.current = anyJump;
        }
      }

      if (state.status === 'idle' || state.status === 'gameover') {
        const gamepads = navigator.getGamepads?.();
        if (gamepads) {
          let anyStart = false;
          for (let i = 0; i < gamepads.length; i++) {
            const gp = gamepads[i];
            if (!gp) continue;
            anyStart = anyStart || gp.buttons[0]?.pressed || gp.buttons[12]?.pressed;
          }
          if (anyStart && !prevStartRef.current) startGame();
          prevStartRef.current = anyStart;
        }
      }

      // Background
      ctx.fillStyle = '#f9fafb';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Ground line
      ctx.strokeStyle = '#d4d4d8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(canvas.width, groundY);
      ctx.stroke();

      const dinoX = 60;
      const dinoDrawY = groundY - DINO_HEIGHT - state.dinoY;
      // Dino body
      ctx.fillStyle = '#111827';
      ctx.fillRect(dinoX, dinoDrawY, DINO_WIDTH, DINO_HEIGHT);
      ctx.fillRect(dinoX + DINO_WIDTH - 6, dinoDrawY + DINO_HEIGHT - 8, 8, 10);

      state.obstacles.forEach((obs) => {
        const obsY = groundY - obs.height;
        // Cactus
        ctx.fillStyle = '#6b7280';
        ctx.fillRect(obs.x, obsY, obs.width, obs.height);
        ctx.fillRect(obs.x + 4, obsY + obs.height - 10, 6, 10);
        ctx.fillRect(obs.x + obs.width - 8, obsY + obs.height - 10, 6, 10);
      });

      if (state.status === 'idle') {
        ctx.fillStyle = '#4b5563';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Press Space, ↑ or controller A to start', canvas.width / 2, canvas.height / 2 - 10);
        ctx.fillText('Jump over the cacti!', canvas.width / 2, canvas.height / 2 + 10);
      }

      if (state.status === 'gameover') {
        ctx.fillStyle = '#111827';
        ctx.font = 'bold 18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Game Over', canvas.width / 2, canvas.height / 2 - 20);
        ctx.font = '14px system-ui, sans-serif';
        ctx.fillStyle = '#4b5563';
        ctx.fillText(`Score: ${Math.floor(state.score)}`, canvas.width / 2, canvas.height / 2 + 5);
      }

      if (state.status === 'playing') {
        ctx.fillStyle = '#4b5563';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Score: ${Math.floor(state.score)}`, 10, 22);
      }

      rafRef.current = requestAnimationFrame(gameLoop);
    },
    [getGroundY, jump, startGame]
  );

  useEffect(() => {
    rafRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [gameLoop]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.code !== 'ArrowUp') return;
      e.preventDefault();
      if (gameStateRef.current.status === 'idle' || gameStateRef.current.status === 'gameover') {
        startGame();
      } else if (gameStateRef.current.status === 'playing') {
        jump();
      }
    },
    [jump, startGame]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleCanvasClick = useCallback(() => {
    const state = gameStateRef.current;
    if (state.status === 'idle' || state.status === 'gameover') {
      startGame();
    } else if (state.status === 'playing') {
      jump();
    }
  }, [jump, startGame]);

  const handleRestart = useCallback(() => {
    startGame();
  }, [startGame]);

  useEffect(() => {
    const onConnect = () => setGamepadConnected(navigator.getGamepads?.().some((g) => g !== null) ?? false);
    const onDisconnect = () => setGamepadConnected(navigator.getGamepads?.().some((g) => g !== null) ?? false);
    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    onConnect();
    return () => {
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
    };
  }, []);

  useEffect(() => {
    if (status !== 'idle') return;
    const state = gameStateRef.current;
    state.dinoY = 0;
    state.dinoVy = 0;
  }, [status]);

  return (
    <Card className="border overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          Test Game
          {gamepadConnected && (
            <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
              <Gamepad2 className="h-3.5 w-3.5" />
              Controller
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Like Chrome’s offline dino: run, jump over cacti. Use Space / ↑ or controller A (or D-pad up).
        </p>
        <div className="rounded-lg border bg-muted/30 overflow-hidden">
          <canvas
            ref={canvasRef}
            width={1200}
            height={320}
            className="w-full h-[240px] md:h-[320px] block cursor-pointer"
            onClick={handleCanvasClick}
            tabIndex={0}
            aria-label="Test Game canvas - click or press Space to jump"
          />
        </div>
        {status === 'gameover' && (
          <Button onClick={handleRestart} className="w-full">
            Play Again
          </Button>
        )}
      </CardContent>
    </Card>
  );
};

export default TestGame;
