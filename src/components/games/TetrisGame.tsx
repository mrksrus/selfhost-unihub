import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowDown, ArrowLeft, ArrowRight, Cloud, Loader2, RotateCw, Smartphone, Trophy } from 'lucide-react';
import {
  readLocalTetrisScores,
  saveLocalTetrisScore,
  type LocalTetrisScore,
} from './tetris-leaderboard';

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

interface GameState {
  board: Cell[][];
  piece: Piece;
  status: GameStatus;
  score: number;
  lines: number;
  runId: number;
}

interface ServerTetrisScore {
  score: number;
  lines: number;
  level: number;
  achieved_at: string;
  player_name: string;
  is_you: boolean;
}

interface ServerLeaderboardResponse {
  leaderboard: ServerTetrisScore[];
  personal_best: Omit<ServerTetrisScore, 'player_name' | 'is_you'> | null;
}

const PIECES: number[][][] = [
  [[1, 1, 1, 1]],
  [[1, 0, 0], [1, 1, 1]],
  [[0, 0, 1], [1, 1, 1]],
  [[1, 1], [1, 1]],
  [[0, 1, 1], [1, 1, 0]],
  [[0, 1, 0], [1, 1, 1]],
  [[1, 1, 0], [0, 1, 1]],
];

const createEmptyBoard = (): Cell[][] =>
  Array.from({ length: BOARD_HEIGHT }, () => Array.from({ length: BOARD_WIDTH }, () => 0 as Cell));

const spawnPiece = (): Piece => {
  const shape = PIECES[Math.floor(Math.random() * PIECES.length)];
  return { shape, x: Math.floor((BOARD_WIDTH - shape[0].length) / 2), y: 0 };
};

const createGameState = (runId = 0, status: GameStatus = 'idle'): GameState => ({
  board: createEmptyBoard(),
  piece: spawnPiece(),
  status,
  score: 0,
  lines: 0,
  runId,
});

const rotateShape = (shape: number[][]): number[][] =>
  shape[0].map((_, index) => shape.map((row) => row[index]).reverse());

const collides = (piece: Piece, board: Cell[][]) => {
  for (let y = 0; y < piece.shape.length; y += 1) {
    for (let x = 0; x < piece.shape[y].length; x += 1) {
      if (!piece.shape[y][x]) continue;
      const boardX = piece.x + x;
      const boardY = piece.y + y;
      if (boardX < 0 || boardX >= BOARD_WIDTH || boardY >= BOARD_HEIGHT) return true;
      if (boardY >= 0 && board[boardY][boardX]) return true;
    }
  }
  return false;
};

const lockPiece = (state: GameState, piece: Piece): GameState => {
  const merged = state.board.map((row) => [...row]) as Cell[][];
  for (let y = 0; y < piece.shape.length; y += 1) {
    for (let x = 0; x < piece.shape[y].length; x += 1) {
      if (!piece.shape[y][x]) continue;
      const boardX = piece.x + x;
      const boardY = piece.y + y;
      if (boardY >= 0 && boardY < BOARD_HEIGHT && boardX >= 0 && boardX < BOARD_WIDTH) {
        merged[boardY][boardX] = 1;
      }
    }
  }

  const rowsCleared = merged.filter((row) => row.every(Boolean)).length;
  const cleared = merged.filter((row) => !row.every(Boolean));
  while (cleared.length < BOARD_HEIGHT) {
    cleared.unshift(Array.from({ length: BOARD_WIDTH }, () => 0 as Cell));
  }

  const nextPiece = spawnPiece();
  return {
    ...state,
    board: cleared,
    piece: nextPiece,
    status: collides(nextPiece, cleared) ? 'gameover' : 'playing',
    lines: state.lines + rowsCleared,
    score: state.score + rowsCleared * 100 + rowsCleared * rowsCleared * 30,
  };
};

