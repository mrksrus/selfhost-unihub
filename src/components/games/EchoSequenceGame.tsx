import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BrainCircuit, Play, RotateCcw } from 'lucide-react';

const TONES = [
  { label: 'Teal', color: 'bg-teal-500', active: 'ring-teal-300 shadow-[0_0_28px_rgba(20,184,166,0.65)]', key: '1' },
  { label: 'Violet', color: 'bg-violet-500', active: 'ring-violet-300 shadow-[0_0_28px_rgba(139,92,246,0.65)]', key: '2' },
  { label: 'Amber', color: 'bg-amber-500', active: 'ring-amber-300 shadow-[0_0_28px_rgba(245,158,11,0.65)]', key: '3' },
  { label: 'Rose', color: 'bg-rose-500', active: 'ring-rose-300 shadow-[0_0_28px_rgba(244,63,94,0.65)]', key: '4' },
] as const;

type Phase = 'idle' | 'showing' | 'input' | 'gameover';

const EchoSequenceGame = () => {
  const [sequence, setSequence] = useState<number[]>([]);
  const [inputIndex, setInputIndex] = useState(0);
  const [activeTone, setActiveTone] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [best, setBest] = useState(() => Number(window.localStorage.getItem('unihub:echo-grid:best') || 0));
  const playbackIdRef = useRef(0);

  const playSequence = useCallback(async (nextSequence: number[]) => {
    const playbackId = ++playbackIdRef.current;
    setPhase('showing');
    setInputIndex(0);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    for (const tone of nextSequence) {
      if (playbackId !== playbackIdRef.current) return;
      setActiveTone(tone);
      await new Promise((resolve) => window.setTimeout(resolve, 360));
      setActiveTone(null);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
    if (playbackId === playbackIdRef.current) setPhase('input');
  }, []);

  const start = useCallback(() => {
    const next = [Math.floor(Math.random() * TONES.length)];
    setSequence(next);
    void playSequence(next);
  }, [playSequence]);

  const chooseTone = useCallback((tone: number) => {
    if (phase !== 'input') return;
    setActiveTone(tone);
    window.setTimeout(() => setActiveTone(null), 140);

    if (sequence[inputIndex] !== tone) {
      setPhase('gameover');
      return;
    }

    const nextIndex = inputIndex + 1;
    if (nextIndex < sequence.length) {
      setInputIndex(nextIndex);
      return;
    }

    const completedRound = sequence.length;
    if (completedRound > best) {
      setBest(completedRound);
      window.localStorage.setItem('unihub:echo-grid:best', String(completedRound));
    }
    const next = [...sequence, Math.floor(Math.random() * TONES.length)];
    setSequence(next);
    window.setTimeout(() => void playSequence(next), 500);
  }, [best, inputIndex, phase, playSequence, sequence]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const index = TONES.findIndex((tone) => tone.key === event.key);
      if (index >= 0) chooseTone(index);
      if (event.key === 'Enter' && (phase === 'idle' || phase === 'gameover')) start();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chooseTone, phase, start]);

  useEffect(() => () => { playbackIdRef.current += 1; }, []);

  const round = phase === 'idle' ? 0 : Math.max(1, sequence.length);

  return (
    <Card className="overflow-hidden border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-background to-rose-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-lg">
          <span className="flex items-center gap-2"><BrainCircuit className="h-5 w-5 text-violet-500" />Echo Grid</span>
          <Badge variant="secondary">100% local</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">Watch the color pulse, then repeat the growing sequence. Use touch, mouse, or keys 1–4.</p>
        <div className="mx-auto grid w-full max-w-md grid-cols-2 gap-3 rounded-2xl border bg-slate-950 p-4 shadow-inner sm:gap-4 sm:p-6">
          {TONES.map((tone, index) => (
            <button
              key={tone.label}
              type="button"
              disabled={phase !== 'input'}
              onClick={() => chooseTone(index)}
              className={`relative aspect-[4/3] touch-manipulation rounded-xl opacity-65 transition duration-100 ${tone.color} ${activeTone === index ? `scale-[1.03] opacity-100 ring-4 ${tone.active}` : ''} disabled:cursor-default`}
              aria-label={`${tone.label}, key ${tone.key}`}
            >
              <span className="absolute bottom-2 right-2 rounded bg-black/25 px-2 py-0.5 text-xs font-bold text-white/90">{tone.key}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg border bg-background/70 p-2"><p className="text-xs text-muted-foreground">Round</p><p className="font-semibold tabular-nums">{round}</p></div>
          <div className="rounded-lg border bg-background/70 p-2"><p className="text-xs text-muted-foreground">Best</p><p className="font-semibold tabular-nums">{best}</p></div>
          <div className="rounded-lg border bg-background/70 p-2"><p className="text-xs text-muted-foreground">Status</p><p className="truncate font-semibold capitalize">{phase === 'input' ? 'Your turn' : phase}</p></div>
        </div>
        {phase === 'gameover' && <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-center text-sm">Signal lost at round {round}. Your best stays saved on this device.</p>}
        {(phase === 'idle' || phase === 'gameover') && (
          <Button className="h-11 w-full" onClick={start}>{phase === 'idle' ? <Play className="mr-2 h-4 w-4" /> : <RotateCcw className="mr-2 h-4 w-4" />}{phase === 'idle' ? 'Start sequence' : 'Try again'}</Button>
        )}
      </CardContent>
    </Card>
  );
};

export default EchoSequenceGame;
