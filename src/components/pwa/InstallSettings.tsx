import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { AndroidInstallSteps } from '@/components/pwa/AndroidInstallSteps';
import {
  formatSize, installWebApp, markInstalled, remindLater, useAndroidAppUpdate, useServerVersion, useWebInstallAvailable,
} from '@/lib/install-prompt';
import { androidApp, canInstallAndroidApp, changeAppServer, downloadFromServer } from '@/lib/platform';

/** The apps for this server: the Android app and the web app, or, inside the app, its version and server. */
export default function InstallSettings() {
  const app = androidApp();
  if (app) return <AndroidAppSettings versionName={app.versionName} />;
  return <InstallOffers />;
}

function AndroidAppSettings({ versionName }: { versionName: string }) {
  const update = useAndroidAppUpdate();
  return (
    <SettingsSection title="App">
      <SettingsRow label="Android app" description={`Version ${versionName}, connected to ${window.location.host}.`}>
        {update && (
          <Button size="sm" onClick={() => downloadFromServer(update.url, 'unihub.apk')}>
            Update to {update.versionName}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={changeAppServer}>Change server</Button>
      </SettingsRow>
    </SettingsSection>
  );
}

function InstallOffers() {
  const download = useServerVersion().data?.android ?? null;
  const webAvailable = useWebInstallAvailable();
  const [steps, setSteps] = useState(false);
  const onPhone = canInstallAndroidApp();
  if (!download && !webAvailable) return null;

  return (
    <SettingsSection title="Install">
      {download && (
        <SettingsRow
          label="Android app"
          description={onPhone
            ? `Version ${download.versionName}, ${formatSize(download.size)}.`
            : 'For Android phones. Open UniHub in the phone’s browser to install it there.'}
        >
          {onPhone
            ? !steps && <Button size="sm" onClick={() => setSteps(true)}>Get the app</Button>
            : <Button size="sm" variant="outline" asChild><a href={download.url} download="unihub.apk">Download</a></Button>}
        </SettingsRow>
      )}
      {download && steps && (
        <SettingsBlock>
          <AndroidInstallSteps download={download} onDownload={() => markInstalled()} />
        </SettingsBlock>
      )}
      {webAvailable && (
        <SettingsRow label="Web app" description="Adds UniHub to this device like an app.">
          <Button size="sm" variant="outline" onClick={() => void installWebApp().catch(() => remindLater())}>Install</Button>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