const scoreDate = (value: number | string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recently' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const TetrisGame = () => {
  const { user } = useAuth();
  const [game, setGame] = useState<GameState>(() => createGameState());
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const [localScores, setLocalScores] = useState<LocalTetrisScore[]>([]);
  const [serverScores, setServerScores] = useState<ServerTetrisScore[]>([]);
  const [serverError, setServerError] = useState('');
  const [serverLoading, setServerLoading] = useState(true);
  const submittedRunRef = useRef<number | null>(null);
  const prevRotateRef = useRef(false);
  const prevDropRef = useRef(false);
  const prevStartRef = useRef(false);
  const heldDirectionRef = useRef<Direction | null>(null);
  const lastMoveTsRef = useRef(0);

  const level = Math.floor(game.lines / 10) + 1;
  const tickMs = Math.max(130, 760 - (level - 1) * 18);

  const loadServerScores = useCallback(async () => {
    setServerLoading(true);
    const response = await api.get<ServerLeaderboardResponse>('/games/tetris/leaderboard');
    if (response.data) {
      setServerScores(response.data.leaderboard);
      setServerError('');
    } else {
      setServerError(response.error || 'Server leaderboard is unavailable.');
    }
    setServerLoading(false);
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    setLocalScores(readLocalTetrisScores(user.id));
    void loadServerScores();
  }, [loadServerScores, user?.id]);

  const restart = useCallback(() => {
    setGame((previous) => createGameState(previous.runId + 1, 'playing'));
  }, []);

  const movePiece = useCallback((direction: Direction) => {
    setGame((previous) => {
      if (previous.status !== 'playing') return previous;
      const candidate = {
        ...previous.piece,
        x: previous.piece.x + (direction === 'left' ? -1 : direction === 'right' ? 1 : 0),
        y: previous.piece.y + (direction === 'down' ? 1 : 0),
      };
      if (!collides(candidate, previous.board)) return { ...previous, piece: candidate };
      return direction === 'down' ? lockPiece(previous, previous.piece) : previous;
    });
  }, []);

  const rotatePiece = useCallback(() => {
    setGame((previous) => {
      if (previous.status !== 'playing') return previous;
      const rotated = { ...previous.piece, shape: rotateShape(previous.piece.shape) };
      const candidates = [rotated, { ...rotated, x: rotated.x - 1 }, { ...rotated, x: rotated.x + 1 }];
      return { ...previous, piece: candidates.find((candidate) => !collides(candidate, previous.board)) || previous.piece };
    });
  }, []);

  const hardDrop = useCallback(() => {
    setGame((previous) => {
      if (previous.status !== 'playing') return previous;
      let dropped = { ...previous.piece };
      while (!collides({ ...dropped, y: dropped.y + 1 }, previous.board)) {
        dropped = { ...dropped, y: dropped.y + 1 };
      }
      return lockPiece(previous, dropped);
    });
  }, []);

  useEffect(() => {
    if (game.status !== 'playing') return;
    const timer = window.setInterval(() => movePiece('down'), tickMs);
    return () => window.clearInterval(timer);
  }, [game.status, movePiece, tickMs]);

  useEffect(() => {
    if (game.status !== 'gameover' || submittedRunRef.current === game.runId || !user?.id) return;
    submittedRunRef.current = game.runId;
    const entry: LocalTetrisScore = {
      id: `${Date.now()}-${game.runId}`,
      score: game.score,
      lines: game.lines,
      level,
      playedAt: Date.now(),
    };
    setLocalScores(saveLocalTetrisScore(user.id, entry));

    setServerLoading(true);
    void api.post<ServerLeaderboardResponse>('/games/tetris/score', { score: game.score, lines: game.lines })
      .then((response) => {
        if (response.data) {
          setServerScores(response.data.leaderboard);
          setServerError('');
        } else {
          setServerError(response.error || 'Your score stayed local because the server was unavailable.');
        }
      })
      .finally(() => setServerLoading(false));
  }, [game.lines, game.runId, game.score, game.status, level, user?.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'enter' || key === 'r') {
        event.preventDefault();
        restart();
      } else if (key === 'arrowleft' || key === 'a') {
        event.preventDefault();
        movePiece('left');
      } else if (key === 'arrowright' || key === 'd') {
        event.preventDefault();
        movePiece('right');
      } else if (key === 'arrowdown' || key === 's') {
        event.preventDefault();
        movePiece('down');
      } else if (key === 'arrowup' || key === 'w' || key === ' ') {
        event.preventDefault();
        rotatePiece();
      } else if (key === 'shift' || key === 'x') {
        event.preventDefault();
        hardDrop();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hardDrop, movePiece, restart, rotatePiece]);

  useEffect(() => {
    const updateConnection = () => setGamepadConnected(navigator.getGamepads?.().some(Boolean) ?? false);
    window.addEventListener('gamepadconnected', updateConnection);
    window.addEventListener('gamepaddisconnected', updateConnection);
    updateConnection();
    return () => {
      window.removeEventListener('gamepadconnected', updateConnection);
      window.removeEventListener('gamepaddisconnected', updateConnection);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const pollGamepads = () => {
      const now = Date.now();
      let direction: Direction | null = null;
      let rotatePressed = false;
      let dropPressed = false;
      let startPressed = false;
      for (const gamepad of navigator.getGamepads?.() || []) {
        if (!gamepad) continue;
        const xAxis = gamepad.axes[0] ?? 0;
        const yAxis = gamepad.axes[1] ?? 0;
        if (gamepad.buttons[14]?.pressed || xAxis < -CONTROLLER_DEADZONE) direction = 'left';
        else if (gamepad.buttons[15]?.pressed || xAxis > CONTROLLER_DEADZONE) direction = 'right';
        else if (gamepad.buttons[13]?.pressed || yAxis > CONTROLLER_DEADZONE) direction = 'down';
        rotatePressed ||= Boolean(gamepad.buttons[0]?.pressed || gamepad.buttons[12]?.pressed);
        dropPressed ||= Boolean(gamepad.buttons[1]?.pressed || gamepad.buttons[7]?.pressed);
        startPressed ||= Boolean(gamepad.buttons[9]?.pressed);
      }

      if (startPressed && !prevStartRef.current) restart();
      if (rotatePressed && !prevRotateRef.current) rotatePiece();
      if (dropPressed && !prevDropRef.current) hardDrop();
      prevStartRef.current = startPressed;
      prevRotateRef.current = rotatePressed;
      prevDropRef.current = dropPressed;

      if (direction && (heldDirectionRef.current !== direction || now - lastMoveTsRef.current > CONTROLLER_REPEAT_MS)) {
        movePiece(direction);
        heldDirectionRef.current = direction;
        lastMoveTsRef.current = now;
      } else if (!direction) {
        heldDirectionRef.current = null;
      }
      frame = requestAnimationFrame(pollGamepads);
    };
    frame = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(frame);
  }, [hardDrop, movePiece, restart, rotatePiece]);

  const composedBoard = useMemo(() => {
    const next = game.board.map((row) => [...row]);
    for (let y = 0; y < game.piece.shape.length; y += 1) {
      for (let x = 0; x < game.piece.shape[y].length; x += 1) {
        if (!game.piece.shape[y][x]) continue;
        const boardX = game.piece.x + x;
        const boardY = game.piece.y + y;
        if (boardX >= 0 && boardX < BOARD_WIDTH && boardY >= 0 && boardY < BOARD_HEIGHT) next[boardY][boardX] = 1;
      }
    }
    return next;
  }, [game.board, game.piece]);

  return (
    <Card className="overflow-hidden border-cyan-500/20 bg-gradient-to-br from-indigo-500/5 via-background to-cyan-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-lg">
          <span>Block Stack</span>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Infinite</Badge>
            {gamepadConnected && <Badge variant="outline">Controller</Badge>}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Clear lines at your own pace. Every run stays on this device and your personal best also joins the shared server board.</p>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(260px,340px)_minmax(280px,1fr)]">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-xs">
              {([['Score', game.score], ['Lines', game.lines], ['Level', level]] as const).map(([label, value]) => (
                <div key={label} className="rounded-lg border bg-background/80 px-2 py-2 text-center">
                  <div className="text-muted-foreground">{label}</div>
                  <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>

            <div className="mx-auto w-full max-w-[300px] rounded-xl border-2 border-border/80 bg-muted/40 p-2 shadow-inner">
              <div className="grid gap-[2px] rounded-md border border-border/70 bg-slate-300/30 p-1" style={{ gridTemplateColumns: `repeat(${BOARD_WIDTH}, minmax(0, 1fr))` }}>
                {composedBoard.flatMap((row, rowIndex) => row.map((cell, cellIndex) => (
                  <div key={`${rowIndex}-${cellIndex}`} className={`aspect-square rounded-[2px] border ${cell ? 'border-cyan-700/60 bg-cyan-500/80 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]' : 'border-slate-300/30 bg-background/75'}`} />
                )))}
              </div>
            </div>

            {game.status === 'gameover' && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-center text-sm">
                Run over — your score was saved locally and sent to the server board.
              </div>
            )}

            <Button className="h-11 w-full" variant={game.status === 'playing' ? 'outline' : 'default'} onClick={restart}>
              {game.status === 'idle' ? 'Start run' : game.status === 'playing' ? 'Restart run' : 'Play again'}
            </Button>

            <div className="mx-auto grid w-[196px] grid-cols-3 gap-2 sm:hidden">
              <Button className="h-12 touch-manipulation" variant="secondary" onClick={() => movePiece('left')} aria-label="Move left"><ArrowLeft className="h-5 w-5" /></Button>
              <Button className="h-12 touch-manipulation" variant="secondary" onClick={rotatePiece} aria-label="Rotate piece"><RotateCw className="h-5 w-5" /></Button>
              <Button className="h-12 touch-manipulation" variant="secondary" onClick={() => movePiece('right')} aria-label="Move right"><ArrowRight className="h-5 w-5" /></Button>
              <div />
              <Button className="h-12 touch-manipulation" variant="secondary" onClick={() => movePiece('down')} aria-label="Move down"><ArrowDown className="h-5 w-5" /></Button>
              <Button className="h-12 touch-manipulation text-[10px] font-bold" variant="secondary" onClick={hardDrop}>DROP</Button>
            </div>
            <p className="hidden text-center text-xs text-muted-foreground sm:block">Arrows / WASD to move · W, ↑ or Space to rotate · Shift or X to drop</p>
          </div>

          <Tabs defaultValue="local" className="min-w-0">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="local" className="gap-1.5"><Smartphone className="h-3.5 w-3.5" />Local</TabsTrigger>
              <TabsTrigger value="server" className="gap-1.5"><Cloud className="h-3.5 w-3.5" />Server</TabsTrigger>
            </TabsList>
            <TabsContent value="local" className="mt-3">
              <LeaderboardShell title="Your top runs" subtitle="Only on this device">
                {localScores.length === 0 ? <EmptyScores /> : localScores.map((entry, index) => (
                  <ScoreRow key={entry.id} rank={index + 1} name={index === 0 ? 'Personal best' : `Run ${localScores.length - index}`} score={entry.score} lines={entry.lines} date={scoreDate(entry.playedAt)} highlight={index === 0} />
                ))}
              </LeaderboardShell>
            </TabsContent>
            <TabsContent value="server" className="mt-3">
              <LeaderboardShell title="Server leaderboard" subtitle="Best run from each player">
                {serverLoading ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading scores…</div>
                ) : serverError ? (
                  <div className="space-y-3 py-5 text-center"><p className="text-sm text-muted-foreground">{serverError}</p><Button size="sm" variant="outline" onClick={() => void loadServerScores()}>Try again</Button></div>
                ) : serverScores.length === 0 ? <EmptyScores /> : serverScores.map((entry, index) => (
                  <ScoreRow key={`${entry.player_name}-${index}`} rank={index + 1} name={entry.is_you ? `${entry.player_name} (you)` : entry.player_name} score={entry.score} lines={entry.lines} date={scoreDate(entry.achieved_at)} highlight={entry.is_you} />
                ))}
              </LeaderboardShell>
            </TabsContent>
          </Tabs>
        </div>
      </CardContent>
    </Card>
  );
};

const LeaderboardShell = ({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) => (
  <div className="overflow-hidden rounded-xl border bg-background/80">
    <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2.5">
      <div><p className="text-sm font-semibold">{title}</p><p className="text-[11px] text-muted-foreground">{subtitle}</p></div>
      <Trophy className="h-4 w-4 text-amber-500" />
    </div>
    <div className="divide-y">{children}</div>
  </div>
);

const EmptyScores = () => <p className="px-3 py-8 text-center text-sm text-muted-foreground">Finish a run to claim the first spot.</p>;

const ScoreRow = ({ rank, name, score, lines, date, highlight }: { rank: number; name: string; score: number; lines: number; date: string; highlight?: boolean }) => (
  <div className={`grid grid-cols-[2rem_1fr_auto] items-center gap-2 px-3 py-2.5 text-sm ${highlight ? 'bg-accent/8' : ''}`}>
    <span className="font-semibold tabular-nums text-muted-foreground">#{rank}</span>
    <div className="min-w-0"><p className="truncate font-medium">{name}</p><p className="text-[11px] text-muted-foreground">{lines} lines · {date}</p></div>
    <span className="font-semibold tabular-nums">{score}</span>
  </div>
);

export default TetrisGame;
