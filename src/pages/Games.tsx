import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Bot, Gamepad2, Timer, Wind, Zap } from 'lucide-react';
import ReactionTimerGame from '@/components/games/ReactionTimerGame';
import FocusBreathingGame from '@/components/games/FocusBreathingGame';
import TestGame from '@/components/games/TestGame';
import AIGame from '@/components/games/AIGame';

type GameId = 'reaction-timer' | 'focus-breathing' | 'test-game' | 'ai-game';

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
    id: 'test-game',
    name: 'Test Game',
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
];

const Games = () => {
  const [activeGameId, setActiveGameId] = useState<GameId>('reaction-timer');

  const activeGame = GAMES.find((game) => game.id === activeGameId) ?? GAMES[0];

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
                        {game.id === 'test-game' && <Zap className="h-4 w-4 text-accent" />}
                        {game.id === 'ai-game' && <Bot className="h-4 w-4 text-accent" />}
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
                      onClick={() => setActiveGameId(game.id)}
                    >
                      {isActive ? 'Playing' : 'Play'}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Now playing
              </h2>
              <p className="text-sm text-muted-foreground">{activeGame.description}</p>
            </div>
          </div>

          <Tabs
            value={activeGameId}
            onValueChange={(value) => setActiveGameId(value as GameId)}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-4 mb-3">
              <TabsTrigger value="reaction-timer">Reaction Timer</TabsTrigger>
              <TabsTrigger value="focus-breathing">Focus Breathing</TabsTrigger>
              <TabsTrigger value="test-game">Test Game</TabsTrigger>
              <TabsTrigger value="ai-game">AI Game</TabsTrigger>
            </TabsList>
            <TabsContent value="reaction-timer">
              <ReactionTimerGame />
            </TabsContent>
            <TabsContent value="focus-breathing">
              <FocusBreathingGame />
            </TabsContent>
            <TabsContent value="test-game">
              <TestGame />
            </TabsContent>
            <TabsContent value="ai-game">
              <AIGame />
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
};

export default Games;

