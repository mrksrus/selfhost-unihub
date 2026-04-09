import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { Egg, Heart, Skull, Sparkles } from 'lucide-react';

type LifeStage = 'egg' | 'hatchling' | 'young' | 'adult' | 'deceased';
type SpeciesId = 'mossling' | 'glimfox' | 'puddlefin' | 'emberbun';
type Personality = 'curious' | 'sleepy' | 'bold' | 'gentle';
type Mood = 'happy' | 'content' | 'moody' | 'upset' | 'critical';

interface PetStats {
  hunger: number;
  hygiene: number;
  energy: number;
  affection: number;
  joy: number;
  health: number;
}

interface CareLogEntry {
  id: string;
  text: string;
  at: number;
}

interface PetState {
  version: number;
  createdAt: number;
  lastUpdatedAt: number;
  hatchProgress: number;
  growthPoints: number;
  harmfulActions: number;
  lifeStage: LifeStage;
  species: SpeciesId | null;
  personality: Personality;
  stats: PetStats;
  logs: CareLogEntry[];
}

const STORAGE_VERSION = 1;
const MAX_LOGS = 8;
const MAX_HARMFUL_ACTIONS = 3;

const SPECIES_DETAILS: Record<SpeciesId, { name: string; aura: string; adultTitle: string }> = {
  mossling: {
    name: 'Mossling',
    aura: 'leafy and grounded',
    adultTitle: 'Grovekeeper',
  },
  glimfox: {
    name: 'Glimfox',
    aura: 'clever and nimble',
    adultTitle: 'Moonrunner',
  },
  puddlefin: {
    name: 'Puddlefin',
    aura: 'playful and splashy',
    adultTitle: 'Ripplewarden',
  },
  emberbun: {
    name: 'Emberbun',
    aura: 'sparky and brave',
    adultTitle: 'Hearthbound',
  },
};

const PERSONALITY_HINTS: Record<Personality, string> = {
  curious: 'tilts its head often and watches everything around it.',
  sleepy: 'moves gently, with slow blinks and long stretches.',
  bold: 'stands tall and reacts quickly to every interaction.',
  gentle: 'keeps close, settles softly, and seems easy to comfort.',
};

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

const addLog = (logs: CareLogEntry[], text: string) => {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
    at: Date.now(),
  };
  return [entry, ...logs].slice(0, MAX_LOGS);
};

const pickFromArray = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

const createInitialState = (): PetState => ({
  version: STORAGE_VERSION,
  createdAt: Date.now(),
  lastUpdatedAt: Date.now(),
  hatchProgress: 5,
  growthPoints: 0,
  harmfulActions: 0,
  lifeStage: 'egg',
  species: null,
  personality: pickFromArray(['curious', 'sleepy', 'bold', 'gentle']),
  stats: {
    hunger: 82,
    hygiene: 78,
    energy: 80,
    affection: 70,
    joy: 68,
    health: 100,
  },
  logs: [
    {
      id: 'spawn-log',
      text: 'A warm egg has arrived. Keep it fed, clean, and comforted until it hatches.',
      at: Date.now(),
    },
  ],
});

const readState = (key: string) => {
  if (typeof window === 'undefined') return createInitialState();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw) as PetState;
    if (!parsed || parsed.version !== STORAGE_VERSION) return createInitialState();
    return parsed;
  } catch {
    return createInitialState();
  }
};

const writeState = (key: string, state: PetState) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(state));
};

const applyPassiveChanges = (state: PetState): PetState => {
  const now = Date.now();
  const elapsedHours = (now - state.lastUpdatedAt) / (1000 * 60 * 60);
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
    return { ...state, lastUpdatedAt: now };
  }

  const drop = elapsedHours;
  const stats: PetStats = {
    hunger: clamp(state.stats.hunger - drop * 1.6, 18, 100),
    hygiene: clamp(state.stats.hygiene - drop * 1.2, 16, 100),
    energy: clamp(state.stats.energy - drop * 0.9, 22, 100),
    affection: clamp(state.stats.affection - drop * 1.1, 20, 100),
    joy: clamp(state.stats.joy - drop * 0.9, 15, 100),
    health: state.stats.health,
  };

  const support = (stats.hunger + stats.hygiene + stats.affection + stats.energy + stats.joy) / 5;
  const healthDrift = (support - 50) / 75;
  stats.health = clamp(state.stats.health + healthDrift * elapsedHours, 25, 100);

  return {
    ...state,
    stats,
    lastUpdatedAt: now,
  };
};

const deriveMood = (stats: PetStats): Mood => {
  const baseline = (stats.hunger + stats.hygiene + stats.energy + stats.affection + stats.joy + stats.health) / 6;
  if (baseline >= 80) return 'happy';
  if (baseline >= 62) return 'content';
  if (baseline >= 46) return 'moody';
  if (baseline >= 30) return 'upset';
  return 'critical';
};

