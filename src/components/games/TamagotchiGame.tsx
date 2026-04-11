import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Egg, Heart, Sparkles } from 'lucide-react';

type LifeStage = 'egg' | 'hatchling' | 'young' | 'adult' | 'elder' | 'deceased';
type SpeciesId = 'mossling' | 'glimfox' | 'puddlefin' | 'emberbun';
type Personality = 'curious' | 'sleepy' | 'bold' | 'gentle';
type Mood = 'happy' | 'content' | 'moody' | 'upset' | 'critical';
type EggType = 'forest' | 'moon' | 'tide' | 'ember';
type DeathType = 'natural' | 'critical-failures';

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

interface FailureEvent {
  id: string;
  text: string;
  at: number;
}

interface LifecycleWindows {
  hatchDueAt: number;
  youngDueAt: number;
  adultDueAt: number;
  elderDueAt: number;
  lifespanEndsAt: number;
}

interface PetState {
  version: number;
  createdAt: number;
  lastUpdatedAt: number;
  nextActionAt: number;
  hatchProgress: number;
  growthPoints: number;
  hiddenFailures: number;
  lifeStage: LifeStage;
  species: SpeciesId | null;
  personality: Personality;
  eggType: EggType | null;
  deathType: DeathType | null;
  lifecycle: LifecycleWindows;
  stats: PetStats;
  logs: CareLogEntry[];
  failureEvents: FailureEvent[];
}

const STORAGE_VERSION = 2;
const MAX_LOGS = 12;
const MAX_FAIL_EVENTS = 10;
const ACTION_COOLDOWN_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const SPECIES_DETAILS: Record<SpeciesId, { name: string; aura: string; adultTitle: string; elderTitle: string }> = {
  mossling: {
    name: 'Mossling',
    aura: 'leafy and grounded',
    adultTitle: 'Grovekeeper',
    elderTitle: 'Ancient Grovekeeper',
  },
  glimfox: {
    name: 'Glimfox',
    aura: 'clever and nimble',
    adultTitle: 'Moonrunner',
    elderTitle: 'Elder Moonrunner',
  },
  puddlefin: {
    name: 'Puddlefin',
    aura: 'playful and splashy',
    adultTitle: 'Ripplewarden',
    elderTitle: 'Ancient Ripplewarden',
  },
  emberbun: {
    name: 'Emberbun',
    aura: 'sparky and brave',
    adultTitle: 'Hearthbound',
    elderTitle: 'Elder Hearthbound',
  },
};

const PERSONALITY_HINTS: Record<Personality, string> = {
  curious: 'tilts its head often and watches everything around it.',
  sleepy: 'moves gently, with slow blinks and long stretches.',
  bold: 'stands tall and reacts quickly to every interaction.',
  gentle: 'keeps close, settles softly, and seems easy to comfort.',
};

const EGG_NOTES: Record<EggType, string> = {
  forest: 'Speckled green shell with soft moss-like flecks.',
  moon: 'Pale silver shell with star-like dots.',
  tide: 'Blue shell with wave stripes.',
  ember: 'Dark shell with warm orange cracks.',
};

const STAGE_FAILURE_ALLOWANCE: Record<Exclude<LifeStage, 'deceased'>, number> = {
  egg: 3,
  hatchling: 5,
  young: 8,
  adult: 10,
  elder: 2,
};

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

const addLog = (logs: CareLogEntry[], text: string, at = Date.now()) => {
  const entry = {
    id: `${at}-${Math.random().toString(16).slice(2)}`,
    text,
    at,
  };
  return [entry, ...logs].slice(0, MAX_LOGS);
};

const addFailure = (events: FailureEvent[], text: string, at = Date.now()) => {
  const entry = {
    id: `${at}-${Math.random().toString(16).slice(2)}`,
    text,
    at,
  };
  return [entry, ...events].slice(0, MAX_FAIL_EVENTS);
};

const pickFromArray = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

