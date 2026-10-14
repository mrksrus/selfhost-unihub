import { useEffect, useRef, useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AndroidInstallSteps } from '@/components/pwa/AndroidInstallSteps';
import {
  DECLINED_KEY, installPromptAllowed, installWebApp, isStandaloneDisplay, markInstalled, remindLater,
  useAndroidDownload, useWebInstallAvailable, write,
} from '@/lib/install-prompt';
import { androidApp } from '@/lib/platform';

/**
 * Offers to install UniHub: the web app where the browser supports it, and on
 * Android phones the Android app this server carries. Choosing the Android app
 * shows its download with three short steps.
 */
const InstallPrompt = () => {
  const webAvailable = useWebInstallAvailable();
  const android = useAndroidDownload();
  const [view, setView] = useState<'hidden' | 'offer' | 'android'>('hidden');
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || (!webAvailable && !android)) return;
    decided.current = true;
    if (androidApp() || isStandaloneDisplay() || !installPromptAllowed()) return;
    // Ignoring the card also waits a day before showing it again.
    remindLater();
    setView('offer');
  }, [webAvailable, android]);

  const close = () => setView('hidden');
  const handleWeb = () => {
    close();
    void installWebApp().catch(() => remindLater());
  };
  const handleLater = () => {
    remindLater();
    close();
  };
  const handleNo = () => {
    write(DECLINED_KEY, 'true');
    close();
  };

  if (view === 'hidden' || (view === 'offer' && !webAvailable && !android)) return null;

  return (
    <div className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] left-4 right-4 z-50 md:bottom-5 md:left-auto md:right-5 md:w-[360px]">
      <div className="rounded-lg border border-border bg-card p-3 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
            {view === 'android' ? <Smartphone className="h-4 w-4" /> : <Download className="h-4 w-4" />}
          </div>
          {view === 'android' && android ? (
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-card-foreground">Android app</p>
                <Button size="icon" variant="ghost" className="-mr-1 -mt-1 h-7 w-7" onClick={close} aria-label="Close">
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-1">
                <AndroidInstallSteps download={android} onDownload={() => markInstalled()} />
              </div>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-card-foreground">Install UniHub</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {android ? 'Use it like an app on this phone.' : 'Add it to this device for quicker access.'}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {android && (
                  <Button size="sm" onClick={() => setView('android')}>
                    <Smartphone className="h-4 w-4" />
                    Android app
                  </Button>
                )}
                {webAvailable && (
                  <Button size="sm" variant={android ? 'outline' : 'default'} onClick={handleWeb}>
                    <Download className="h-4 w-4" />
                    {android ? 'Web app' : 'Install'}
                  </Button>
                )}
                <Button size="sm" variant={android && webAvailable ? 'ghost' : 'outline'} onClick={handleLater}>
                  Later
                </Button>
                <Button size="sm" variant="ghost" onClick={handleNo}>
                  No
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default InstallPrompt;
