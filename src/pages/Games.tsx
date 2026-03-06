import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Bot, Blocks, Gamepad2, Timer, Wind, Zap, X } from 'lucide-react';
import ReactionTimerGame from '@/components/games/ReactionTimerGame';
import FocusBreathingGame from '@/components/games/FocusBreathingGame';
import JumpGame from '@/components/games/JumpGame';
import AIGame from '@/components/games/AIGame';
import TetrisGame from '@/components/games/TetrisGame';
import SnakeGame from '@/components/games/SnakeGame';

type GameId =
  | 'reaction-timer'
  | 'focus-breathing'
  | 'jump-game'
  | 'ai-game'
  | 'tetris-game'
  | 'snake-game';

interface GameDefinition {
  id: GameId;
  name: string;
  description: string;
  difficulty: 'Relaxed' | 'Normal' | 'Challenging';
  tags: string[];
}

const GAMES: GameDefinition[] = [
  {
    id: 'reaction-timer',
    name: 'Reaction Timer',
    description: 'Test how quickly you can respond when the screen changes – great for a quick energy boost.',
    difficulty: 'Normal',
    tags: ['Focus', 'Speed', '2–3 min'],
  },
  {
    id: 'focus-breathing',
    name: 'Focus Breathing',
    description: 'Guided box-breathing to calm your mind before diving back into deep work.',
    difficulty: 'Relaxed',
    tags: ['Calm', 'Breathing', '3–5 min'],
  },
  {
    id: 'jump-game',
    name: 'Jump Game',
    description: 'Chrome-style runner: jump over cacti. Keyboard (Space / ↑) and controller (A or D-pad up) supported.',
    difficulty: 'Challenging',
    tags: ['Runner', 'Controller', 'Endless'],
  },
  {
    id: 'ai-game',
    name: 'AI Game',
    description: 'Outrun a hunter bot in a tactical grid chase. Collect data nodes while the AI gets faster each point.',
    difficulty: 'Challenging',
    tags: ['Strategy', 'Controller', 'Keyboard + Touch'],
  },
  {
    id: 'tetris-game',
    name: 'Block Stack (Infinite)',
    description: 'Original block-stacking mode with endless play. Speed rises slowly over time to stay challenging, not punishing.',
    difficulty: 'Normal',
    tags: ['Blocks', 'Controller', 'Infinite'],
  },
  {
    id: 'snake-game',
    name: 'Snake (Wrap)',
    description: 'Easy endless snake with edge teleportation. Crossing any border wraps to the opposite side.',
    difficulty: 'Relaxed',
    tags: ['Arcade', 'Wraparound', 'Infinite'],
  },
];