const stageLabel = (state: PetState) => {
  if (state.lifeStage === 'deceased') return 'Gone';
  if (state.lifeStage === 'egg') return 'Egg';
  if (!state.species) return 'Unknown';
  const base = SPECIES_DETAILS[state.species].name;
  if (state.lifeStage === 'adult') return SPECIES_DETAILS[state.species].adultTitle;
  if (state.lifeStage === 'young') return `${base} (Young)`;
  return `${base} (Hatchling)`;
};

const getVisual = (state: PetState, breatheFrame: number) => {
  if (state.lifeStage === 'deceased') {
    return ['  x   x  ', '    -    ', ' /|___|\\ ', '  /   \\  ', 'quiet...'];
  }

  if (state.lifeStage === 'egg') {
    const shell = breatheFrame % 2 === 0 ? '  /\\_/\\  ' : '  /\\~_/\\ ';
    const cracks = state.hatchProgress >= 70 ? ' (  ._.  )' : ' (  ---  )';
    const glow = state.hatchProgress >= 40 ? '  \\_===_/ ' : '  \\_____/ ';
    return [shell, cracks, glow, '   /___\\  ', 'warm egg'];
  }

  const species = state.species ?? 'mossling';
  const breathe = breatheFrame % 2 === 0 ? '  (  )  ' : '  ( .. ) ';

  if (species === 'mossling') {
    return ['  .-^-.  ', ' (o   o) ', breathe, ' /|___|\\ ', '  /   \\  '];
  }

  if (species === 'glimfox') {
    return [' /\_/\\  ', '( • • ) ', breathe, ' /|___|\\ ', '  /_ _\\  '];
  }

  if (species === 'puddlefin') {
    return ['  ~~~~   ', ' (o w o) ', breathe, ' /|___|\\ ', '  /___\\  '];
  }

  return ['  /\_/\  ', ' (•ᴥ• ) ', breathe, ' /|___|\\ ', '  /_ _\\  '];
};

