import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

declare global { interface Window { __unihubUpdateAvailable?: boolean } }

export default function UpdatePrompt() {
  const [available, setAvailable] = useState(!!window.__unihubUpdateAvailable);
  const [updating, setUpdating] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ready = () => setAvailable(true);
    const failure = () => { setUpdating(false); setFailed(true); };
    window.addEventListener('unihub-update-available', ready);
    window.addEventListener('unihub-update-failed', failure);
    return () => {
      window.removeEventListener('unihub-update-available', ready);
      window.removeEventListener('unihub-update-failed', failure);
    };
  }, []);

  if (!available) return null;
  return (
    <aside role="status" className="fixed bottom-24 right-4 z-50 max-w-sm space-y-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg sm:bottom-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">UniHub update ready</h2>
        <Button type="button" variant="ghost" size="icon" aria-label="Dismiss update notice" onClick={() => setAvailable(false)}><X className="h-4 w-4" /></Button>
      </div>
      <p className="text-sm text-muted-foreground">Save your edits and finish any uploads before refreshing this tab. Your other open tabs can keep working until you refresh them.</p>
      {failed && <p role="alert" className="text-sm text-destructive">The update could not be applied. Check your connection and try again.</p>}
      <Button type="button" disabled={updating} onClick={() => {
        setUpdating(true);
        setFailed(false);
        window.dispatchEvent(new Event('unihub-apply-update'));
      }}><RefreshCw className="mr-2 h-4 w-4" />{updating ? 'Updating…' : 'Saved — refresh now'}</Button>
    </aside>
  );
}
