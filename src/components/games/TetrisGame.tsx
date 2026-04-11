import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;
const CONTROLLER_DEADZONE = 0.45;
const CONTROLLER_REPEAT_MS = 120;

type Cell = 0 | 1;
type Direction = 'left' | 'right' | 'down';
type GameStatus = 'idle' | 'playing' | 'gameover';

interface Piece {
  shape: number[][];
  x: number;
  y: number;
}

const PIECES: number[][][] = [
  [[1, 1, 1, 1]],
  [
    [1, 0, 0],
    [1, 1, 1],
  ],
  [
    [0, 0, 1],
    [1, 1, 1],
  ],
  [
    [1, 1],
    [1, 1],
  ],
  [
    [0, 1, 1],
    [1, 1, 0],
  ],
  [
    [0, 1, 0],
    [1, 1, 1],
  ],
  [
    [1, 1, 0],
    [0, 1, 1],
  ],
];

const createEmptyBoard = (): Cell[][] =>
  Array.from({ length: BOARD_HEIGHT }, () => Array.from({ length: BOARD_WIDTH }, () => 0 as Cell));

const spawnPiece = (): Piece => {
  const shape = PIECES[Math.floor(Math.random() * PIECES.length)];
  return {
    shape,
    x: Math.floor((BOARD_WIDTH - shape[0].length) / 2),
    y: 0,
  };
};

const rotateShape = (shape: number[][]): number[][] =>
  shape[0].map((_, index) => shape.map((row) => row[index]).reverse());