const buildLifecycle = (fromMs: number): LifecycleWindows => {
  // Target total life cycle: around 60 days with variance.
  const totalDays = 60 + Math.floor(Math.random() * 13) - 6; // 54..66
  const hatchDays = 4 + Math.floor(Math.random() * 4); // 4..7
  const youngDays = hatchDays + 12 + Math.floor(Math.random() * 4); // +12..15
  const adultDays = youngDays + 16 + Math.floor(Math.random() * 5); // +16..20
  const elderDays = Math.max(adultDays + 12 + Math.floor(Math.random() * 5), totalDays - 10); // near end phase

  return {
    hatchDueAt: fromMs + hatchDays * DAY_MS,
    youngDueAt: fromMs + youngDays * DAY_MS,
    adultDueAt: fromMs + adultDays * DAY_MS,
    elderDueAt: fromMs + elderDays * DAY_MS,
    lifespanEndsAt: fromMs + totalDays * DAY_MS,
  };
};

const createInitialState = (): PetState => {
  const now = Date.now();
  return {
    version: STORAGE_VERSION,
    createdAt: now,
    lastUpdatedAt: now,
    nextActionAt: now,
    hatchProgress: 0,
    growthPoints: 0,
    hiddenFailures: 0,
    lifeStage: 'egg',
    species: null,
    personality: pickFromArray(['curious', 'sleepy', 'bold', 'gentle'] as const),
    eggType: null,
    deathType: null,
    lifecycle: buildLifecycle(now),
    stats: {
      hunger: 76,
      hygiene: 74,
      energy: 80,
      affection: 68,
      joy: 66,
      health: 100,
    },
    logs: [
      {
        id: `spawn-${now}`,
        text: 'Choose an egg shell. The species that hatches will still be random.',
        at: now,
      },
    ],
    failureEvents: [],
  };
};

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

const readRawState = (key: string) => {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(key);
};

const writeState = (key: string, state: PetState) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(state));
};

const deriveMood = (stats: PetStats): Mood => {
  const baseline = (stats.hunger + stats.hygiene + stats.energy + stats.affection + stats.joy + stats.health) / 6;
  if (baseline >= 80) return 'happy';
  if (baseline >= 62) return 'content';
  if (baseline >= 46) return 'moody';
  if (baseline >= 30) return 'upset';
  return 'critical';
};

const formatDuration = (ms: number) => {
  const clamped = Math.max(0, ms);
  const totalHours = Math.floor(clamped / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) return `${hours}h`;
  return `${days}d ${hours}h`;
};

const stageLabel = (state: PetState) => {
  if (state.lifeStage === 'deceased') return 'Gone';
  if (state.lifeStage === 'egg') return 'Egg';
  if (!state.species) return 'Unknown';
  const base = SPECIES_DETAILS[state.species].name;
  if (state.lifeStage === 'adult') return SPECIES_DETAILS[state.species].adultTitle;
  if (state.lifeStage === 'elder') return SPECIES_DETAILS[state.species].elderTitle;
  if (state.lifeStage === 'young') return `${base} (Young)`;
  return `${base} (Hatchling)`;
};

const evolveByTime = (state: PetState, now: number): PetState => {
  let next = state;

  if (next.lifeStage === 'egg' && next.eggType && now >= next.lifecycle.hatchDueAt && next.hatchProgress >= 45) {
    const hatchedSpecies = pickFromArray(['mossling', 'glimfox', 'puddlefin', 'emberbun'] as const);
    next = {
      ...next,
      lifeStage: 'hatchling',
      species: hatchedSpecies,
      hatchProgress: 100,
      growthPoints: next.growthPoints + 10,
      logs: addLog(next.logs, `The ${next.eggType} egg hatched into a ${SPECIES_DETAILS[hatchedSpecies].name}!`, now),
    };
  }

  if (next.lifeStage === 'hatchling' && now >= next.lifecycle.youngDueAt) {
    next = {
      ...next,
      lifeStage: 'young',
      growthPoints: next.growthPoints + 20,
      logs: addLog(next.logs, `${stageLabel(next)} matured into a young companion.`, now),
    };
  }

  if (next.lifeStage === 'young' && now >= next.lifecycle.adultDueAt) {
    next = {
      ...next,
      lifeStage: 'adult',
      growthPoints: next.growthPoints + 25,
      logs: addLog(next.logs, `${stageLabel(next)} has reached adulthood.`, now),
    };
  }

  if (next.lifeStage === 'adult' && now >= next.lifecycle.elderDueAt) {
    next = {
      ...next,
      lifeStage: 'elder',
      logs: addLog(next.logs, `${stageLabel(next)} has entered elder years.`, now),
    };
  }

  if (next.lifeStage === 'elder' && now >= next.lifecycle.lifespanEndsAt) {
    next = {
      ...next,
      lifeStage: 'deceased',
      deathType: 'natural',
      logs: addLog(next.logs, 'Your pet passed peacefully of old age.', now),
    };
  }

  return next;
};

