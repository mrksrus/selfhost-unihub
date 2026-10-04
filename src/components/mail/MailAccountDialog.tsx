import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MailAccountModeSettings } from '@/components/mail/MailAccountModeSettings';
import { MailModeImpactPanel } from '@/components/mail/MailModeImpactPanel';
import { MailAccountSyncWarnings, MailSyncPolicyNotice } from '@/components/mail/MailSyncPolicyGate';
import { needsSyncPolicyDecision } from '@/lib/mail-api';
import { MailCalendarAddOption, MailCalendarSettings } from '@/components/mail/MailCalendarSettings';
import { mailProviders, type MailHostAssessment, type MailHostCertificate } from '@/components/mail/mail-page-model';
import type { MailAccountEditor } from '@/hooks/use-mail-account-editor';

const formatCertificateName = (value?: Record<string, string> | null) => {
  if (!value) return 'Unknown';
  return value.CN || Object.entries(value).map(([key, item]) => `${key}=${item}`).join(', ') || 'Unknown';
};

const renderTrustSection = (label: 'IMAP' | 'SMTP', assessment?: MailHostAssessment, certificate?: MailHostCertificate) => (
  <div className="rounded-md border border-border p-3 space-y-2">
    <div className="flex items-center justify-between gap-3">
      <p className="font-medium">{label} server</p>
      <span className={certificate?.authorized ? 'text-success text-xs' : 'text-warning text-xs'}>
        {certificate?.authorized ? 'Verified certificate' : 'Needs review'}
      </span>
    </div>
    <p className="text-sm text-muted-foreground break-all">
      {assessment?.host || 'Unknown host'}:{assessment?.port || 'unknown'}
    </p>
    <p className="text-xs text-muted-foreground">
      Provider: {assessment?.knownProvider ? 'known provider' : assessment?.allowlisted ? 'hoster allowlisted' : 'unknown/custom'}
    </p>
    {assessment?.resolvedAddresses && assessment.resolvedAddresses.length > 0 && (
      <p className="text-xs text-muted-foreground break-all">
        IPs: {assessment.resolvedAddresses.join(', ')}
      </p>
    )}
    <div className="text-xs text-muted-foreground space-y-1">
      <p>Certificate owner: {formatCertificateName(certificate?.subject)}</p>
      <p>Certificate issuer: {formatCertificateName(certificate?.issuer)}</p>
      {certificate?.valid_to && <p>Valid until: {certificate.valid_to}</p>}
      {certificate?.fingerprint256 && <p className="break-all">SHA-256 fingerprint: {certificate.fingerprint256}</p>}
      {(certificate?.authorizationError || certificate?.error) && (
        <p className="text-warning">Verification message: {certificate.authorizationError || certificate.error}</p>
      )}
    </div>
  </div>
);

