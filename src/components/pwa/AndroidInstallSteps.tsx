import { Download, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatSize, type AndroidDownload } from '@/lib/install-prompt';
import { openInAndroidAppHref } from '@/lib/platform';

/** Download the Android app from this server and connect it, in three short steps. */
export function AndroidInstallSteps({ download, onDownload }: { download: AndroidDownload; onDownload?: () => void }) {
  return (
    <div>
      <ol className="list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
        <li>Download and open the file.</li>
        <li>If asked, allow your browser to install apps.</li>
        <li>Come back and tap <span className="font-medium text-foreground">Open in app</span>.</li>
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" asChild>
          <a href={download.url} download="unihub.apk" onClick={onDownload}>
            <Download className="h-4 w-4" />
            Download · {formatSize(download.size)}
          </a>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={openInAndroidAppHref(download.url)}>
            <ExternalLink className="h-4 w-4" />
            Open in app
          </a>
        </Button>
      </div>
    </div>
  );
}
