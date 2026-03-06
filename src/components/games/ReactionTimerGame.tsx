import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Gamepad2 } from 'lucide-react';

type Phase = 'idle' | 'waiting' | 'ready' | 'result';

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 4000;
const CONTROLLER_DEADZONE = 0.45;

export const ReactionTimerGame = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('When you are ready, start the round and tap as soon as the screen turns green.');
  const [startTime, setStartTime] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [bestTime, setBestTime] = useState<number | null>(null);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const prevActionRef = useRef(false);

  const resetTimeout = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      resetTimeout();
    };
  }, []);

  const startRound = useCallback(() => {
    resetTimeout();
    setPhase('waiting');
    setMessage('Wait for green...');
    setStartTime(null);
    setCurrentTime(null);

    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    timeoutRef.current = window.setTimeout(() => {
      setPhase('ready');
      setMessage('Tap now!');
      setStartTime(performance.now());
    }, delay);
  }, []);

  const handleTap = useCallback(() => {
    if (phase === 'waiting') {
      resetTimeout();
      setPhase('result');
      setMessage('Too soon! Try again when the screen turns green.');
      setStartTime(null);
      setCurrentTime(null);
      return;
    }

    if (phase === 'ready' && startTime !== null) {
      const now = performance.now();
      const reaction = now - startTime;
      setCurrentTime(reaction);
      setPhase('result');
      setMessage('Nice! Try to beat your best time.');
      setBestTime((prev) => {
        if (prev === null) return reaction;
        return reaction < prev ? reaction : prev;
      });
      return;
    }

    if (phase === 'result' || phase === 'idle') {
      startRound();
    }
  }, [phase, startRound, startTime]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault();
        handleTap();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleTap]);

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
    let frame = 0;

    const pollGamepads = () => {
      const gamepads = navigator.getGamepads?.();
      let actionPressed = false;

      if (gamepads) {
        for (let i = 0; i < gamepads.length; i += 1) {
          const gp = gamepads[i];
          if (!gp) continue;
          const buttonTap =
            gp.buttons[0]?.pressed ||
            gp.buttons[9]?.pressed ||
            gp.buttons[7]?.pressed ||
            gp.buttons[12]?.pressed ||
            gp.axes[1] < -CONTROLLER_DEADZONE;
          actionPressed = actionPressed || Boolean(buttonTap);
        }
      }

      if (actionPressed && !prevActionRef.current) {
        handleTap();
      }
      prevActionRef.current = actionPressed;
      frame = requestAnimationFrame(pollGamepads);
    };

    frame = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(frame);
  }, [handleTap]);

  const getBackgroundClass = () => {
    if (phase === 'ready') return 'bg-emerald-500/10 border-emerald-500/40';
    if (phase === 'waiting') return 'bg-amber-500/5 border-amber-500/30';
    if (phase === 'result' && currentTime !== null) return 'bg-accent/5 border-accent/40';
    return 'bg-card';
  };

  const formatMs = (value: number | null) => {
    if (value === null) return '—';
    return `${Math.round(value)} ms`;
  };

  return (
    <Card className={`border transition-colors duration-200 ${getBackgroundClass()}`}>
      <CardHeader>
        <CardTitle className="text-lg flex items-center justify-between gap-2">
          <span>Reaction Timer</span>
          {gamepadConnected && (
            <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
              <Gamepad2 className="h-3.5 w-3.5" />
              Controller
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button
          size="lg"
          className="w-full h-20 text-lg font-semibold"
          variant={phase === 'ready' ? 'default' : 'outline'}
          onClick={handleTap}
        >
          {phase === 'idle' && 'Start'}
          {phase === 'waiting' && 'Waiting...'}
          {phase === 'ready' && 'Tap!'}
          {phase === 'result' && 'Play Again'}
        </Button>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Last time</div>
            <div className="font-medium text-foreground mt-1">{formatMs(currentTime)}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Best this session</div>
            <div className="font-medium text-foreground mt-1">{formatMs(bestTime)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default ReactionTimerGame;

