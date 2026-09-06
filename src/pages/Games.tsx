import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Bot,
  Blocks,
  BrainCircuit,
  ChevronRight,
  Egg,
  Gamepad2,
  RadioTower,
  Sparkles,
  Timer,
  Wind,
  X,
  Zap,
} from 'lucide-react';
const ReactionTimerGame = lazy(() => import('@/components/games/ReactionTimerGame'));
const FocusBreathingGame = lazy(() => import('@/components/games/FocusBreathingGame'));
const JumpGame = lazy(() => import('@/components/games/JumpGame'));
const AIGame = lazy(() => import('@/components/games/AIGame'));
const TetrisGame = lazy(() => import('@/components/games/TetrisGame'));
const SnakeGame = lazy(() => import('@/components/games/SnakeGame'));
const TamagotchiGame = lazy(() => import('@/components/games/TamagotchiGame'));
const EchoSequenceGame = lazy(() => import('@/components/games/EchoSequenceGame'));
const SignalMazeGame = lazy(() => import('@/components/games/SignalMazeGame'));
import { getAIGameCardSummary, type AIGameCardSummary } from '@/components/games/ai-game/persistence';

type GameId =
  | 'tetris-game'
  | 'echo-sequence'
  | 'signal-maze'
  | 'reaction-timer'
  | 'focus-breathing'
  | 'jump-game'
  | 'ai-game'
  | 'snake-game'
  | 'tamagotchi';

interface GameDefinition {
  id: GameId;
  name: string;
  shortName: string;
  description: string;
  difficulty: 'Relaxed' | 'Normal' | 'Challenging';
  tags: string[];
  icon: ComponentType<{ className?: string }>;
  glow: string;
  featured?: boolean;
  new?: boolean;
}

const GAMES: GameDefinition[] = [
  {
    id: 'tetris-game',
    name: 'Block Stack',
    shortName: 'Blocks',
    description: 'Settle into an endless block-stacking run, then compare your best scores locally and across the server.',
    difficulty: 'Normal',
    tags: ['Leaderboards', 'Touch + keys', 'Infinite'],
    icon: Blocks,
    glow: 'from-cyan-500/20 to-indigo-500/5',
    featured: true,
  },
  {
    id: 'echo-sequence',
    name: 'Echo Grid',
    shortName: 'Echo',
    description: 'Memorize an expanding sequence of color pulses and echo it back without breaking the signal.',
    difficulty: 'Normal',
    tags: ['Memory', 'Touch + keys', 'Local'],
    icon: BrainCircuit,
    glow: 'from-violet-500/20 to-rose-500/5',
    featured: true,
    new: true,
  },
  {
    id: 'signal-maze',
    name: 'Signal Maze',
    shortName: 'Maze',
    description: 'Navigate a freshly generated maze and connect the signal in as few moves as possible.',
    difficulty: 'Relaxed',
    tags: ['Puzzle', 'Procedural', 'No game loop'],
    icon: RadioTower,
    glow: 'from-emerald-500/20 to-sky-500/5',
    featured: true,
    new: true,
  },
  {
    id: 'reaction-timer',
    name: 'Reaction Timer',
    shortName: 'Reaction',
    description: 'Wait for green, then tap. A tiny test for reflexes and restraint.',
    difficulty: 'Normal',
    tags: ['Focus', 'Speed', 'Quick'],
    icon: Timer,
    glow: 'from-amber-500/15 to-orange-500/5',
  },
  {
    id: 'focus-breathing',
    name: 'Focus Breathing',
    shortName: 'Breathe',
    description: 'A quiet box-breathing guide for resetting between tasks.',
    difficulty: 'Relaxed',
    tags: ['Calm', 'Breathing', '3–5 min'],
    icon: Wind,
    glow: 'from-sky-500/15 to-teal-500/5',
  },
  {
    id: 'jump-game',
    name: 'Jump Game',
    shortName: 'Jump',
    description: 'A lightweight endless runner with keyboard, touch, and controller input.',
    difficulty: 'Challenging',
    tags: ['Runner', 'Controller', 'Endless'],
    icon: Zap,
    glow: 'from-orange-500/15 to-yellow-500/5',
  },
  {
    id: 'ai-game',
    name: 'Grid Hunter',
    shortName: 'Hunter',
    description: 'Outmaneuver a hunter bot while collecting data nodes in a tactical grid chase.',
    difficulty: 'Challenging',
    tags: ['Strategy', 'Controller', 'Progression'],
    icon: Bot,
    glow: 'from-fuchsia-500/15 to-violet-500/5',
  },
  {
    id: 'snake-game',
    name: 'Wrap Snake',
    shortName: 'Snake',
    description: 'An easygoing endless snake where every edge leads back onto the board.',
    difficulty: 'Relaxed',
    tags: ['Arcade', 'Wraparound', 'Infinite'],
    icon: Gamepad2,
    glow: 'from-lime-500/15 to-green-500/5',
  },
  {
    id: 'tamagotchi',
    name: 'Pocket Pet',
    shortName: 'Pet',
    description: 'Raise a mysterious companion by reading its behavior instead of managing a spreadsheet.',
    difficulty: 'Relaxed',
    tags: ['Persistent', 'Care sim', 'Local'],
    icon: Egg,
    glow: 'from-pink-500/15 to-amber-500/5',
  },
];

