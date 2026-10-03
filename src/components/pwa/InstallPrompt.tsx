import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DECLINED_KEY, INSTALLED_AT_KEY, installPromptAllowed, remindLater, write } from '@/lib/install-prompt';

type InstallOutcome = 'accepted' | 'dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: InstallOutcome;
    platform: string;
  }>;
}

function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
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
      if (!installPromptAllowed()) return;
      // Ignoring the prompt also waits a day before showing it again.
      remindLater();
      setVisible(true);
    };

    const handleAppInstalled = () => {
      write(INSTALLED_AT_KEY, String(Date.now()));
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
      if (choice.outcome === 'dismissed') remindLater();
    } finally {
      setInstallPrompt(null);
      setVisible(false);
    }
  };

  const handleLater = () => {
    remindLater();
    setVisible(false);
  };

  const handleNo = () => {
    write(DECLINED_KEY, 'true');
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
              <Button size="sm" variant="outline" onClick={handleLater}>
                Later
              </Button>
              <Button size="sm" variant="ghost" onClick={handleNo}>
                No
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InstallPrompt;
