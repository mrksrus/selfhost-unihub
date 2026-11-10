import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Edit, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { ApiError, hasCode } from '@/lib/api-error';
import { invalidateMailQueries, type FolderDeleteRequest, type FolderPartlyDeletedDetails, type MailAccount, type MailFolder } from '@/lib/mail-api';
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
  // A folder deleted on some of its servers only: what happened on each.
  const [partlyDeleted, setPartlyDeleted] = useState<{ name: string; details: FolderPartlyDeletedDetails } | null>(null);
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

  const deleteFolder = useMutation({
    // The copies the person was shown go with the request: the server deletes only those, while each is still the folder shown.
    mutationFn: async ({ folder }: { folder: MailFolder }) => {
      const copies = folder.server_copies ?? [];
      const server = copies.length > 0;
      const body: FolderDeleteRequest | undefined = server ? { copies } : undefined;
      const response = await api.delete<{ deletedMessages: number; movedMessages: number }>(`/mail/folders/${encodeURIComponent(folder.slug)}${server ? '?server=1' : ''}`, body);
      if (response.error) throw new ApiError(response);
      return { slug: folder.slug, server, deleted: response.data?.deletedMessages ?? 0, moved: response.data?.movedMessages ?? 0 };
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
    onError: (error: Error, { folder }) => {
      // Whatever the answer, the folders are read again: a part may have gone, or the server holds something else now.
      void invalidateMailQueries(queryClient);
      // Deleted on some servers only (409), or a server that never answered its DELETE (502): each server's result.
      if ((hasCode(error, 'FOLDER_PARTLY_DELETED') || hasCode(error, 'MAIL_SERVER_ERROR')) && Array.isArray((error.details as FolderPartlyDeletedDetails | undefined)?.copies)) {
        setPartlyDeleted({ name: folder.display_name, details: error.details as FolderPartlyDeletedDetails });
        return;
      }
      // Nothing deleted: the mail server failed or refused (502, in UniHub's words), the folder changed since it was
      // shown (FOLDER_CHANGED), the account changed meanwhile, a rule, Mail off or a restore refused. The server's sentence says which.
      toast({ title: 'Folder not deleted', description: error.message, variant: 'destructive', duration: 10000 });
    },
  });

  // A folder is on the server when the listing names server copies of it; deleting it deletes those. (An offline
  // copy of the list has none; there the connected accounts tell, and nothing can be deleted until back online.)
  const serverAccountIds = [...new Set(folderToDelete?.server_copies ? folderToDelete.server_copies.map(copy => copy.account_id)
    : [folderToDelete?.mail_account_id, ...(folderToDelete?.connected_account_ids ?? [])].filter((id): id is string => !!id))];
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
                deleteFolder.mutate({ folder: folderToDelete });
                setFolderToDelete(null);
              }
            }}
          >
            {onServer ? 'Delete on server and in UniHub' : 'Delete folder'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!partlyDeleted} onOpenChange={(open) => !open && setPartlyDeleted(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {partlyDeleted?.details.copies.every(copy => copy.outcome === 'deleted')
              ? `${partlyDeleted.name} was deleted on the mail server`
              : partlyDeleted?.details.copies.some(copy => copy.outcome === 'deleted')
                ? `${partlyDeleted.name} was deleted on some servers only`
                : `${partlyDeleted?.name || 'The folder'} may not have been deleted`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {partlyDeleted?.details.copies.some(copy => copy.outcome === 'unknown')
              ? 'A server did not answer. Refresh the folders to see what is still there.'
              : partlyDeleted?.details.settled === false
                ? 'UniHub could not update its own copy yet. Delete the folder again to finish.'
                : 'It stays in UniHub for the servers that still have it.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="divide-y divide-border rounded-md border border-border text-sm" aria-label="Result on each mail server">
          {partlyDeleted?.details.copies.map(copy => (
            <li key={`${copy.account_id}:${copy.email_address}`} className="px-3 py-2">
              <p className="truncate font-medium">{copy.email_address}</p>
              <p className={copy.outcome === 'deleted' ? 'text-muted-foreground' : 'text-warning'}>{COPY_OUTCOME[copy.outcome]}</p>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => setPartlyDeleted(null)}>Close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

// What each server's copy needs after a partial delete, in the person's words.
const COPY_OUTCOME: Record<FolderPartlyDeletedDetails['copies'][number]['outcome'], string> = {
  deleted: 'Deleted',
  changed: 'Not deleted: the folder changed on this server since it was shown. Check it, then delete it again.',
  failed: 'Not deleted: the server did not delete it. Try again later.',
  unknown: 'Unknown: the server did not answer. Refresh the folders to see whether it is still there.',
  not_tried: 'Not deleted: stopped after an earlier server failed. Delete the folder again.',
};