const difficultyColor: Record<GameDefinition['difficulty'], string> = {
  Relaxed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  Normal: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  Challenging: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
};

const Games = () => {
  const [activeGameId, setActiveGameId] = useState<GameId>('tetris-game');
  const [isGameOpen, setIsGameOpen] = useState(false);
  const [aiSummary, setAiSummary] = useState<AIGameCardSummary>(() => getAIGameCardSummary());
  const activeGame = useMemo(() => GAMES.find((game) => game.id === activeGameId) ?? GAMES[0], [activeGameId]);

  const openGame = (gameId: GameId) => {
    setActiveGameId(gameId);
    setIsGameOpen(true);
  };

  const closeGame = useCallback(() => {
    setIsGameOpen(false);
    setAiSummary(getAIGameCardSummary());
  }, []);

  useEffect(() => {
    if (!isGameOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeGame();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeGame, isGameOpen]);

  useEffect(() => {
    const refresh = () => setAiSummary(getAIGameCardSummary());
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return (
    <div className="mx-auto max-w-7xl space-y-7 px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
      <header className="relative overflow-hidden rounded-2xl border bg-slate-950 px-5 py-7 text-white shadow-lg sm:px-8 sm:py-9">
        <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-400/20 blur-3xl" />
        <div className="absolute -bottom-20 left-1/3 h-44 w-44 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="relative max-w-2xl space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-slate-200">
            <Sparkles className="h-3.5 w-3.5 text-blue-300" />
            Nine tiny ways to reset
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Take a better break.</h1>
          <p className="text-sm leading-relaxed text-slate-300 sm:text-base">
            Every game plays on your device. Only your Block Stack personal best uses the server, keeping play instant and resource use near zero.
          </p>
        </div>
      </header>

      <section className="space-y-3" aria-labelledby="featured-games">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Start here</p>
            <h2 id="featured-games" className="mt-1 text-xl font-semibold">Featured games</h2>
          </div>
          <span className="text-xs text-muted-foreground">No downloads</span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {GAMES.filter((game) => game.featured).map((game) => <GameCard key={game.id} game={game} prominent onPlay={openGame} />)}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="all-games">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">All games</p>
          <h2 id="all-games" className="mt-1 text-xl font-semibold">Pick your pace</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {GAMES.filter((game) => !game.featured).map((game) => (
            <GameCard key={game.id} game={game} onPlay={openGame} summary={game.id === 'ai-game' ? `Best floor ${aiSummary.bestFloor} · ${aiSummary.dailyStreak} day streak` : undefined} />
          ))}
        </div>
      </section>

      {isGameOpen && (
        <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col overflow-hidden bg-background" role="dialog" aria-modal="true" aria-label={`${activeGame.name} game`}>
          <div className="shrink-0 border-b bg-background/95 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:px-5">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${activeGame.glow}`}><activeGame.icon className="h-5 w-5 text-accent" /></span>
                <div className="min-w-0"><h2 className="truncate text-base font-semibold sm:text-lg">{activeGame.name}</h2><p className="hidden truncate text-xs text-muted-foreground sm:block">{activeGame.description}</p></div>
              </div>
              <Button className="h-10 w-10 shrink-0" variant="outline" size="icon" onClick={closeGame} aria-label="Close game"><X className="h-5 w-5" /></Button>
            </div>
            <nav className="mx-auto mt-2 flex max-w-7xl gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Switch game">
              {GAMES.map((game) => {
                const Icon = game.icon;
                const active = game.id === activeGameId;
                return (
                  <button key={game.id} type="button" onClick={() => setActiveGameId(game.id)} className={`flex h-9 shrink-0 touch-manipulation items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition ${active ? 'border-accent bg-accent text-accent-foreground shadow-sm' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}>
                    <Icon className="h-3.5 w-3.5" /><span>{game.shortName}</span>
                  </button>
                );
              })}
            </nav>
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-5">
            <div className="mx-auto max-w-6xl"><Suspense fallback={<p role="status" className="p-6 text-muted-foreground">Loading game…</p>}>{renderGame(activeGameId)}</Suspense></div>
          </main>
        </div>
      )}
    </div>
  );
};