const Games = () => {
  const [activeGameId, setActiveGameId] = useState<GameId>('reaction-timer');
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const [orientationLockSupported, setOrientationLockSupported] = useState(true);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);

  const activeGame = useMemo(() => GAMES.find((game) => game.id === activeGameId) ?? GAMES[0], [activeGameId]);

  const lockLandscape = useCallback(async () => {
    try {
      const orientation = (screen as Screen & { orientation?: { lock?: (value: string) => Promise<void> } }).orientation;
      if (!orientation?.lock) {
        setOrientationLockSupported(false);
        return;
      }
      await orientation.lock('landscape');
      setOrientationLockSupported(true);
    } catch {
      setOrientationLockSupported(false);
    }
  }, []);

  const unlockOrientation = useCallback(() => {
    try {
      const orientation = (screen as Screen & { orientation?: { unlock?: () => void } }).orientation;
      orientation?.unlock?.();
    } catch {
      // Ignore failures in browsers without unlock support.
    }
  }, []);

  const openGameFullscreen = (gameId: GameId) => {
    setActiveGameId(gameId);
    setIsFullscreenOpen(true);
  };

  const closeGameFullscreen = useCallback(async () => {
    setIsFullscreenOpen(false);
    unlockOrientation();
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Some browsers fail silently; keeping modal closed is enough.
      }
    }
  }, [unlockOrientation]);

  useEffect(() => {
    if (!isFullscreenOpen) return;
    const container = fullscreenContainerRef.current;
    if (!container) return;

    let cancelled = false;
    const goFullscreen = async () => {
      try {
        if (!document.fullscreenElement) {
          await container.requestFullscreen();
        }
      } catch {
        // Keep overlay fallback even if fullscreen API is blocked.
      }
      if (!cancelled) {
        await lockLandscape();
      }
    };

    void goFullscreen();
    return () => {
      cancelled = true;
    };
  }, [isFullscreenOpen, lockLandscape]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && isFullscreenOpen) {
        setIsFullscreenOpen(false);
        unlockOrientation();
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [isFullscreenOpen, unlockOrientation]);

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-8">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
          <Gamepad2 className="h-3.5 w-3.5" />
          <span>New</span>
        </div>
        <h1 className="text-2xl md:text-3xl font-bold text-foreground">Games</h1>
        <p className="text-muted-foreground max-w-2xl">
          Take a quick break with mini-games designed for focus and fun. Everything runs locally in your
          browser – no data is stored or sent to the server.
        </p>
      </header>

      <div className="space-y-8">
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Games catalog
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {GAMES.map((game) => {
              const isActive = activeGameId === game.id;
              return (
                <Card
                  key={game.id}
                  className={`transition-all ${
                    isActive ? 'ring-2 ring-accent shadow-md' : 'hover:shadow-sm'
                  }`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        {game.id === 'reaction-timer' && <Timer className="h-4 w-4 text-accent" />}
                        {game.id === 'focus-breathing' && <Wind className="h-4 w-4 text-accent" />}
                        {game.id === 'jump-game' && <Zap className="h-4 w-4 text-accent" />}
                        {game.id === 'ai-game' && <Bot className="h-4 w-4 text-accent" />}
                        {game.id === 'tetris-game' && <Blocks className="h-4 w-4 text-accent" />}
                        {game.id === 'snake-game' && <Gamepad2 className="h-4 w-4 text-accent" />}
                        <span>{game.name}</span>
                      </CardTitle>
                      <Badge variant="outline" className="text-[11px]">
                        {game.difficulty}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1 text-xs line-clamp-3">
                      {game.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 pt-0">
                    <div className="flex flex-wrap gap-1.5">
                      {game.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[11px]">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      className="mt-1"
                      variant={isActive ? 'default' : 'outline'}
                      onClick={() => openGameFullscreen(game.id)}
                    >
                      {isActive ? 'Play Fullscreen' : 'Play'}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      </div>

      {isFullscreenOpen && (
        <div
          ref={fullscreenContainerRef}
          className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm p-4 md:p-8 overflow-auto"
        >
          <div className="max-w-7xl mx-auto space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl md:text-2xl font-bold text-foreground">{activeGame.name}</h2>
                <p className="text-sm text-muted-foreground mt-1">{activeGame.description}</p>
                {!orientationLockSupported && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Landscape lock is not available in this browser. Rotate your phone manually for the best gameplay.
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={closeGameFullscreen}
                aria-label="Close fullscreen game"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <Tabs value={activeGameId} onValueChange={(value) => setActiveGameId(value as GameId)} className="w-full">
              <TabsList className="grid w-full grid-cols-3 md:grid-cols-6 mb-4">
                <TabsTrigger value="reaction-timer">Reaction Timer</TabsTrigger>
                <TabsTrigger value="focus-breathing">Focus Breathing</TabsTrigger>
                <TabsTrigger value="jump-game">Jump Game</TabsTrigger>
                <TabsTrigger value="ai-game">AI Game</TabsTrigger>
                <TabsTrigger value="tetris-game">Block Stack</TabsTrigger>
                <TabsTrigger value="snake-game">Snake</TabsTrigger>
              </TabsList>
              <TabsContent value="reaction-timer">
                <ReactionTimerGame />
              </TabsContent>
              <TabsContent value="focus-breathing">
                <FocusBreathingGame />
              </TabsContent>
              <TabsContent value="jump-game">
                <JumpGame />
              </TabsContent>
              <TabsContent value="ai-game">
                <AIGame />
              </TabsContent>
              <TabsContent value="tetris-game">
                <TetrisGame />
              </TabsContent>
              <TabsContent value="snake-game">
                <SnakeGame />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      )}
    </div>
  );
};

export default Games;

