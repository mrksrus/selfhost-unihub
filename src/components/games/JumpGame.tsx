import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Gamepad2 } from 'lucide-react';

const GRAVITY = -0.58;
const JUMP_VELOCITY = 11.5;
const GROUND_Y = 0.75; // fraction of canvas height
const DINO_WIDTH = 28;
const DINO_HEIGHT = 32;
const CACTUS_WIDTH = 16;
const CACTUS_HEIGHT = 28;
const OBSTACLE_MIN_GAP = 360;
const OBSTACLE_MAX_GAP = 620;
const START_SPEED = 4.2;
const MAX_SPEED = 9.5;
const SPEED_RAMP_PER_POINT = 0.006;
const SCORE_PER_FRAME = 0.5;
const CONTROLLER_DEADZONE = 0.45;

type GameStatus = 'idle' | 'playing' | 'gameover';

interface GameState {
  status: GameStatus;
  dinoY: number;
  dinoVy: number;
  obstacles: { x: number; width: number; height: number }[];
  score: number;
  gapCounter: number;
  nextGap: number;
  speed: number;
}

export const JumpGame = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameStateRef = useRef<GameState>({
    status: 'idle',
    dinoY: 0,
    dinoVy: 0,
    obstacles: [],
    score: 0,
    gapCounter: 0,
    nextGap: (OBSTACLE_MIN_GAP + OBSTACLE_MAX_GAP) / 2,
    speed: START_SPEED,
  });
  const rafRef = useRef<number>(0);
  const prevJumpRef = useRef<boolean>(false);
  const [score, setScore] = useState(0);
  const [status, setStatus] = useState<GameStatus>('idle');
  const [gamepadConnected, setGamepadConnected] = useState(false);

  const getGroundY = useCallback((canvas: HTMLCanvasElement) => {
    return canvas.height * GROUND_Y;
  }, []);

  const jump = useCallback(() => {
    const state = gameStateRef.current;
    if (state.status !== 'playing') return;
    const isOnGround = state.dinoY <= 0.5 && Math.abs(state.dinoVy) < 0.2;
    if (isOnGround) {
      state.dinoVy = JUMP_VELOCITY;
    }
  }, []);

  const startGame = useCallback(() => {
    const state = gameStateRef.current;
    if (state.status !== 'idle' && state.status !== 'gameover') return;
    state.status = 'playing';
    state.dinoY = 0;
    state.dinoVy = 0;
    state.obstacles = [];
    state.score = 0;
    state.gapCounter = 0;
    state.speed = START_SPEED;
    state.nextGap = OBSTACLE_MIN_GAP + Math.random() * (OBSTACLE_MAX_GAP - OBSTACLE_MIN_GAP);
    setStatus('playing');
    setScore(0);
  }, []);

  const handleGameInput = useCallback(
    (code: string) => {
      const isJumpCode = code === 'Space' || code === 'ArrowUp' || code === 'KeyW' || code === 'Enter';
      if (!isJumpCode) return;
      const state = gameStateRef.current;
      if (state.status === 'idle' || state.status === 'gameover') {
        startGame();
      } else if (state.status === 'playing') {
        jump();
      }
    },
    [jump, startGame]
  );

  const gameLoop = useCallback(
    () => {
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
        if (state.dinoY < 0) {
          state.dinoY = 0;
          state.dinoVy = 0;
        }

        state.score += SCORE_PER_FRAME;
        state.speed = Math.min(MAX_SPEED, START_SPEED + state.score * SPEED_RAMP_PER_POINT);
        setScore(Math.floor(state.score));

        state.obstacles.forEach((obs) => {
          obs.x -= state.speed;
        });
        state.obstacles = state.obstacles.filter((obs) => obs.x + obs.width > 0);

        // Advance gap counter in pixels and spawn obstacles when threshold reached.
        state.gapCounter += state.speed;
        if (state.gapCounter >= state.nextGap) {
          const variant = Math.random();
          let width = CACTUS_WIDTH;
          const height = CACTUS_HEIGHT;
          const canSpawnWideObstacle = state.score > 140;
          if (canSpawnWideObstacle && variant > 0.73) {
            width = CACTUS_WIDTH * 2; // double cactus
          } else if (canSpawnWideObstacle && variant > 0.45) {
            width = CACTUS_WIDTH * 1.5;
          }

          state.obstacles.push({
            x: canvas.width,
            width,
            height,
          });
          state.gapCounter = 0;
          const difficulty = Math.min(1, state.score / 900);
          const adaptiveMinGap = OBSTACLE_MIN_GAP - difficulty * 150;
          const adaptiveMaxGap = OBSTACLE_MAX_GAP - difficulty * 210;
          state.nextGap = adaptiveMinGap + Math.random() * (adaptiveMaxGap - adaptiveMinGap);
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
        ctx.fillText('Press Space, W, ↑ or controller A to start', canvas.width / 2, canvas.height / 2 - 10);
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
    [getGroundY]
  );

  useEffect(() => {
    rafRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [gameLoop]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      handleGameInput(e.code);
    },
    [handleGameInput]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    let frame = 0;

    const pollGamepads = () => {
      const gamepads = navigator.getGamepads?.();
      let anyJumpPressed = false;

      if (gamepads) {
        for (let i = 0; i < gamepads.length; i += 1) {
          const gp = gamepads[i];
          if (!gp) continue;

          const jumpPressed =
            gp.buttons[0]?.pressed ||
            gp.buttons[1]?.pressed ||
            gp.buttons[9]?.pressed ||
            gp.buttons[12]?.pressed ||
            gp.axes[1] < -CONTROLLER_DEADZONE;
          anyJumpPressed = anyJumpPressed || Boolean(jumpPressed);
        }
      }

      if (anyJumpPressed && !prevJumpRef.current) {
        const state = gameStateRef.current;
        if (state.status === 'idle' || state.status === 'gameover') {
          startGame();
        } else {
          jump();
        }
      }

      prevJumpRef.current = anyJumpPressed;
      frame = requestAnimationFrame(pollGamepads);
    };

    frame = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(frame);
  }, [jump, startGame]);

  const handleCanvasClick = useCallback(() => {
    canvasRef.current?.focus();
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
          Jump Game
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
          Like Chrome’s offline dino: run, jump over cacti. Use Space / W / ↑, click/tap, or controller A.
        </p>
        <div className="rounded-lg border bg-muted/30 overflow-hidden">
          <canvas
            ref={canvasRef}
            width={1200}
            height={320}
            className="w-full h-[240px] md:h-[320px] block cursor-pointer"
            onClick={handleCanvasClick}
            onPointerDown={handleCanvasClick}
            tabIndex={0}
            onKeyDown={(e) => handleGameInput(e.code)}
            aria-label="Jump Game canvas - click, tap, or press Space to jump"
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

export default JumpGame;