const TetrisGame = () => {
  const [board, setBoard] = useState<Cell[][]>(() => createEmptyBoard());
  const [piece, setPiece] = useState<Piece>(spawnPiece());
  const [status, setStatus] = useState<GameStatus>('idle');
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [gamepadConnected, setGamepadConnected] = useState(false);

  const statusRef = useRef<GameStatus>('idle');
  const prevRotateRef = useRef(false);
  const prevDropRef = useRef(false);
  const heldDirectionRef = useRef<Direction | null>(null);
  const lastMoveTsRef = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const level = useMemo(() => Math.floor(lines / 10), [lines]);
  const tickMs = useMemo(() => Math.max(130, 760 - level * 18), [level]);

  const collides = useCallback((nextPiece: Piece, nextBoard: Cell[][]) => {
    for (let y = 0; y < nextPiece.shape.length; y += 1) {
      for (let x = 0; x < nextPiece.shape[y].length; x += 1) {
        if (!nextPiece.shape[y][x]) continue;
        const boardX = nextPiece.x + x;
        const boardY = nextPiece.y + y;
        if (boardX < 0 || boardX >= BOARD_WIDTH || boardY >= BOARD_HEIGHT) return true;
        if (boardY >= 0 && nextBoard[boardY][boardX]) return true;
      }
    }
    return false;
  }, []);

  const restart = useCallback(() => {
    setBoard(createEmptyBoard());
    setPiece(spawnPiece());
    setScore(0);
    setLines(0);
    setStatus('playing');
  }, []);

  const lockPiece = useCallback((pieceToLock: Piece = piece) => {
    setBoard((prevBoard) => {
      const nextBoard = prevBoard.map((row) => [...row]) as Cell[][];
      for (let y = 0; y < pieceToLock.shape.length; y += 1) {
        for (let x = 0; x < pieceToLock.shape[y].length; x += 1) {
          if (!pieceToLock.shape[y][x]) continue;
          const boardX = pieceToLock.x + x;
          const boardY = pieceToLock.y + y;
          if (boardY < 0) continue;
          nextBoard[boardY][boardX] = 1;
        }
      }

      const rowsCleared = nextBoard.filter((row) => row.every((cell) => cell === 1)).length;
      if (rowsCleared > 0) {
        const filtered = nextBoard.filter((row) => !row.every((cell) => cell === 1));
        while (filtered.length < BOARD_HEIGHT) {
          filtered.unshift(Array.from({ length: BOARD_WIDTH }, () => 0 as Cell));
        }
        setLines((prev) => prev + rowsCleared);
        setScore((prev) => prev + rowsCleared * 100 + rowsCleared * rowsCleared * 30);
        return filtered;
      }

      return nextBoard;
    });

    const nextPiece = spawnPiece();
    if (collides(nextPiece, board)) {
      setStatus('gameover');
      return;
    }
    setPiece(nextPiece);
  }, [board, collides, piece]);

  const movePiece = useCallback(
    (direction: Direction) => {
      if (statusRef.current !== 'playing') return;
      const deltaX = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
      const deltaY = direction === 'down' ? 1 : 0;
      const candidate = { ...piece, x: piece.x + deltaX, y: piece.y + deltaY };

      if (collides(candidate, board)) {
        if (direction === 'down') lockPiece();
        return;
      }
      setPiece(candidate);
    },
    [board, collides, lockPiece, piece]
  );

  const rotatePiece = useCallback(() => {
    if (statusRef.current !== 'playing') return;
    const rotated = rotateShape(piece.shape);
    const candidate = { ...piece, shape: rotated };
    if (!collides(candidate, board)) {
      setPiece(candidate);
      return;
    }

    const kickLeft = { ...candidate, x: candidate.x - 1 };
    if (!collides(kickLeft, board)) {
      setPiece(kickLeft);
      return;
    }

    const kickRight = { ...candidate, x: candidate.x + 1 };
    if (!collides(kickRight, board)) {
      setPiece(kickRight);
    }
  }, [board, collides, piece]);

  const hardDrop = useCallback(() => {
    if (statusRef.current !== 'playing') return;
    let dropped = { ...piece };
    while (!collides({ ...dropped, y: dropped.y + 1 }, board)) {
      dropped = { ...dropped, y: dropped.y + 1 };
    }
    lockPiece(dropped);
  }, [board, collides, lockPiece, piece]);

  useEffect(() => {
    if (status !== 'playing') return;
    const timer = window.setInterval(() => movePiece('down'), tickMs);
    return () => window.clearInterval(timer);
  }, [movePiece, status, tickMs]);

  useEffect(() => {
    const onConnectChange = () => {
      setGamepadConnected(navigator.getGamepads?.().some((g) => g !== null) ?? false);
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
      if (key === 'enter' || key === 'r') {
        event.preventDefault();
        restart();
        return;
      }
      if (statusRef.current !== 'playing') return;

      if (key === 'arrowleft' || key === 'a') movePiece('left');
      if (key === 'arrowright' || key === 'd') movePiece('right');
      if (key === 'arrowdown' || key === 's') movePiece('down');
      if (key === 'arrowup' || key === 'w' || key === ' ') rotatePiece();
      if (key === 'shift' || key === 'x') hardDrop();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hardDrop, movePiece, restart, rotatePiece]);

  useEffect(() => {
    let frame = 0;
    const pollGamepads = () => {
      const now = Date.now();
      const gamepads = navigator.getGamepads?.();
      let direction: Direction | null = null;
      let rotatePressed = false;
      let dropPressed = false;
      let startPressed = false;

      if (gamepads) {
        for (let i = 0; i < gamepads.length; i += 1) {
          const gp = gamepads[i];
          if (!gp) continue;

          const xAxis = gp.axes[0] ?? 0;
          const yAxis = gp.axes[1] ?? 0;
          if (gp.buttons[14]?.pressed || xAxis < -CONTROLLER_DEADZONE) direction = 'left';
          else if (gp.buttons[15]?.pressed || xAxis > CONTROLLER_DEADZONE) direction = 'right';
          else if (gp.buttons[13]?.pressed || yAxis > CONTROLLER_DEADZONE) direction = 'down';

          rotatePressed = rotatePressed || gp.buttons[0]?.pressed || gp.buttons[12]?.pressed;
          dropPressed = dropPressed || gp.buttons[1]?.pressed || gp.buttons[7]?.pressed;
          startPressed = startPressed || gp.buttons[9]?.pressed;
        }
      }

      if (startPressed && statusRef.current !== 'playing') {
        restart();
      }

      if (rotatePressed && !prevRotateRef.current) rotatePiece();
      if (dropPressed && !prevDropRef.current) hardDrop();
      prevRotateRef.current = rotatePressed;
      prevDropRef.current = dropPressed;

      if (direction) {
        const canMove =
          heldDirectionRef.current !== direction || now - lastMoveTsRef.current > CONTROLLER_REPEAT_MS;
        if (canMove) {
          movePiece(direction);
          heldDirectionRef.current = direction;
          lastMoveTsRef.current = now;
        }
      } else {
        heldDirectionRef.current = null;
      }

      frame = requestAnimationFrame(pollGamepads);
    };

    frame = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(frame);
  }, [hardDrop, movePiece, restart, rotatePiece]);

  const composedBoard = useMemo(() => {
    const next = board.map((row) => [...row]);
    for (let y = 0; y < piece.shape.length; y += 1) {
      for (let x = 0; x < piece.shape[y].length; x += 1) {
        if (!piece.shape[y][x]) continue;
        const boardX = piece.x + x;
        const boardY = piece.y + y;
        if (boardX < 0 || boardX >= BOARD_WIDTH || boardY < 0 || boardY >= BOARD_HEIGHT) continue;
        next[boardY][boardX] = 1;
      }
    }
    return next;
  }, [board, piece]);

  return (
    <Card className="border bg-gradient-to-br from-indigo-500/5 via-background to-cyan-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center justify-between gap-2">
          <span>Block Stack (Infinite)</span>
          {gamepadConnected && <Badge variant="outline">Controller</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Infinite block-stacking mode with very gradual speed increase. Controls: arrows/WASD, controller, or touch.
        </p>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Score</div>
            <div className="font-semibold">{score}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Lines</div>
            <div className="font-semibold">{lines}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Level</div>
            <div className="font-semibold">{level + 1}</div>
          </div>
        </div>

        <div className="rounded-lg border-2 border-border/80 bg-muted/30 p-2 shadow-inner">
          <div
            className="grid gap-[2px] mx-auto rounded-md border border-border/70 bg-slate-300/35 p-1"
            style={{
              gridTemplateColumns: `repeat(${BOARD_WIDTH}, minmax(0, 1fr))`,
              maxWidth: '280px',
            }}
          >
            {composedBoard.flatMap((row, rowIndex) =>
              row.map((cell, cellIndex) => (
                <div
                  key={`${rowIndex}-${cellIndex}`}
                  className={`aspect-square rounded-[2px] border ${
                    cell
                      ? 'border-cyan-700/60 bg-cyan-500/75 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]'
                      : 'border-slate-300/50 bg-slate-100/85'
                  }`}
                />
              ))
            )}
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
            <Button variant="secondary" size="icon" onClick={() => movePiece('left')} aria-label="Move left">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={rotatePiece} aria-label="Rotate piece">
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={() => movePiece('right')} aria-label="Move right">
              <ArrowRight className="h-4 w-4" />
            </Button>
            <div />
            <Button variant="secondary" size="icon" onClick={() => movePiece('down')} aria-label="Move down">
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={hardDrop} aria-label="Hard drop">
              <span className="text-xs font-semibold">DROP</span>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default TetrisGame;