const GameCard = ({ game, onPlay, prominent = false, summary }: { game: GameDefinition; onPlay: (id: GameId) => void; prominent?: boolean; summary?: string }) => {
  const Icon = game.icon;
  return (
    <button type="button" onClick={() => onPlay(game.id)} className={`group relative overflow-hidden rounded-2xl border bg-card text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${prominent ? 'min-h-[220px] p-5' : 'min-h-[180px] p-4'}`}>
      <div className={`absolute inset-0 bg-gradient-to-br ${game.glow} opacity-70 transition group-hover:opacity-100`} />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <span className={`grid place-items-center rounded-xl border border-white/20 bg-background/75 shadow-sm ${prominent ? 'h-12 w-12' : 'h-10 w-10'}`}><Icon className={`${prominent ? 'h-6 w-6' : 'h-5 w-5'} text-accent`} /></span>
          <div className="flex items-center gap-1.5">
            {game.new && <Badge className="bg-accent text-accent-foreground">New</Badge>}
            <Badge variant="secondary" className={difficultyColor[game.difficulty]}>{game.difficulty}</Badge>
          </div>
        </div>
        <h3 className={`mt-4 font-semibold ${prominent ? 'text-xl' : 'text-base'}`}>{game.name}</h3>
        <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{game.description}</p>
        {summary && <p className="mt-2 text-xs font-medium text-foreground">{summary}</p>}
        <div className="mt-auto flex items-end justify-between gap-3 pt-4">
          <div className="flex flex-wrap gap-1.5">{game.tags.slice(0, prominent ? 3 : 2).map((tag) => <span key={tag} className="rounded-full border bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">{tag}</span>)}</div>
          <span className="flex shrink-0 items-center text-xs font-semibold text-accent">Play <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></span>
        </div>
      </div>
    </button>
  );
};

const renderGame = (gameId: GameId) => {
  if (gameId === 'tetris-game') return <TetrisGame />;
  if (gameId === 'echo-sequence') return <EchoSequenceGame />;
  if (gameId === 'signal-maze') return <SignalMazeGame />;
  if (gameId === 'reaction-timer') return <ReactionTimerGame />;
  if (gameId === 'focus-breathing') return <FocusBreathingGame />;
  if (gameId === 'jump-game') return <JumpGame />;
  if (gameId === 'ai-game') return <AIGame />;
  if (gameId === 'snake-game') return <SnakeGame />;
  return <TamagotchiGame />;
};

export default Games;
