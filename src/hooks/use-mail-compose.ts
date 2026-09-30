import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { api } from '@/lib/api';
import { invalidateMailQueries, type Email, type EmailAttachment } from '@/lib/mail-api';
import { contactsQueryOptions } from '@/lib/contacts-api';
import { plainTextToHtml, escapeHtml, sanitizeReturnTo, isComposeHtmlEmpty, isComposeMeaningful, validateComposeAttachments } from '@/lib/mail-compose';
import { useToast } from '@/hooks/use-toast';
import {
  formatRecipient, getContactDisplayName,
  type ComposeAttachment, type ComposeForm, type ComposeMode, type ContactEmailSuggestion,
} from '@/components/mail/mail-page-model';

type AttachmentPayload = Array<{ filename: string; contentType: string; size: number; dataBase64: string }>;

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Failed to read attachment'));
        return;
      }
      const base64 = reader.result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });

interface ComposeOptions {
  /** The real account that sends and owns drafts; virtual views (all, legacy) have none. */
  activeMailAccountId: string | null;
  /** The selected view, including virtual ones. Only restarts the autosave timer. */
  selectedAccount: string | null;
  setSelectedAccount: (value: string | null) => void;
  isMobile: boolean;
}

/**
 * Compose, reply, forward and draft state. The dialog (new messages and
 * mobile) and the desktop inline reply share this one state.
 */