const applyPassiveChanges = (state: PetState): PetState => {
  const now = Date.now();
  const elapsedMs = now - state.lastUpdatedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return state;
  }

  let next = { ...state, stats: { ...state.stats } };
  const hours = elapsedMs / (60 * 60 * 1000);

  if (next.lifeStage !== 'deceased') {
    const stageDrain = next.lifeStage === 'egg' ? 0.8 : next.lifeStage === 'elder' ? 1.2 : 1;
    next.stats.hunger = clamp(next.stats.hunger - hours * 1.2 * stageDrain, 5, 100);
    next.stats.hygiene = clamp(next.stats.hygiene - hours * 0.9 * stageDrain, 5, 100);
    next.stats.energy = clamp(next.stats.energy - hours * 0.7 * stageDrain, 5, 100);
    next.stats.affection = clamp(next.stats.affection - hours * 0.65, 5, 100);
    next.stats.joy = clamp(next.stats.joy - hours * 0.75, 5, 100);

    const support = (next.stats.hunger + next.stats.hygiene + next.stats.energy + next.stats.affection + next.stats.joy) / 5;
    const drift = (support - 55) / 80;
    next.stats.health = clamp(next.stats.health + drift * hours, 10, 100);

    if (next.lifeStage === 'egg' && next.eggType) {
      next.hatchProgress = clamp(next.hatchProgress + hours * 0.8 + (support >= 65 ? 0.35 * hours : 0), 0, 100);
    }

    const failureChecks = Math.floor(hours / 6);
    for (let i = 0; i < failureChecks; i += 1) {
      const criticalNeeds = [next.stats.hunger, next.stats.energy, next.stats.hygiene].filter((v) => v < 18).length;
      const severeStress = next.stats.joy < 18 && next.stats.affection < 18;
      if (criticalNeeds >= 2 || severeStress) {
        next.hiddenFailures += 1;
        next.failureEvents = addFailure(
          next.failureEvents,
          criticalNeeds >= 2
            ? 'Extended neglect window: basic needs stayed critical for too long.'
            : 'Emotional crash: prolonged isolation and low mood.'
        );
      }
    }

    const allowance = STAGE_FAILURE_ALLOWANCE[next.lifeStage === 'deceased' ? 'elder' : next.lifeStage];
    if (next.hiddenFailures > allowance) {
      next.failureEvents = addFailure(next.failureEvents, 'Complication event: untreated problems escalated.');
      next.stats.health = clamp(next.stats.health - 20);
      next.hiddenFailures = allowance;

      if (next.lifeStage === 'elder' && next.stats.health <= 22) {
        next.lifeStage = 'deceased';
        next.deathType = 'critical-failures';
        next.logs = addLog(next.logs, 'Your pet died from accumulated complications.');
      }
    }

    next = evolveByTime(next, now);
  }

  return {
    ...next,
    lastUpdatedAt: now,
  };
};

