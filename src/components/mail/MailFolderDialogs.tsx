import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Edit, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { ACCOUNT_CHANGED, ApiError, hasCode } from '@/lib/api-error';
import { invalidateMailQueries, type MailAccount, type MailFolder } from '@/lib/mail-api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Folders are created on this real account; none in combined or Legacy views. */
  activeMailAccountId: string | null;
  /** The folders visible for the selected account view. */
  folders: MailFolder[];
  accounts: MailAccount[];
  selectedFolder: string;
  onSelectFolder: (slug: string) => void;
}

/** Folder management dialog. Provider folders are renamed at the provider; deleting one here deletes the server copy too. */
export function MailFolderDialogs({ open, onOpenChange, activeMailAccountId, folders, accounts, selectedFolder, onSelectFolder }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [folderToDelete, setFolderToDelete] = useState<MailFolder | null>(null);
  const [deleteOnServer, setDeleteOnServer] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingFolderSlug, setEditingFolderSlug] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');

  const createFolder = useMutation({
    mutationFn: async (displayName: string) => {
      const response = await api.post<{ folder: MailFolder; remoteFolder?: { status: string } }>('/mail/folders', { display_name: displayName, mail_account_id: activeMailAccountId });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (result) => {
      const folder = result?.folder;
      queryClient.invalidateQueries({ queryKey: ['mail-folders'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      if (folder?.slug) onSelectFolder(folder.slug);
      setNewFolderName('');
      toast({ title: 'Folder created for this account', description: result?.remoteFolder?.status === 'partial' ? 'Saved locally. The mail provider could not create the folder; provider sync is not established yet.' : undefined });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create folder', description: error.message, variant: 'destructive' });
    },
  });

  const updateFolder = useMutation({
    mutationFn: async ({ slug, displayName }: { slug: string; displayName: string }) => {
      const response = await api.put(`/mail/folders/${encodeURIComponent(slug)}`, { display_name: displayName });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-folders'] });
      setEditingFolderSlug(null);
      setEditingFolderName('');
      toast({ title: 'Folder updated' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update folder', description: error.message, variant: 'destructive' });
    },
  });

  /** The mail servers a folder is on, for a refusal's wording: "a@example.org, b@example.org" or "the mail server". */
  const serverAddresses = (slug: string) => {
    const folder = folders.find(entry => entry.slug === slug);
    const ids = folder ? [...new Set([folder.mail_account_id, ...(folder.connected_account_ids ?? [])].filter((id): id is string => !!id))] : [];
    const addresses = ids.map(id => accounts.find(account => account.id === id)?.email_address).filter((address): address is string => !!address);
    return addresses.length ? addresses.join(', ') : 'the mail server';
  };

  const deleteFolder = useMutation({
    mutationFn: async ({ slug, server }: { slug: string; server: boolean }) => {
      const response = await api.delete<{ deletedMessages: number; movedMessages: number }>(`/mail/folders/${encodeURIComponent(slug)}${server ? '?server=1' : ''}`);
      if (response.error) throw new ApiError(response);
      return { slug, server, deleted: response.data?.deletedMessages ?? 0, moved: response.data?.movedMessages ?? 0 };
    },
    onSuccess: ({ slug, server, deleted, moved }) => {
      void invalidateMailQueries(queryClient);
      if (selectedFolder === slug) onSelectFolder('inbox');
      const parts = [];
      if (server) parts.push(deleted === 1 ? '1 message was deleted on the server.' : `${deleted} messages were deleted on the server.`);
      if (moved > 0 || !server) parts.push(server ? (moved === 1 ? '1 message stayed and was filed again.' : `${moved} messages stayed and were filed again.`)
        : (moved === 1 ? '1 message moved back to Inbox.' : `${moved} messages moved back to Inbox.`));
      toast({ title: server ? 'Folder deleted on the server' : 'Folder deleted', description: parts.join(' ') });
    },
    onError: (error: Error, { slug }) => {
      // Deleted on some servers only, or everywhere but UniHub's copy (409): what went where, in plain words.
      if (hasCode(error, 'FOLDER_PARTLY_DELETED')) {
        void invalidateMailQueries(queryClient);
        const details = (error.details ?? {}) as { deleted_on?: string[]; remaining_on?: string[]; settled?: boolean };
        const gone = details.deleted_on?.length ? `Deleted on ${details.deleted_on.join(', ')}.` : '';
        const left = details.remaining_on?.length ? `Still on ${details.remaining_on.join(', ')}: try again later.`
          : 'Delete it again to finish; nothing is sent to the server again.';
        const copy = details.remaining_on?.length && details.settled === false ? 'UniHub updates its copy at the next folder check.' : '';
        toast({ title: 'Folder partly deleted', description: [gone, left, copy].filter(Boolean).join(' '), variant: 'destructive', duration: 10000 });
        return;
      }
      // The folder was made again on the server after UniHub deleted it there (409): nothing was deleted now; another delete removes the new one.
      if (hasCode(error, 'FOLDER_RECREATED')) {
        void invalidateMailQueries(queryClient);
        toast({ title: 'Folder not deleted', description: `The folder was made again on ${serverAddresses(slug)} since you asked. Nothing was deleted; delete it again to remove the new one.`, variant: 'destructive', duration: 10000 });
        return;
      }
      // The mail server refused or could not be reached (502, in UniHub's words), or the account changed meanwhile (409): nothing was deleted.
      if (hasCode(error, 'MAIL_SERVER_ERROR') || hasCode(error, ACCOUNT_CHANGED)) {
        void invalidateMailQueries(queryClient);
        toast({ title: 'Folder not deleted', description: error.message, variant: 'destructive', duration: 10000 });
        return;
      }
      toast({ title: 'Failed to delete folder', description: error.message, variant: 'destructive' });
    },
  });

  // A folder is on the server when an account's server folder is connected to it.
  const serverAccountIds = folderToDelete ? [...new Set([folderToDelete.mail_account_id, ...(folderToDelete.connected_account_ids ?? [])].filter((id): id is string => !!id))] : [];
  const onServer = serverAccountIds.length > 0;
  const serverAccounts = serverAccountIds.map(id => accounts.find(account => account.id === id)?.email_address).filter(Boolean).join(', ');
  const total = folderToDelete?.total_count ?? 0;
  const count = total === 1 ? '1 message' : `${total} messages`;

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mail folders</DialogTitle>
          <DialogDescription>
            Select one mail account to create a folder on that account. In Sync mode, new moves to connected server folders also move mail on the server. Download mode, local copies and Legacy mail keep moves local. Existing server folders are connected during sync. A server folder can be deleted here together with its server copy; rename it at your mail provider.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!activeMailAccountId && <p className="text-sm text-muted-foreground">Choose a mail account in the sidebar before adding a folder.</p>}
          <div className="flex gap-2">
            <Input
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="New folder name"
            />
            <Button
              type="button"
              onClick={() => {
                const name = newFolderName.trim();
                if (name) createFolder.mutate(name);
              }}
              disabled={createFolder.isPending || !newFolderName.trim() || !activeMailAccountId}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>
          <div className="space-y-2 max-h-[360px] overflow-y-auto">
            {folders.map((folder) => (
              <div key={folder.slug} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                {editingFolderSlug === folder.slug ? (
                  <Input
                    value={editingFolderName}
                    onChange={(event) => setEditingFolderName(event.target.value)}
                    className="h-8"
                  />
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{folder.display_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {folder.total_count || 0} messages • {folder.is_system ? 'system' : folder.mail_account_id ? accounts.find(account => account.id === folder.mail_account_id)?.email_address : 'Shared server folder'}
                    </p>
                  </div>
                )}
                {editingFolderSlug === folder.slug ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => updateFolder.mutate({ slug: folder.slug, displayName: editingFolderName.trim() })}
                      disabled={!editingFolderName.trim() || updateFolder.isPending}
                    >
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingFolderSlug(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingFolderSlug(folder.slug);
                        setEditingFolderName(folder.display_name);
                      }}
                      disabled
                      title="Rename provider folders at your mail provider"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => { setDeleteOnServer(false); setFolderToDelete(folder); }}
                      disabled={folder.is_system}
                      aria-label={`Delete ${folder.display_name}`}
                      title={folder.is_system ? 'System folders cannot be deleted' : 'Delete folder'}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <AlertDialog open={!!folderToDelete} onOpenChange={(open) => !open && setFolderToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {folderToDelete?.display_name || 'this folder'}?</AlertDialogTitle>
          <AlertDialogDescription>
            {onServer
              ? `This folder is on the mail server (${serverAccounts || 'your account'}), so it can only be deleted together with the server copy. ${count} in it ${count === '1 message' ? 'goes' : 'go'} with it; a message the server still has elsewhere, a draft or a local copy stays and is filed again. This cannot be undone.`
              : `${count} and the rules filing into it move back to Inbox.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {onServer && (
          <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
            <Checkbox checked={deleteOnServer} onCheckedChange={value => setDeleteOnServer(value === true)} className="mt-0.5" />
            <span>Delete it on the mail server as well, with its messages</span>
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={onServer && !deleteOnServer}
            onClick={() => {
              if (folderToDelete) {
                deleteFolder.mutate({ slug: folderToDelete.slug, server: onServer });
                setFolderToDelete(null);
              }
            }}
          >
            {onServer ? 'Delete on server and in UniHub' : 'Delete folder'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
