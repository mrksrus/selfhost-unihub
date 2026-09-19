import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

interface Props {
  mode: 'download' | 'sync';
  deleteOnServer: boolean;
  saveDownloadFirst?: boolean;
  requiresConfirmation: boolean;
  confirmed: boolean;
  onModeChange: (mode: 'download' | 'sync') => void;
  onDeleteChange: (enabled: boolean) => void;
  onConfirmChange: (confirmed: boolean) => void;
}

export function MailAccountModeSettings(props: Props) {
  return <fieldset className="space-y-3 rounded-md border border-border p-3">
    <legend className="px-1 text-sm font-medium">Mail account mode</legend>
    <Label htmlFor="mail-sync-mode">How UniHub handles this account</Label>
    <select id="mail-sync-mode" className="w-full rounded-md border border-input bg-background p-2 text-sm" value={props.mode}
      onChange={event => props.onModeChange(event.target.value as Props['mode'])}>
      <option value="download">Download and keep locally</option>
      <option value="sync">Sync from email server</option>
    </select>
    {props.mode === 'sync' ? <div className="space-y-3 text-sm text-muted-foreground">
      <p>UniHub follows the server's read status, stars and folders. Emails no longer on the server stay here as local copies. Automatic server deletion is off.</p>
      <p>Changes made in UniHub stay local and may be replaced on the next sync. Labels that the provider does not expose as folders or flags are not synced.</p>
      {props.requiresConfirmation && <label className="flex items-start gap-2 text-foreground">
        <input type="checkbox" className="mt-1" required checked={props.confirmed} onChange={event => props.onConfirmChange(event.target.checked)} />
        I understand that existing read status and filing will follow the server, while missing emails will be kept.
      </label>}
    </div> : props.saveDownloadFirst ? <p className="text-sm text-muted-foreground">Save Download mode first. Server deletion stays off; you can enable it afterward in these settings.</p> : <label className="flex items-start gap-3 text-sm">
      <Checkbox checked={props.deleteOnServer} onCheckedChange={checked => props.onDeleteChange(checked === true)} />
      <span><span className="font-medium">Delete emails on server after download</span>
        <span className="block text-muted-foreground">Off by default. When enabled, UniHub waits 10 minutes before deleting imported server copies. Switching modes turns this off.</span>
      </span>
    </label>}
  </fieldset>;
}
