import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Gamepad2 } from 'lucide-react';

type Phase = 'inhale' | 'hold' | 'exhale';

const DEFAULT_CYCLE_SECONDS = 16;
const CONTROLLER_DEADZONE = 0.45;

export const FocusBreathingGame = () => {
  const [phase, setPhase] = useState<Phase>('inhale');
  const [cycleSeconds, setCycleSeconds] = useState(DEFAULT_CYCLE_SECONDS);
  const [isRunning, setIsRunning] = useState(false);
  const [completedCycles, setCompletedCycles] = useState(0);
  const [phaseElapsedMs, setPhaseElapsedMs] = useState(0);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const prevActionRef = useRef(false);
  const tickStartedAtRef = useRef<number | null>(null);

  // Scale classic 4–4–8 timing (inhale-hold-exhale) to the selected cycle length
  const { inhaleSeconds, holdSeconds, exhaleSeconds } = useMemo(() => {
    const baseTotal = 16; // 4 + 4 + 8
    const factor = cycleSeconds / baseTotal;
    const inhale = Math.max(2, Math.round(4 * factor));
    const hold = Math.max(2, Math.round(4 * factor));
    let exhale = cycleSeconds - inhale - hold;
    if (exhale < 4) {
      exhale = 4;
    }
    return { inhaleSeconds: inhale, holdSeconds: hold, exhaleSeconds: exhale };
  }, [cycleSeconds]);

  const phaseSeconds = phase === 'inhale' ? inhaleSeconds : phase === 'hold' ? holdSeconds : exhaleSeconds;
  const phaseDurationMs = phaseSeconds * 1000;

  useEffect(() => {
    if (!isRunning) {
      tickStartedAtRef.current = null;
      return;
    }

    let frame = 0;
    const animate = (now: number) => {
      if (tickStartedAtRef.current === null) {
        tickStartedAtRef.current = now;
      }

      const elapsed = now - tickStartedAtRef.current;
      if (elapsed >= phaseDurationMs) {
        tickStartedAtRef.current = now;
        setPhaseElapsedMs(0);
        setPhase((current) => {
          if (current === 'inhale') return 'hold';
          if (current === 'hold') return 'exhale';
          setCompletedCycles((c) => c + 1);
          return 'inhale';
        });
      } else {
        setPhaseElapsedMs(elapsed);
      }

      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [isRunning, phaseDurationMs]);

  const handleStartStop = useCallback(() => {
    setIsRunning((running) => !running);
  }, []);

  const handleReset = useCallback(() => {
    setIsRunning(false);
    setPhase('inhale');
    setPhaseElapsedMs(0);
    setCompletedCycles(0);
    tickStartedAtRef.current = null;
  }, []);

  // Keep timer alignment when cycle length changes while paused.
  useEffect(() => {
    if (!isRunning) {
      setPhaseElapsedMs(0);
      if (phase !== 'inhale') setPhase('inhale');
    }
  }, [cycleSeconds, isRunning, phase]);

  useEffect(() => {
    const onConnectChange = () => {
      setGamepadConnected(navigator.getGamepads?.().some((gamepad) => gamepad !== null) ?? false);
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
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault();
        handleStartStop();
      }
      if (event.code === 'KeyR') {
        event.preventDefault();
        handleReset();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleReset, handleStartStop]);

  useEffect(() => {
    let frame = 0;
    const pollGamepads = () => {
      const gamepads = navigator.getGamepads?.();
      let actionPressed = false;

      if (gamepads) {
        for (let i = 0; i < gamepads.length; i += 1) {
          const gp = gamepads[i];
          if (!gp) continue;
          const startButton = gp.buttons[0]?.pressed || gp.buttons[9]?.pressed || gp.buttons[7]?.pressed;
          const dpadUp = gp.buttons[12]?.pressed || gp.axes[1] < -CONTROLLER_DEADZONE;
          actionPressed = actionPressed || Boolean(startButton || dpadUp);
        }
      }

      if (actionPressed && !prevActionRef.current) {
        handleStartStop();
      }
      prevActionRef.current = actionPressed;
      frame = requestAnimationFrame(pollGamepads);
    };

    frame = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(frame);
  }, [handleStartStop]);

  const progress = phaseDurationMs === 0 ? 0 : Math.min(100, (phaseElapsedMs / phaseDurationMs) * 100);
  const normalizedProgress = progress / 100;
  const secondsRemaining = Math.max(0, Math.ceil((phaseDurationMs - phaseElapsedMs) / 1000));

  const phaseLabel =
    phase === 'inhale' ? 'Inhale gently' : phase === 'hold' ? 'Hold' : 'Exhale slowly';

  const circleScale =
    phase === 'inhale'
      ? 0.72 + normalizedProgress * 0.55
      : phase === 'hold'
        ? 1.27
        : 1.27 - normalizedProgress * 0.6;

  return (
    <Card className="border bg-gradient-to-br from-sky-500/5 via-background to-violet-500/5">
      <CardHeader>
        <CardTitle className="text-lg flex items-center justify-between gap-2">
          <span>Focus Breathing</span>
          {gamepadConnected && (
            <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
              <Gamepad2 className="h-3.5 w-3.5" />
              Controller
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Follow the rhythm to complete a short box-breathing session and reset your focus.
        </p>

        <div className="flex flex-col items-center gap-4 py-2">
          <div className="relative flex items-center justify-center">
            <div className="h-32 w-32 rounded-full border border-border/60 flex items-center justify-center">
              <div
                className="h-24 w-24 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center will-change-transform"
                style={{ transform: `scale(${circleScale})`, transition: 'transform 80ms linear' }}
              >
                <span className="text-sm font-medium text-foreground">{phaseLabel}</span>
              </div>
            </div>
          </div>
          <div className="text-3xl font-semibold tabular-nums text-foreground">
            {String(secondsRemaining).padStart(2, '0')}s
          </div>
          <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <Button onClick={handleStartStop} className="flex-1">
            {isRunning ? 'Pause' : 'Start'}
          </Button>
          <Button variant="outline" onClick={handleReset}>
            Reset
          </Button>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
          <span>Completed cycles</span>
          <span className="font-medium text-foreground">{completedCycles}</span>
        </div>

        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Session length</span>
            <span className="font-medium text-foreground">
              {cycleSeconds} second{cycleSeconds !== 1 ? 's' : ''}
            </span>
          </div>
          <Slider
            value={[cycleSeconds]}
            min={8}
            max={40}
            step={4}
            onValueChange={([value]) => setCycleSeconds(value)}
          />
        </div>
      </CardContent>
    </Card>
  );
};

export default FocusBreathingGame;