const getVisual = (state: PetState, breatheFrame: number) => {
  if (state.lifeStage === 'deceased') {
    return ['    .----.    ', '   / RIP \\   ', '  |  PET  |   ', '  |______|   ', '   /    \\   '];
  }

  if (state.lifeStage === 'egg') {
    const eggPulse = breatheFrame % 2 === 0 ? '   /\\_/\\   ' : '   /\\~_/\\  ';
    const cracks = state.hatchProgress > 75 ? '  (  ._.  )  ' : '  (  ---  )  ';
    return [eggPulse, cracks, '   \\_===_/  ', '    /___\\   ', '  warm egg   '];
  }

  const breathe = breatheFrame % 2 === 0 ? '  (  )  ' : '  ( .. ) ';
  const species = state.species ?? 'mossling';

  if (species === 'mossling') return ['  .-^-.  ', ' (o   o) ', breathe, ' /|___|\\ ', '  /   \\  '];
  if (species === 'glimfox') return [' /\\_/\\  ', '( • • ) ', breathe, ' /|___|\\ ', '  /_ _\\  '];
  if (species === 'puddlefin') return ['  ~~~~   ', ' (o w o) ', breathe, ' /|___|\\ ', '  /___\\  '];
  return ['  /\\_/\\  ', ' (•ᴥ• ) ', breathe, ' /|___|\\ ', '  /_ _\\  '];
};