function HostTrustConfirmation({ editor }: { editor: MailAccountEditor }) {
  if (!editor.pendingHostTrust) return null;
  return (
    <div className="space-y-4 mt-4">
      {editor.pendingHostTrust.trust.warnings.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="font-medium text-warning mb-2">Warnings</p>
          <ul className="list-disc pl-5 space-y-1">
            {editor.pendingHostTrust.trust.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {editor.pendingHostTrust.trust.certificates.imap && renderTrustSection('IMAP', editor.pendingHostTrust.trust.assessments.imap, editor.pendingHostTrust.trust.certificates.imap)}
      {editor.pendingHostTrust.trust.certificates.smtp && renderTrustSection('SMTP', editor.pendingHostTrust.trust.assessments.smtp, editor.pendingHostTrust.trust.certificates.smtp)}
      {editor.pendingHostTrust.trust.requiresInsecureTls && (
        <p className="text-sm text-muted-foreground">
          If you continue, this account will allow insecure TLS for this mail server. This is useful for self-hosted mail, but unsafe if you do not recognize the server.
        </p>
      )}
      <div className="flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={() => editor.denyHostTrust()}>
          Deny
        </Button>
        <Button type="button" onClick={editor.confirmHostTrust} disabled={editor.isSaving}>
          {editor.isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Continue and Trust Server
        </Button>
      </div>
    </div>
  );
}

/** Add/edit mail account dialog. `trigger` is the sidebar button that opens it for a new account. */
export function MailAccountDialog({ editor, trigger, touch = false }: { editor: MailAccountEditor; trigger: ReactNode; touch?: boolean }) {
  return (
    <Dialog open={editor.isOpen} onOpenChange={editor.onOpenChange}>
      <DialogTrigger asChild>
        {trigger}
      </DialogTrigger>
      <DialogContent className={editor.pendingHostTrust
        ? 'w-[calc(100vw-1rem)] max-w-2xl max-h-[calc(100dvh-1rem)] overflow-y-auto p-4 sm:max-h-[85vh] sm:p-6'
        : 'w-[calc(100vw-1rem)] max-w-lg max-h-[calc(100dvh-1rem)] overflow-y-auto p-4 sm:max-h-[85vh] sm:p-6'}>
        <DialogHeader>
          <DialogTitle>
            {editor.pendingHostTrust ? 'Confirm Mail Server Authenticity' : editor.editingAccount ? 'Edit Mail Account' : 'Add Mail Account'}
          </DialogTitle>
          <DialogDescription>
            {editor.pendingHostTrust
              ? 'Review the server and certificate details below. Continue only if you trust this mail server.'
              : 'Connect an email account to view and manage your mail.'}
          </DialogDescription>
        </DialogHeader>
        {!editor.pendingHostTrust && editor.editingAccount && needsSyncPolicyDecision(editor.editingAccount) && (
          <MailSyncPolicyNotice account={editor.editingAccount} touch={touch} />
        )}
        {!editor.pendingHostTrust && editor.editingAccount && <MailAccountSyncWarnings account={editor.editingAccount}
          className="rounded-md border border-warning/40 bg-warning/5 p-2.5" />}
        {editor.pendingHostTrust ? (
          <HostTrustConfirmation editor={editor} />
        ) : (
          <form onSubmit={editor.submit} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="provider">Email Provider</Label>
              <Select
                value={editor.accountForm.provider}
                onValueChange={editor.changeProvider}
              >
                <SelectTrigger id="provider">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {mailProviders.map((provider) => (
                    <SelectItem key={provider.value} value={provider.value}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email_address">Email Address</Label>
              <Input
                id="email_address"
                type="email"
                value={editor.accountForm.email_address}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, email_address: e.target.value })}
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="display_name">Display Name</Label>
              <Input
                id="display_name"
                value={editor.accountForm.display_name}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, display_name: e.target.value })}
                placeholder="John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={editor.accountForm.username}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, username: e.target.value })}
                placeholder={editor.accountForm.provider === 'gmail' ? 'Usually your email' : 'IMAP/SMTP username'}
                required
              />
              {(editor.accountForm.provider === 'gmail' || editor.accountForm.provider === 'yahoo') && (
                <p className="text-xs text-muted-foreground">
                  {editor.accountForm.provider === 'gmail' ? 'Use an App Password (not your regular password). Generate one at myaccount.google.com/apppasswords' : 'You may need an App Password for Yahoo Mail'}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password {editor.editingAccount && (editor.editingAccount.disconnected_at || !editor.editingAccount.is_active ? '(required to reconnect; leaving blank keeps local mail disconnected)' : '(leave blank to keep current)')}</Label>
              <Input
                id="password"
                type="password"
                value={editor.accountForm.password}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, password: e.target.value })}
                placeholder="Password or App Password"
                required={!editor.editingAccount}
              />
            </div>
            {editor.editingAccount
              ? <MailCalendarSettings account={editor.editingAccount} />
              : <MailCalendarAddOption form={editor.accountForm} onChange={editor.setAccountForm} />}
            <p className="text-xs text-muted-foreground">
              Server details are filled from the provider; you can change any value.
            </p>
            <div className="space-y-2">
              <Label htmlFor="imap_host">IMAP Server</Label>
              <Input
                id="imap_host"
                value={editor.accountForm.imap_host}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, imap_host: e.target.value })}
                placeholder="e.g. imap.gmail.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="imap_port">IMAP Port</Label>
              <Input
                id="imap_port"
                type="number"
                value={editor.accountForm.imap_port}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, imap_port: parseInt(e.target.value) || 993 })}
                placeholder="993"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp_host">SMTP Server</Label>
              <Input
                id="smtp_host"
                value={editor.accountForm.smtp_host}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, smtp_host: e.target.value })}
                placeholder="e.g. smtp.gmail.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp_port">SMTP Port</Label>
              <Input
                id="smtp_port"
                type="number"
                value={editor.accountForm.smtp_port}
                onChange={(e) => editor.setAccountForm({ ...editor.accountForm, smtp_port: parseInt(e.target.value) || 587 })}
                placeholder="587"
              />
            </div>
            <MailAccountModeSettings
              mode={editor.accountForm.sync_mode}
              syncWindow={editor.accountForm.sync_window_days}
              trashWindow={editor.accountForm.trash_window_days}
              deleteOnServer={editor.accountForm.delete_emails_on_server}
              saveDownloadFirst={editor.editingAccount?.sync_mode === 'sync'}
              onModeChange={mode => editor.changeModeChoice({ sync_mode: mode, delete_emails_on_server: false })}
              onSyncWindowChange={days => editor.changeModeChoice({ sync_window_days: days })}
              onTrashWindowChange={days => editor.changeModeChoice({ trash_window_days: days })}
              onDeleteChange={enabled => editor.changeModeChoice({ delete_emails_on_server: enabled })}
            />
            {editor.editingAccount && <MailModeImpactPanel account={editor.editingAccount} review={editor.modeReview}
              typedAddress={editor.typedAddress} onTypedAddressChange={editor.setTypedAddress} saveError={editor.saveError} />}
            {editor.editingAccount && editor.modeReview.blocked && !editor.modeReview.loading && <p id="mail-account-save-hint" className="text-xs text-muted-foreground">
              Type the account address above to save.
            </p>}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => editor.close()}>
                Cancel
              </Button>
              <Button type="submit" disabled={editor.isSaving || Boolean(editor.editingAccount && editor.modeReview.blocked)}
                aria-describedby={editor.editingAccount && editor.modeReview.blocked && !editor.modeReview.loading ? 'mail-account-save-hint' : undefined}>
                {editor.isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {editor.editingAccount ? 'Save Changes' : 'Add Account'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
