import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Edit, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { invalidateMailQueries, type MailAccount, type MailFolder } from '@/lib/mail-api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

/** Folder management dialog. Provider folders are renamed and deleted at the provider. */
export function MailFolderDialogs({ open, onOpenChange, activeMailAccountId, folders, accounts, selectedFolder, onSelectFolder }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [folderToDelete, setFolderToDelete] = useState<MailFolder | null>(null);
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
    mutationFn: async (slug: string) => {
      const response = await api.delete(`/mail/folders/${encodeURIComponent(slug)}`);
      if (response.error) throw new Error(response.error);
      return slug;
    },
    onSuccess: (slug) => {
      void invalidateMailQueries(queryClient);
      if (selectedFolder === slug) onSelectFolder('inbox');
      toast({ title: 'Folder deleted', description: 'Messages and rules were moved back to Inbox.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete folder', description: error.message, variant: 'destructive' });
    },
  });

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mail folders</DialogTitle>
          <DialogDescription>
            Select one mail account to create a folder on that account. In Sync mode, new moves to connected server folders also move mail on the server. Download mode, local copies and Legacy mail keep moves local. Existing server folders are connected during sync. Rename or delete provider folders at your mail provider.
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
                      onClick={() => setFolderToDelete(folder)}
                      disabled
                      title="Delete provider folders at your mail provider"
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
          <AlertDialogTitle>Delete folder?</AlertDialogTitle>
          <AlertDialogDescription>
            Messages and routing rules in {folderToDelete?.display_name || 'this folder'} will move back to Inbox.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              if (folderToDelete) {
                deleteFolder.mutate(folderToDelete.slug);
                setFolderToDelete(null);
              }
            }}
          >
            Delete folder
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