const TamagotchiGame = () => {
  const { user } = useAuth();
  const storageKey = useMemo(() => `unihub:pet:v1:${user?.id ?? 'guest'}`, [user?.id]);
  const [state, setState] = useState<PetState>(() => readState(storageKey));
  const [breatheFrame, setBreatheFrame] = useState(0);
  const [armedDelete, setArmedDelete] = useState(false);

  useEffect(() => {
    setState(applyPassiveChanges(readState(storageKey)));
  }, [storageKey]);

  useEffect(() => {
    writeState(storageKey, state);
  }, [storageKey, state]);

  useEffect(() => {
    const timer = window.setInterval(() => setBreatheFrame((frame) => (frame + 1) % 2), 1100);
    return () => window.clearInterval(timer);
  }, []);

  const mood = deriveMood(state.stats);
  const visuals = getVisual(state, breatheFrame);

  const withStatUpdate = (updater: (prev: PetState) => PetState) => {
    setState((previous) => {
      if (previous.lifeStage === 'deceased') return previous;
      const next = updater(applyPassiveChanges(previous));
      return {
        ...next,
        lastUpdatedAt: Date.now(),
      };
    });
  };

  const tryMature = (candidate: PetState) => {
    if (candidate.lifeStage === 'egg' && candidate.hatchProgress >= 100) {
      const hatchedSpecies = pickFromArray(['mossling', 'glimfox', 'puddlefin', 'emberbun']);
      return {
        ...candidate,
        lifeStage: 'hatchling' as const,
        species: hatchedSpecies,
        growthPoints: candidate.growthPoints + 8,
        logs: addLog(candidate.logs, `The egg hatched into a ${SPECIES_DETAILS[hatchedSpecies].name}!`),
      };
    }

    if (candidate.lifeStage === 'hatchling' && candidate.growthPoints >= 60) {
      return {
        ...candidate,
        lifeStage: 'young' as const,
        logs: addLog(candidate.logs, `${stageLabel(candidate)} has grown into a sturdy young companion.`),
      };
    }

    if (candidate.lifeStage === 'young' && candidate.growthPoints >= 150) {
      return {
        ...candidate,
        lifeStage: 'adult' as const,
        logs: addLog(candidate.logs, `${stageLabel(candidate)} matured into adulthood.`),
      };
    }

    return candidate;
  };

  const handleCareAction = (
    statChanges: Partial<Record<keyof PetStats, number>>,
    hatchBoost = 0,
    growthBoost = 0,
    message: string
  ) => {
    withStatUpdate((base) => {
      let next: PetState = {
        ...base,
        hatchProgress: clamp(base.hatchProgress + hatchBoost, 0, 100),
        growthPoints: base.growthPoints + growthBoost,
        stats: {
          ...base.stats,
        },
        logs: addLog(base.logs, message),
      };

      (Object.keys(statChanges) as Array<keyof PetStats>).forEach((key) => {
        next.stats[key] = clamp(next.stats[key] + (statChanges[key] ?? 0));
      });

      next = tryMature(next);
      return next;
    });
  };

  const handleDangerAction = () => {
    withStatUpdate((base) => {
      const harmfulActions = base.harmfulActions + 1;
      const healthPenalty = harmfulActions >= MAX_HARMFUL_ACTIONS ? 100 : 34;
      const nextHealth = clamp(base.stats.health - healthPenalty);
      const willDie = harmfulActions >= MAX_HARMFUL_ACTIONS || nextHealth === 0;

      return {
        ...base,
        harmfulActions,
        lifeStage: willDie ? 'deceased' : base.lifeStage,
        stats: {
          ...base.stats,
          health: nextHealth,
          joy: clamp(base.stats.joy - 35),
          affection: clamp(base.stats.affection - 40),
        },
        logs: addLog(
          base.logs,
          willDie
            ? 'You ignored every warning and your pet is gone.'
            : 'Your pet recoils from the dangerous action. Another one like this could end it.'
        ),
      };
    });

    setArmedDelete(false);
  };

  const handleReset = () => {
    setState(createInitialState());
    setArmedDelete(false);
  };

  return (
    <Card className="border-accent/20 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Egg className="h-5 w-5 text-accent" />
          Pocket Pet (Persistent)
        </CardTitle>
        <CardDescription>
          One pet per user, saved locally and shared across app sections. Passive neglect can lower mood but cannot kill your pet.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Badge variant="outline">{stageLabel(state)}</Badge>
              <Badge className="capitalize" variant="secondary">{mood}</Badge>
            </div>

            <pre className="rounded-md border bg-background p-3 text-xs leading-4 text-center font-mono min-h-[130px]">
              {visuals.join('\n')}
            </pre>

            <p className="text-xs text-muted-foreground">
              {state.lifeStage === 'egg'
                ? `The egg gently rocks. Hatch progress: ${Math.round(state.hatchProgress)}%.`
                : `It looks ${SPECIES_DETAILS[state.species ?? 'mossling'].aura} and ${PERSONALITY_HINTS[state.personality]}`}
            </p>

            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Growth journey</div>
              <Progress value={state.lifeStage === 'egg' ? state.hatchProgress : clamp((state.growthPoints / 150) * 100)} />
              <p className="text-[11px] text-muted-foreground">
                Egg → Hatchling → Young → Adult. Growth is driven by daily care, not battle evolution.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {([
                ['Hunger', state.stats.hunger],
                ['Hygiene', state.stats.hygiene],
                ['Energy', state.stats.energy],
                ['Affection', state.stats.affection],
                ['Joy', state.stats.joy],
                ['Health', state.stats.health],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-md border p-2.5 bg-background">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium">{Math.round(value)}</span>
                  </div>
                  <Progress value={value} className="h-2" />
                </div>
              ))}
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
              <Button onClick={() => handleCareAction({ hunger: 18, joy: 4, health: 3 }, 14, 5, 'You fed your pet and it perked up immediately.')}>Feed</Button>
              <Button variant="secondary" onClick={() => handleCareAction({ affection: 17, joy: 7, energy: -2 }, 12, 6, 'You gave it a reassuring pat. It settles down happily.')}>Pet</Button>
              <Button variant="secondary" onClick={() => handleCareAction({ joy: 16, affection: 8, energy: -9, hygiene: -4 }, 9, 10, 'Playtime! Your pet bounced around excitedly.')}>Play</Button>
              <Button variant="outline" onClick={() => handleCareAction({ hygiene: 20, health: 4, affection: 2 }, 12, 5, 'A quick cleanup keeps your pet comfortable and healthy.')}>Clean</Button>
              <Button variant="outline" onClick={() => handleCareAction({ energy: 20, joy: 5, hunger: -5 }, 8, 4, 'A short nap restores energy.')}>Nap</Button>
            </div>

            <Separator />

            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                <Skull className="h-4 w-4 text-destructive" />
                Danger zone (active harm only)
              </div>
              <p className="text-xs text-muted-foreground mb-2">
                Your pet cannot die from inactivity. It can only die if you repeatedly trigger explicit harmful actions.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={armedDelete ? 'destructive' : 'outline'}
                  onClick={() => {
                    if (!armedDelete) {
                      setArmedDelete(true);
                      return;
                    }
                    handleDangerAction();
                  }}
                  className={cn(armedDelete && 'animate-pulse')}
                >
                  {armedDelete ? 'Confirm harmful action' : 'Unsafe experiment'}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Harmful actions: {state.harmfulActions}/{MAX_HARMFUL_ACTIONS}
                </span>
                {armedDelete && (
                  <Button size="sm" variant="ghost" onClick={() => setArmedDelete(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>

            <div className="rounded-lg border p-3 space-y-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium flex items-center gap-2"><Heart className="h-4 w-4 text-accent" /> Care history</p>
                <Button size="sm" variant="ghost" onClick={handleReset}>Start over</Button>
              </div>
              <div className="space-y-1">
                {state.logs.map((log) => (
                  <p key={log.id} className="text-xs text-muted-foreground">
                    • {log.text}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-md border bg-muted/10 p-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          Personality seed: <span className="capitalize font-medium text-foreground">{state.personality}</span>
        </div>
      </CardContent>
    </Card>
  );
};

export default TamagotchiGame;
