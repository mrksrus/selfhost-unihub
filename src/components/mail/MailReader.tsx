import type { MouseEvent, ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ArrowLeft, CheckCircle2, Download, Forward, Loader2, Mail, Paperclip, Reply, Star, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import type { Email, MailAccount, MailFlagKind } from '@/lib/mail-api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { SafeEmailContent } from '@/components/mail/SafeEmailContent';
import { deriveContactNameFromEmail, flagPendingLabel } from '@/components/mail/mail-page-model';

interface Props {
  /** The loaded message. The reader hook only sets it for the current selection. */
  email: Email;
  accounts: MailAccount[];
  /** "Account / folder" shown next to the back button. */
  location: string;
  backLabel: string;
  isMobile: boolean;
  isReplying: boolean;
  flagRequests: Set<string>;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
  senderInContacts: boolean;
  onBack: () => void;
  onReply: () => void;
  onForward: () => void;
  /** Desktop inline reply editor, shown below the message. */
  inlineCompose: ReactNode;
}

/** Reader pane: full screen on narrow screens, the right column of the split view on wide ones. */
export function MailReader({ email, accounts, location, backLabel, isMobile, isReplying, flagRequests, requestFlag,
  senderInContacts, onBack, onReply, onForward, inlineCompose }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createContactFromEmail = useMutation({
    mutationFn: async (email: Email) => {
      const derivedName = deriveContactNameFromEmail(email);
      const response = await api.post('/contacts', {
        ...derivedName,
        email: email.from_address,
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast({ title: 'Contact added' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to add contact', description: error.message, variant: 'destructive' });
    },
  });

  return (
    <div className="fixed inset-0 z-50 bg-background xl:relative xl:inset-auto xl:z-auto xl:h-full xl:w-[45%] xl:shrink-0 xl:border-l xl:border-border">
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="shrink-0 border-b border-border p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-2 sm:gap-4">
            <Button
              variant="ghost"
              size="icon"
              aria-label={backLabel}
              title={backLabel}
              onClick={onBack}
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="text-xs text-muted-foreground truncate max-w-64">{location}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onReply}
              >
                <Reply className="h-4 w-4 mr-2" />
                Reply
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onForward}
              >
                <Forward className="h-4 w-4 mr-2" />
                Forward
              </Button>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 ml-auto">
            {accounts.find(account => account.id === email.mail_account_id)?.disconnected_at && <span className="text-xs text-muted-foreground">Disconnected · retained locally; provider presence unverified</span>}
            {email.remote_missing && <span className="text-xs text-muted-foreground">Local copy · provider presence unverified</span>}
            {(email.read_sync_pending || email.star_sync_pending) && <span className="text-xs text-muted-foreground">
              {flagPendingLabel(email)}
            </span>}
            {(flagRequests.has(`read:${email.id}`) || flagRequests.has(`star:${email.id}`)) && <span className="text-xs text-muted-foreground">Saving change…</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={() => requestFlag(email, 'read', !email.is_read)}
            >
              {email.is_read ? (
                <>
                  <Mail className="h-4 w-4 mr-2" />
                  Mark unread
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark read
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={email.is_starred ? 'Unstar message' : 'Star message'}
              onClick={() => requestFlag(email, 'star', !email.is_starred)}
            >
              <Star className={`h-5 w-5 ${email.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
            </Button>
          </div>
        </div>

        {/* Email Content */}
        <div className={`flex-1 overflow-auto p-6 ${!isMobile && isReplying ? 'pb-0' : ''}`}>
          <div className="max-w-4xl mx-auto space-y-4">
            <div>
              <h1 className="text-2xl font-bold mb-4">{email.subject || '(No subject)'}</h1>
              {email.remote_missing && <p className="mb-4 rounded-md border border-border p-3 text-sm text-muted-foreground">Local copy: this email was not found on the server during the last complete sync. Its content and attachments are kept here.</p>}
              <div className="space-y-2 text-sm text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all">
                    <span className="font-medium text-foreground">From:</span> {email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}
                  </span>
                  {!senderInContacts && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5"
                      onClick={() => createContactFromEmail.mutate(email)}
                      disabled={createContactFromEmail.isPending}
                    >
                      {createContactFromEmail.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <UserPlus className="h-3.5 w-3.5" />
                      )}
                      Add contact
                    </Button>
                  )}
                </div>
                <div>
                  <span className="font-medium text-foreground">To:</span> {email.to_addresses?.join(', ') || 'N/A'}
                </div>
                <div>
                  <span className="font-medium text-foreground">Date:</span> {format(new Date(email.received_at), 'PPpp')}
                </div>
              </div>
            </div>

            {/* Attachments */}
            {email.attachments && email.attachments.length > 0 && (
              <div className="border-t border-border pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    Attachments ({email.attachments.length})
                  </span>
                </div>
                <div className="space-y-2">
                  {email.attachments.map((attachment) => {
                    const sizeKB = attachment.size_bytes ? (attachment.size_bytes / 1024).toFixed(1) : '?';
                    const handleDownload = async (e: MouseEvent) => {
                      e.preventDefault();
                      try {
                        const { blob, filename } = await api.getBlob(`/mail/attachments/${attachment.id}`);
                        const blobUrl = window.URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = blobUrl;
                        link.download = filename || attachment.filename || 'attachment';
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        window.URL.revokeObjectURL(blobUrl);
                      } catch (error) {
                        console.error('Download failed:', error);
                        const errorWithStatus = error as Error & { status?: number };
                        let description = 'Could not download attachment. Please try again.';

                        if (errorWithStatus.status === 401) {
                          description = 'Session expired. Please sign in again and retry.';
                        } else if (errorWithStatus.status === 404) {
                          description = 'Attachment not found (it may not be available on disk).';
                        } else if (errorWithStatus.status && errorWithStatus.status >= 500) {
                          description = 'Server error while downloading attachment.';
                        } else if (errorWithStatus.message) {
                          description = errorWithStatus.message;
                        }

                        toast({ 
                          title: 'Download failed', 
                          description,
                          variant: 'destructive' 
                        });
                      }
                    };

                    return (
                      <button
                        key={attachment.id}
                        onClick={handleDownload}
                        className="w-full flex items-center gap-3 p-3 border border-border rounded-lg hover:bg-muted/50 transition-colors group text-left"
                      >
                        <Paperclip className="h-5 w-5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {attachment.filename}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {attachment.content_type} • {sizeKB} KB
                          </p>
                        </div>
                        <Download className="h-4 w-4 text-muted-foreground group-hover:text-accent transition-colors shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t border-border pt-4">
              <SafeEmailContent
                emailId={email.id}
                bodyHtml={email.body_html}
                bodyText={email.body_text}
              />
            </div>
          </div>
        </div>

        {inlineCompose}
      </div>
    </div>
  );
}
