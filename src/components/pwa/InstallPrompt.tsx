import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type InstallOutcome = 'accepted' | 'dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: InstallOutcome;
    platform: string;
  }>;
}

const DISMISSED_AT_KEY = 'unihub:pwa-install-dismissed-at';
const INSTALLED_AT_KEY = 'unihub:pwa-installed-at';
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isRecentlyDismissed() {
  const dismissedAt = Number(window.localStorage.getItem(DISMISSED_AT_KEY) || '0');
  return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < DISMISS_DURATION_MS;
}

const InstallPrompt = () => {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || isStandaloneDisplay()) {
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      const promptEvent = event as BeforeInstallPromptEvent;
      setInstallPrompt(promptEvent);
      setVisible(!isRecentlyDismissed());
    };

    const handleAppInstalled = () => {
      window.localStorage.setItem(INSTALLED_AT_KEY, String(Date.now()));
      window.localStorage.removeItem(DISMISSED_AT_KEY);
      setInstallPrompt(null);
      setVisible(false);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;

    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'dismissed') {
        window.localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
      }
    } finally {
      setInstallPrompt(null);
      setVisible(false);
    }
  };

  const handleDismiss = () => {
    window.localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
    setVisible(false);
  };

  if (!installPrompt || !visible) return null;

  return (
    <div className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] left-4 right-4 z-50 md:bottom-5 md:left-auto md:right-5 md:w-[360px]">
      <div className="rounded-lg border border-border bg-card p-3 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <Download className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-card-foreground">Install UniHub</p>
            <p className="mt-1 text-xs text-muted-foreground">Add it to this device for quicker access.</p>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={handleInstall}>
                <Download className="h-4 w-4" />
                Install
              </Button>
              <Button size="sm" variant="ghost" onClick={handleDismiss}>
                Not now
              </Button>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={handleDismiss}
            aria-label="Dismiss install prompt"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default InstallPrompt;