export function useMailCompose({ activeMailAccountId, selectedAccount, setSelectedAccount, isMobile }: ComposeOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<ComposeMode>('new');
  const [isReplying, setIsReplying] = useState(false);
  const [composeForm, setComposeForm] = useState<ComposeForm>({
    to: '',
    subject: '',
    body: '',
  });
  const [composeReturnTo, setComposeReturnTo] = useState<string | null>(null);
  const [focusedRecipientInput, setFocusedRecipientInput] = useState<string | null>(null);
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [existingDraftAttachments, setExistingDraftAttachments] = useState<EmailAttachment[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [isComposeDirty, setIsComposeDirty] = useState(false);
  const [attachmentsDirty, setAttachmentsDirty] = useState(false);
  const [isDraftSaving, setIsDraftSaving] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [composeClosePromptOpen, setComposeClosePromptOpen] = useState(false);
  const [draftToDelete, setDraftToDelete] = useState<Email | null>(null);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const inlineComposeEditorRef = useRef<HTMLDivElement | null>(null);
  const dialogComposeEditorRef = useRef<HTMLDivElement | null>(null);

  // Open compose dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'compose') {
      const returnTo = sanitizeReturnTo(params.get('returnTo'));
      setComposeMode('new');
      setComposeForm({
        to: params.get('to') || '',
        subject: params.get('subject') || '',
        body: params.get('body') ? plainTextToHtml(params.get('body') || '') : '',
      });
      setComposeReturnTo(returnTo);
      setIsComposeOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    for (const editorRef of [inlineComposeEditorRef, dialogComposeEditorRef]) {
      if (editorRef.current && editorRef.current.innerHTML !== composeForm.body) {
        editorRef.current.innerHTML = composeForm.body;
      }
    }
  }, [composeForm.body, isComposeOpen, isReplying]);

  const { data: contactsForCompose = [] } = useQuery({ ...contactsQueryOptions, enabled: isComposeOpen || isReplying });
  const contactEmailSuggestions = useMemo<ContactEmailSuggestion[]>(() => {
    return contactsForCompose.flatMap((contact) => {
      const name = getContactDisplayName(contact);
      return [contact.email, contact.email2, contact.email3]
        .filter((email): email is string => Boolean(email?.trim()))
        .map((email, index) => ({
          key: `${contact.id}-${index}-${email}`,
          name,
          email,
        }));
    });
  }, [contactsForCompose]);

  const hasMeaningfulContent = () =>
    isComposeMeaningful(composeForm, composeAttachments.length, existingDraftAttachments.length);

  const openDraftForCompose = useCallback((draft: Email) => {
    setComposeMode('new');
    setActiveDraftId(draft.id);
    setExistingDraftAttachments(draft.attachments || []);
    setComposeAttachments([]);
    setAttachmentsDirty(false);
    setIsComposeDirty(false);
    setDraftSavedAt(draft.received_at || new Date().toISOString());
    setComposeForm({
      to: draft.to_addresses?.join(', ') || '',
      subject: draft.subject || '',
      body: draft.body_html || (draft.body_text ? plainTextToHtml(draft.body_text) : ''),
    });
    setSelectedAccount(draft.mail_account_id);
    setIsReplying(false);
    setIsComposeOpen(true);
  }, [setSelectedAccount]);

  const addComposeFiles = (files: FileList | File[]) => {
    const incomingFiles = Array.from(files || []);
    if (incomingFiles.length === 0) return;

    const existingKeys = new Set(
      composeAttachments.map(attachment =>
        `${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`
      )
    );
    const uniqueIncomingFiles = incomingFiles.filter(file => {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    if (uniqueIncomingFiles.length === 0) return;

    const validationError = validateComposeAttachments(
      [
        ...existingDraftAttachments.map(attachment => ({
          filename: attachment.filename,
          size: attachment.size_bytes,
        })),
        ...composeAttachments.map(attachment => ({
          filename: attachment.file.name,
          size: attachment.file.size,
        })),
      ],
      uniqueIncomingFiles
    );
    if (validationError) {
      toast({
        title: 'Attachment not added',
        description: validationError,
        variant: 'destructive',
      });
      return;
    }

    setComposeAttachments(prev => [
      ...prev,
      ...uniqueIncomingFiles.map(file => ({ id: crypto.randomUUID(), file })),
    ]);
    setAttachmentsDirty(true);
    setIsComposeDirty(true);
  };

  const removeComposeAttachment = (attachmentId: string) => {
    setComposeAttachments(prev => prev.filter(att => att.id !== attachmentId));
    setAttachmentsDirty(true);
    setIsComposeDirty(true);
  };

  const removeExistingDraftAttachment = (attachmentId: string) => {
    setExistingDraftAttachments(prev => prev.filter(att => att.id !== attachmentId));
    setAttachmentsDirty(true);
    setIsComposeDirty(true);
  };

  const handleComposeAttachmentInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addComposeFiles(e.target.files);
    }
    // Allow re-selecting the same file later
    e.target.value = '';
  };

  const updateComposeForm = (patch: Partial<ComposeForm>, dirty = true) => {
    setComposeForm(prev => ({ ...prev, ...patch }));
    if (dirty) setIsComposeDirty(true);
  };

  const updateComposeBodyFromEditor = (editorRef: RefObject<HTMLDivElement>) => {
    setComposeForm(prev => ({ ...prev, body: editorRef.current?.innerHTML || '' }));
    setIsComposeDirty(true);
  };

  const applyComposeCommand = (editorRef: RefObject<HTMLDivElement>, command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateComposeBodyFromEditor(editorRef);
  };

  const replaceActiveRecipient = (suggestion: ContactEmailSuggestion) => {
    setComposeForm(prev => {
      const parts = prev.to.split(',');
      parts[parts.length - 1] = ` ${formatRecipient(suggestion)}`;
      const nextValue = parts
        .map((part, index) => (index === 0 ? part.trimStart() : part.trim()))
        .filter(Boolean)
        .join(', ');
      return { ...prev, to: `${nextValue}, ` };
    });
    setIsComposeDirty(true);
  };

  const resetComposeState = () => {
    setComposeMode('new');
    setComposeForm({ to: '', subject: '', body: '' });
    setFocusedRecipientInput(null);
    setComposeAttachments([]);
    setExistingDraftAttachments([]);
    setActiveDraftId(null);
    setIsComposeDirty(false);
    setAttachmentsDirty(false);
    setIsDraftSaving(false);
    setDraftSavedAt(null);
    setIsAttachmentDragOver(false);
    setIsReplying(false);
  };

  const closeComposeFlow = (options: { force?: boolean } = {}) => {
    const hasUnsavedWork = (isComposeDirty || attachmentsDirty) && hasMeaningfulContent();
    if (!options.force && hasUnsavedWork) {
      setComposeClosePromptOpen(true);
      return;
    }
    const target = composeReturnTo;
    setIsComposeOpen(false);
    resetComposeState();
    setComposeReturnTo(null);
    if (target) navigate(target);
  };

  /** Starts a reply or forward of the open message; asks first when a dirty compose would be replaced. */
  const startResponse = (email: Email, mode: 'reply' | 'forward') => {
    if ((isReplying || isComposeOpen) && (isComposeDirty || attachmentsDirty) && hasMeaningfulContent()) {
      setComposeClosePromptOpen(true);
      return;
    }
    setComposeMode(mode);
    setComposeAttachments([]);
    setExistingDraftAttachments([]);
    setActiveDraftId(null);
    setAttachmentsDirty(false);
    setIsComposeDirty(false);
    if (!activeMailAccountId) {
      setSelectedAccount(email.mail_account_id);
    }
    const quoted = `<p><strong>${mode === 'reply' ? 'Original Message' : 'Forwarded Message'}</strong><br>From: ${escapeHtml(email.from_name || email.from_address)}<br>Date: ${escapeHtml(format(new Date(email.received_at), 'PPpp'))}</p><blockquote>${plainTextToHtml(email.body_text || '')}</blockquote>`;
    setComposeForm({
      to: mode === 'reply' ? email.from_address : '',
      subject: `${mode === 'reply' ? 'Re' : 'Fwd'}: ${email.subject || ''}`,
      body: `<p><br></p><hr>${quoted}`,
    });
    if (isMobile) {
      setIsComposeOpen(true);
    } else {
      setIsReplying(true);
    }
  };

  const sendEmailMutation = useMutation({
    mutationFn: async (data: {
      account_id: string;
      to: string;
      subject: string;
      body: string;
      isHtml?: boolean;
      attachments?: AttachmentPayload;
    }) => {
      const response = await api.post('/mail/send', data);
      if (response.error) {
        throw new Error(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      toast({ title: '✓ Email sent successfully' });
      closeComposeFlow({ force: true });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to send email',
        description: error.message,
        variant: 'destructive',
        duration: 8000,
      });
    },
  });

  const buildAttachmentPayload = useCallback(async (): Promise<AttachmentPayload> =>
    Promise.all(
      composeAttachments.map(async ({ file }) => ({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        dataBase64: await fileToBase64(file),
      }))
    ), [composeAttachments]);

  const saveCurrentDraft = useCallback(async (options: { includeAttachments?: boolean; quiet?: boolean } = {}) => {
    if (!activeMailAccountId) {
      if (!options.quiet) toast({ title: 'Please select an account before saving a draft', variant: 'destructive' });
      return null;
    }
    if (!isComposeMeaningful(composeForm, composeAttachments.length, existingDraftAttachments.length)) {
      return null;
    }

    setIsDraftSaving(true);
    try {
      const includeAttachments = options.includeAttachments ?? attachmentsDirty;
      const payload: {
        account_id: string;
        to: string;
        subject: string;
        body: string;
        isHtml: boolean;
        existing_attachment_ids?: string[];
        attachments?: AttachmentPayload;
      } = {
        account_id: activeMailAccountId,
        to: composeForm.to,
        subject: composeForm.subject,
        body: composeForm.body || '<p></p>',
        isHtml: true,
      };

      if (includeAttachments) {
        payload.existing_attachment_ids = existingDraftAttachments.map(attachment => attachment.id);
        payload.attachments = await buildAttachmentPayload();
      }

      const response = activeDraftId
        ? await api.put<{ draft: Email }>(`/mail/drafts/${activeDraftId}`, payload)
        : await api.post<{ draft: Email }>('/mail/drafts', payload);

      if (response.error || !response.data?.draft) {
        throw new Error(response.error || 'Failed to save draft');
      }

      const savedDraft = response.data.draft;
      setActiveDraftId(savedDraft.id);
      setExistingDraftAttachments(savedDraft.attachments || []);
      if (includeAttachments) {
        setComposeAttachments([]);
        setAttachmentsDirty(false);
      }
      setIsComposeDirty(false);
      setDraftSavedAt(new Date().toISOString());
      void invalidateMailQueries(queryClient);
      if (!options.quiet) toast({ title: 'Draft saved' });
      return savedDraft;
    } catch (error) {
      if (!options.quiet) {
        toast({
          title: 'Failed to save draft',
          description: error instanceof Error ? error.message : 'Could not save the draft',
          variant: 'destructive',
        });
      }
      throw error;
    } finally {
      setIsDraftSaving(false);
    }
  }, [
    activeDraftId,
    attachmentsDirty,
    buildAttachmentPayload,
    composeAttachments,
    composeForm,
    existingDraftAttachments,
    queryClient,
    activeMailAccountId,
    toast,
  ]);

  useEffect(() => {
    if (!isComposeDirty || !activeMailAccountId) return;
    if (!isComposeOpen && !isReplying) return;
    if (!isComposeMeaningful(composeForm, composeAttachments.length, existingDraftAttachments.length)) return;

    const timeout = window.setTimeout(() => {
      saveCurrentDraft({ quiet: true }).catch(() => {
        // Explicit saves and sends surface errors. Autosave should not interrupt typing.
      });
    }, 1500);

    return () => window.clearTimeout(timeout);
  }, [
    composeAttachments.length,
    composeForm,
    existingDraftAttachments.length,
    isComposeDirty,
    isComposeOpen,
    isReplying,
    saveCurrentDraft,
    selectedAccount,
    activeMailAccountId,
  ]);

  const deleteDraftById = async (draftId: string) => {
    const response = await api.delete(`/mail/drafts/${draftId}`);
    if (response.error) throw new Error(response.error);
    void invalidateMailQueries(queryClient);
  };

  const discardCurrentCompose = async () => {
    try {
      if (activeDraftId) {
        await deleteDraftById(activeDraftId);
      }
      setComposeClosePromptOpen(false);
      closeComposeFlow({ force: true });
    } catch (error) {
      toast({
        title: 'Failed to discard draft',
        description: error instanceof Error ? error.message : 'Could not discard the draft',
        variant: 'destructive',
      });
    }
  };

  const saveAndClose = () => {
    saveCurrentDraft({ includeAttachments: true })
      .then(() => {
        setComposeClosePromptOpen(false);
        closeComposeFlow({ force: true });
      })
      .catch(() => {});
  };

  const confirmDeleteDraft = () => {
    if (!draftToDelete) return;
    deleteDraftById(draftToDelete.id)
      .then(() => {
        toast({ title: 'Draft deleted' });
        if (activeDraftId === draftToDelete.id) closeComposeFlow({ force: true });
        setDraftToDelete(null);
      })
      .catch((error) => {
        toast({
          title: 'Failed to delete draft',
          description: error instanceof Error ? error.message : 'Could not delete draft',
          variant: 'destructive',
        });
      });
  };

  const handleSendEmail = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeMailAccountId) {
      toast({ title: 'Please select an account', variant: 'destructive' });
      return;
    }
    if (!composeForm.to.trim()) {
      toast({ title: 'Please enter a recipient', variant: 'destructive' });
      return;
    }
    if (isComposeHtmlEmpty(composeForm.body) && composeAttachments.length === 0) {
      toast({ title: 'Please enter a message or add an attachment', variant: 'destructive' });
      return;
    }

    try {
      if (activeDraftId) {
        const savedDraft = await saveCurrentDraft({ includeAttachments: true, quiet: true });
        const draftId = savedDraft?.id || activeDraftId;
        const response = await api.post(`/mail/drafts/${draftId}/send`);
        if (response.error) throw new Error(response.error);
        toast({ title: '✓ Email sent successfully' });
        void invalidateMailQueries(queryClient);
        closeComposeFlow({ force: true });
        return;
      }

      const attachmentPayload = await buildAttachmentPayload();

      sendEmailMutation.mutate({
        account_id: activeMailAccountId,
        to: composeForm.to,
        subject: composeForm.subject.trim() || '(No subject)',
        body: composeForm.body || '<p></p>',
        isHtml: true,
        attachments: attachmentPayload,
      });
    } catch (error) {
      toast({
        title: 'Attachment error',
        description: error instanceof Error ? error.message : 'Failed to prepare attachments',
        variant: 'destructive',
      });
    }
  };

  return {
    isComposeOpen, openCompose: () => setIsComposeOpen(true), composeMode, isReplying,
    composeForm, updateComposeForm, activeMailAccountId,
    focusedRecipientInput, setFocusedRecipientInput, replaceActiveRecipient, contactEmailSuggestions,
    composeAttachments, existingDraftAttachments, isAttachmentDragOver, setIsAttachmentDragOver,
    addComposeFiles, removeComposeAttachment, removeExistingDraftAttachment, handleComposeAttachmentInput,
    inlineComposeEditorRef, dialogComposeEditorRef, updateComposeBodyFromEditor, applyComposeCommand,
    activeDraftId, isDirty: isComposeDirty || attachmentsDirty, isDraftSaving, draftSavedAt,
    isSending: sendEmailMutation.isPending,
    openDraftForCompose, startResponse, resetComposeState, closeComposeFlow, handleSendEmail, saveCurrentDraft,
    composeClosePromptOpen, setComposeClosePromptOpen, discardCurrentCompose, saveAndClose,
    draftToDelete, setDraftToDelete, confirmDeleteDraft,
  };
}

export type MailCompose = ReturnType<typeof useMailCompose>;