const TamagotchiGame = () => {
  const { user, loading } = useAuth();
  const storageKey = useMemo(() => `unihub:pet:v2:${user?.id ?? 'guest'}`, [user?.id]);
  const [state, setState] = useState<PetState>(() => readState(storageKey));
  const [breatheFrame, setBreatheFrame] = useState(0);

  useEffect(() => {
    if (loading) return;

    if (typeof window !== 'undefined' && user?.id) {
      const guestKey = 'unihub:pet:v2:guest';
      const guestRaw = readRawState(guestKey);
      const existingUserRaw = readRawState(storageKey);

      if (!existingUserRaw && guestRaw) {
        window.localStorage.setItem(storageKey, guestRaw);
        window.localStorage.removeItem(guestKey);
      }
    }

    setState(applyPassiveChanges(readState(storageKey)));
  }, [loading, storageKey, user?.id]);

  useEffect(() => {
    if (loading) return;
    writeState(storageKey, state);
  }, [loading, storageKey, state]);

  useEffect(() => {
    const timer = window.setInterval(() => setBreatheFrame((frame) => (frame + 1) % 2), 1200);
    return () => window.clearInterval(timer);
  }, []);

  const mood = deriveMood(state.stats);
  const visuals = getVisual(state, breatheFrame);
  const isActionBlocked = Date.now() < state.nextActionAt;

  const withUpdate = (updater: (prev: PetState) => PetState) => {
    setState((prev) => {
      if (prev.lifeStage === 'deceased') return prev;
      const base = applyPassiveChanges(prev);
      const updated = updater(base);
      return {
        ...updated,
        lastUpdatedAt: Date.now(),
      };
    });
  };

  const chooseEgg = (eggType: EggType) => {
    withUpdate((base) => {
      if (base.eggType) return base;
      return {
        ...base,
        eggType,
        hatchProgress: 12,
        logs: addLog(base.logs, `You chose the ${eggType} shell. What hatches is still a mystery.`),
      };
    });
  };

  const handleCareAction = (message: string, deltas: Partial<Record<keyof PetStats, number>>, hatchBoost = 0) => {
    withUpdate((base) => {
      if (Date.now() < base.nextActionAt || !base.eggType) return base;

      const nextStats = { ...base.stats };
      (Object.keys(deltas) as Array<keyof PetStats>).forEach((key) => {
        nextStats[key] = clamp(nextStats[key] + (deltas[key] ?? 0));
      });

      return {
        ...base,
        stats: nextStats,
        hatchProgress: base.lifeStage === 'egg' ? clamp(base.hatchProgress + hatchBoost, 0, 100) : base.hatchProgress,
        growthPoints: base.growthPoints + 2,
        nextActionAt: Date.now() + ACTION_COOLDOWN_MS,
        logs: addLog(base.logs, message),
      };
    });
  };

  const handleReset = () => {
    setState(createInitialState());
  };

  const now = Date.now();

  return (
    <Card className="border-accent/20 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Egg className="h-5 w-5 text-accent" />
          Pocket Pet (Idle Lifecycle)
        </CardTitle>
        <CardDescription>
          Time continues in the background. Your pet matures over roughly two months, then eventually dies of age with natural variance.
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

            {state.lifeStage === 'deceased' ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {state.deathType === 'natural'
                    ? 'Your companion reached the end of its natural lifespan.'
                    : 'Your companion died after repeated hidden complications.'}
                </p>
                <div className="rounded-md border bg-background p-2">
                  <p className="text-xs font-medium mb-1">Failure record</p>
                  <div className="space-y-1">
                    {state.failureEvents.length === 0 && <p className="text-xs text-muted-foreground">No major failures logged.</p>}
                    {state.failureEvents.map((failure) => (
                      <p key={failure.id} className="text-[11px] text-muted-foreground">• {failure.text}</p>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {state.lifeStage === 'egg'
                  ? state.eggType
                    ? `Egg shell: ${EGG_NOTES[state.eggType]} Hatch meter is building steadily.`
                    : 'Choose an egg shell to begin. Hatch species is still random.'
                  : `It looks ${SPECIES_DETAILS[state.species ?? 'mossling'].aura} and ${PERSONALITY_HINTS[state.personality]}`}
              </p>
            )}

            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Lifecycle clock</div>
              <Progress value={clamp(((now - state.createdAt) / (state.lifecycle.lifespanEndsAt - state.createdAt)) * 100)} />
            </div>
          </div>

          <div className="space-y-4">
            {!state.eggType && state.lifeStage === 'egg' && (
              <div className="rounded-lg border p-3 space-y-2 bg-muted/10">
                <p className="text-sm font-medium">Pick your egg shell</p>
                <p className="text-xs text-muted-foreground">This only sets flavor and starting bias. The hatched pet remains random.</p>
                <div className="grid grid-cols-2 gap-2">
                  {(['forest', 'moon', 'tide', 'ember'] as EggType[]).map((eggType) => (
                    <Button key={eggType} variant="outline" onClick={() => chooseEgg(eggType)} className="capitalize">
                      {eggType} egg
                    </Button>
                  ))}
                </div>
              </div>
            )}

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
              <Button disabled={isActionBlocked || !state.eggType || state.lifeStage === 'deceased'} onClick={() => handleCareAction('Fed and watered. The pet settles a bit.', { hunger: 10, joy: 2, health: 1 }, 5)}>
                Feed
              </Button>
              <Button variant="secondary" disabled={isActionBlocked || !state.eggType || state.lifeStage === 'deceased'} onClick={() => handleCareAction('Gentle petting improved trust and calm.', { affection: 10, joy: 5, energy: -2 }, 4)}>
                Pet
              </Button>
              <Button variant="secondary" disabled={isActionBlocked || !state.eggType || state.lifeStage === 'deceased'} onClick={() => handleCareAction('Play session complete. Fun, but tiring.', { joy: 10, affection: 4, energy: -8, hygiene: -4 }, 3)}>
                Play
              </Button>
              <Button variant="outline" disabled={isActionBlocked || !state.eggType || state.lifeStage === 'deceased'} onClick={() => handleCareAction('Quick cleanup done.', { hygiene: 12, health: 2, affection: 1 }, 4)}>
                Clean
              </Button>
              <Button variant="outline" disabled={isActionBlocked || !state.eggType || state.lifeStage === 'deceased'} onClick={() => handleCareAction('Rest time. Energy rises slowly.', { energy: 11, joy: 2, hunger: -3 }, 2)}>
                Nap
              </Button>
            </div>

            {isActionBlocked && state.lifeStage !== 'deceased' && (
              <p className="text-xs text-muted-foreground">
                Next care action available in {formatDuration(state.nextActionAt - now)}.
              </p>
            )}

            <Separator />

            <div className="rounded-lg border p-3 space-y-2 bg-muted/20">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium flex items-center gap-2"><Heart className="h-4 w-4 text-accent" /> Timeline log</p>
                <Button size="sm" variant="ghost" onClick={handleReset}>Start over</Button>
              </div>
              <div className="space-y-1">
                {state.logs.map((log) => (
                  <p key={log.id} className="text-xs text-muted-foreground">• {log.text}</p>
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
