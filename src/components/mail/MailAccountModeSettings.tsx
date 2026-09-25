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
      <option value="sync">Sync with email server</option>
    </select>
    {props.mode === 'sync' ? <div className="space-y-3 text-sm text-muted-foreground">
      <p>UniHub syncs read status, stars and moves to connected server folders in both directions. Only new actions in UniHub are sent to the server. If changes conflict, the server version wins.</p>
      <p>Emails no longer on the server stay here as local copies. Changes to local copies and Legacy mail stay local. Automatic server deletion is off. Moving mail to a connected Trash folder is allowed; permanent deletion in Sync mode is blocked.</p>
      <p>Draft editing and folder creation, renaming or deletion are not part of two-way sync. Labels that the provider does not expose as folders or flags are not synced.</p>
      {props.requiresConfirmation && <label className="flex items-start gap-2 text-foreground">
        <input type="checkbox" className="mt-1" required checked={props.confirmed} onChange={event => props.onConfirmChange(event.target.checked)} />
        I understand that existing read status and filing will follow the server, while missing emails will be kept.
      </label>}
    </div> : props.saveDownloadFirst ? <p className="text-sm text-muted-foreground">Save Download mode first. Server deletion stays off; you can enable it afterward in these settings.</p> : <label className="flex items-start gap-3 text-sm">
      <Checkbox checked={props.deleteOnServer} onCheckedChange={checked => props.onDeleteChange(checked === true)} />
      <span><span className="font-medium">Delete emails on server after download</span>
        <span className="block text-muted-foreground">Off by default. When enabled, UniHub waits 10 minutes before deleting imported server copies. Switching modes turns this off.</span>
        <span className="mt-1 block text-muted-foreground">UniHub backup, import and restore are ALPHA. Keep an independent backup before deleting server copies; the local copy may become your only remaining email.</span>
      </span>
    </label>}
  </fieldset>;
}
