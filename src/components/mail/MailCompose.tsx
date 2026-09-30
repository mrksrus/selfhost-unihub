import type { RefObject } from 'react';
import { format } from 'date-fns';
import {
  Bold, Image as ImageIcon, Italic, Link as LinkIcon, List, ListOrdered, Loader2, Palette, Paperclip, Send, Underline, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { MailAccount } from '@/lib/mail-api';
import type { MailCompose } from '@/hooks/use-mail-compose';
import { formatAttachmentSize, getActiveRecipientSearchTerm } from '@/components/mail/mail-page-model';

function RecipientInput({ compose, inputId }: { compose: MailCompose; inputId: string }) {
  const searchTerm = getActiveRecipientSearchTerm(compose.composeForm.to);
  const suggestions = compose.contactEmailSuggestions
    .filter((suggestion) => {
      const haystack = `${suggestion.name} ${suggestion.email}`.toLowerCase();
      return !searchTerm || haystack.includes(searchTerm);
    })
    .slice(0, 8);
  const showSuggestions = compose.focusedRecipientInput === inputId && suggestions.length > 0;

  return (
    <div className="relative">
      <Input
        id={inputId}
        type="text"
        placeholder="recipient@example.com"
        value={compose.composeForm.to}
        onChange={(e) => compose.updateComposeForm({ to: e.target.value })}
        onFocus={() => compose.setFocusedRecipientInput(inputId)}
        onBlur={() => window.setTimeout(() => compose.setFocusedRecipientInput((current) => current === inputId ? null : current), 100)}
        autoComplete="off"
        required
      />
      {showSuggestions && (
        <div className="absolute left-0 right-0 top-full z-[80] mt-1 max-h-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.key}
              type="button"
              className="flex w-full flex-col rounded-sm px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onMouseDown={(event) => {
                event.preventDefault();
                compose.replaceActiveRecipient(suggestion);
                compose.setFocusedRecipientInput(inputId);
              }}
            >
              <span className="font-medium truncate">{suggestion.name || suggestion.email}</span>
              {suggestion.name && (
                <span className="text-xs text-muted-foreground truncate">{suggestion.email}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RichComposeEditor({ compose, editorId, editorRef, editorClassName = '' }: {
  compose: MailCompose; editorId: string; editorRef: RefObject<HTMLDivElement>; editorClassName?: string;
}) {
  return (
    <div className={`rounded-md border border-input bg-background overflow-hidden ${editorClassName.includes('flex-1') ? 'flex flex-col min-h-0' : ''}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'bold')}>
          <Bold className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'italic')}>
          <Italic className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'underline')}>
          <Underline className="h-4 w-4" />
        </Button>
        <div className="h-5 w-px bg-border mx-1" />
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Bullet list" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'insertUnorderedList')}>
          <List className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'insertOrderedList')}>
          <ListOrdered className="h-4 w-4" />
        </Button>
        <div className="h-5 w-px bg-border mx-1" />
        <label className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" title="Text color">
          <Palette className="h-4 w-4" />
          <input
            type="color"
            className="sr-only"
            onChange={(event) => compose.applyComposeCommand(editorRef, 'foreColor', event.target.value)}
          />
        </label>
        <select
          aria-label="Text size"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) compose.applyComposeCommand(editorRef, 'fontSize', event.target.value);
            event.target.value = '';
          }}
        >
          <option value="" disabled>Size</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="6">Huge</option>
        </select>
        <div className="h-5 w-px bg-border mx-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Insert link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt('Link URL');
            if (url?.trim()) compose.applyComposeCommand(editorRef, 'createLink', url.trim());
          }}
        >
          <LinkIcon className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Insert image URL"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt('Image URL');
            if (url?.trim()) compose.applyComposeCommand(editorRef, 'insertImage', url.trim());
          }}
        >
          <ImageIcon className="h-4 w-4" />
        </Button>
      </div>
      <div
        id={editorId}
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write your message..."
        className={`p-3 text-sm outline-none overflow-y-auto overscroll-contain break-words [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-muted-foreground [&_a]:text-accent [&_a]:underline [&_img]:max-w-full [&_img]:rounded-md [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 ${editorClassName}`}
        onInput={() => compose.updateComposeBodyFromEditor(editorRef)}
        onBlur={() => compose.updateComposeBodyFromEditor(editorRef)}
      />
    </div>
  );
}

function ComposeAttachmentsSection({ compose, inputId }: { compose: MailCompose; inputId: string }) {
  return (
    <div className="space-y-2">
      <Label>Attachments</Label>
      <input
        id={inputId}
        type="file"
        multiple
        className="hidden"
        onChange={compose.handleComposeAttachmentInput}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          compose.setIsAttachmentDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          compose.setIsAttachmentDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          compose.setIsAttachmentDragOver(false);
          if (e.dataTransfer?.files?.length) {
            compose.addComposeFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-lg border border-dashed p-3 transition-colors ${
          compose.isAttachmentDragOver ? 'border-accent bg-accent/5' : 'border-border'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Drag and drop files here, or</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              const input = document.getElementById(inputId) as HTMLInputElement | null;
              input?.click();
            }}
          >
            <Paperclip className="h-4 w-4 mr-2" />
            Add attachments
          </Button>
        </div>
      </div>

      {(compose.existingDraftAttachments.length > 0 || compose.composeAttachments.length > 0) && (
        <div className="space-y-2">
          {compose.existingDraftAttachments.map((attachment) => (
            <div key={attachment.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{attachment.filename}</p>
                <p className="text-xs text-muted-foreground">{formatAttachmentSize(attachment.size_bytes)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => compose.removeExistingDraftAttachment(attachment.id)}
                title="Remove attachment"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {compose.composeAttachments.map(({ id, file }) => (
            <div key={id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatAttachmentSize(file.size)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => compose.removeComposeAttachment(id)}
                title="Remove attachment"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Desktop reply/forward editor below the open message. */
export function MailInlineCompose({ compose }: { compose: MailCompose }) {
  return (
    <div className="max-h-[52vh] shrink-0 border-t border-border bg-card">
      <div className="mx-auto flex h-full max-w-4xl flex-col p-4">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <h2 className="text-lg font-semibold">
            {compose.composeMode === 'reply' ? 'Reply' : compose.composeMode === 'forward' ? 'Forward' : 'Compose'}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              compose.closeComposeFlow();
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={compose.handleSendEmail} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid shrink-0 gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="compose-to-inline">To</Label>
              <RecipientInput compose={compose} inputId="compose-to-inline" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="compose-subject-inline">Subject</Label>
              <Input
                id="compose-subject-inline"
                placeholder="Enter subject"
                value={compose.composeForm.subject}
                onChange={(e) => compose.updateComposeForm({ subject: e.target.value })}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-3">
            <div className="space-y-2">
              <Label htmlFor="compose-body-inline">Message</Label>
              <RichComposeEditor compose={compose} editorId="compose-body-inline" editorRef={compose.inlineComposeEditorRef} editorClassName="h-[220px] min-h-[180px]" />
            </div>
            <ComposeAttachmentsSection compose={compose} inputId="compose-attachments-inline" />
          </div>
          <div className="flex shrink-0 justify-end gap-3 border-t border-border pt-3">
            <Button type="button" variant="secondary" onClick={() => compose.saveCurrentDraft({ includeAttachments: true })} disabled={compose.isDraftSaving || compose.isSending}>
              {compose.isDraftSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save draft
            </Button>
            <Button 
              type="button" 
              variant="outline" 
              onClick={() => {
                compose.closeComposeFlow();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={compose.isSending || compose.isDraftSaving}>
              {compose.isSending || compose.isDraftSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** New message dialog, and reply/forward on phones. */
export function MailComposeDialog({ compose, accounts, isMobile, onSelectAccount }: {
  compose: MailCompose; accounts: MailAccount[]; isMobile: boolean; onSelectAccount: (accountId: string) => void;
}) {
  return (
    <Dialog open={compose.isComposeOpen} onOpenChange={(open) => {
      if (open) compose.openCompose();
      else compose.closeComposeFlow();
    }}>
      <DialogContent className={`${isMobile ? 'max-w-full h-[calc(100dvh-5.5rem)] max-h-[calc(100dvh-5.5rem)] translate-y-[-50%] rounded-t-lg rounded-b-none' : 'sm:max-w-3xl max-h-[90dvh]'} !flex flex-col overflow-hidden p-0`}>
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-10">
          <DialogTitle>
            {compose.composeMode === 'reply' ? 'Reply' : compose.composeMode === 'forward' ? 'Forward' : 'New Message'}
          </DialogTitle>
          <DialogDescription className={compose.activeDraftId || compose.isDraftSaving || compose.draftSavedAt ? undefined : 'sr-only'}>
            {compose.isDraftSaving ? 'Saving draft...' : compose.draftSavedAt ? `Draft saved ${format(new Date(compose.draftSavedAt), 'HH:mm')}` : 'Compose email message'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={compose.handleSendEmail} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 space-y-4 px-4 py-3">
            <div className="space-y-2">
              <Label>From</Label>
              <Select
                value={compose.activeMailAccountId || ''}
                onValueChange={(value) => onSelectAccount(value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.email_address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="compose-to">To</Label>
              <RecipientInput compose={compose} inputId="compose-to" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="compose-subject">Subject</Label>
              <Input 
                id="compose-subject"
                placeholder="Enter subject"
                value={compose.composeForm.subject}
                onChange={(e) => compose.updateComposeForm({ subject: e.target.value })}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
            <div className="flex min-h-0 flex-col space-y-2">
              <Label htmlFor="compose-body">Message</Label>
              <RichComposeEditor
                compose={compose}
                editorId="compose-body"
                editorRef={compose.dialogComposeEditorRef}
                editorClassName={isMobile ? 'h-[36dvh] min-h-[180px]' : 'h-[min(44vh,420px)] min-h-[220px]'}
              />
            </div>
            <ComposeAttachmentsSection compose={compose} inputId="compose-attachments-dialog" />
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-border bg-background px-4 py-3">
            <Button type="button" variant="secondary" onClick={() => compose.saveCurrentDraft({ includeAttachments: true })} disabled={compose.isDraftSaving || compose.isSending}>
              {compose.isDraftSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save draft
            </Button>
            <Button type="button" variant="outline" onClick={() => {
              compose.closeComposeFlow();
            }}>
              Cancel
            </Button>
            <Button type="submit" disabled={compose.isSending || compose.isDraftSaving}>
              {compose.isSending || compose.isDraftSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Unsaved-changes prompt and draft deletion confirmation. */
export function MailComposeDialogs({ compose }: { compose: MailCompose }) {
  return <>
    <AlertDialog open={compose.composeClosePromptOpen} onOpenChange={compose.setComposeClosePromptOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save this draft?</AlertDialogTitle>
          <AlertDialogDescription>
            This message has unsaved changes. Save it as a draft, discard it, or keep editing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void compose.discardCurrentCompose();
            }}
          >
            Discard
          </AlertDialogAction>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              compose.saveAndClose();
            }}
          >
            {compose.isDraftSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!compose.draftToDelete} onOpenChange={(open) => !open && compose.setDraftToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete draft?</AlertDialogTitle>
          <AlertDialogDescription>
            This draft and its attachments will be removed from UniHub.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={compose.confirmDeleteDraft}
          >
            Delete draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
