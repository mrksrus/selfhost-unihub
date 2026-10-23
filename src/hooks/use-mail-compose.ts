import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { deleteDraft, saveDraft, sendDraft, sendMessage, type AttachmentPayload, type DraftInput, type OutgoingMessage, type ReplyThreading } from '@/lib/mail-compose-api';
import { invalidateMailQueries, type Email, type EmailAttachment } from '@/lib/mail-api';
import { contactsQueryOptions } from '@/lib/contacts-api';
import { plainTextToHtml, escapeHtml, sanitizeComposeHtml, sanitizeReturnTo, isComposeHtmlEmpty, isComposeMeaningful, validateComposeAttachments } from '@/lib/mail-compose';
import { useToast } from '@/hooks/use-toast';
import { sendFailureToast } from '@/components/mail/send-failure-toast';
import { useMailAccounts } from '@/hooks/use-mail-queries';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import {
  formatRecipient, getContactDisplayName,
  type ComposeAttachment, type ComposeForm, type ComposeMode, type ContactEmailSuggestion,
} from '@/components/mail/mail-page-model';

type RecipientField = 'to' | 'cc' | 'bcc';

const EMPTY_COMPOSE_FORM: ComposeForm = { to: '', cc: '', bcc: '', subject: '', body: '' };

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

// Each file carries its composer id, so a draft save answers which stored
// attachment it became.
const buildAttachmentPayload = (attachments: ComposeAttachment[]): Promise<AttachmentPayload> =>
  Promise.all(
    attachments.map(async ({ id, file }) => ({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      dataBase64: await fileToBase64(file),
      client_id: id,
    }))
  );

interface ComposeOptions {
  /** The account in view, which a new message starts from; virtual views (all, legacy) have none. */
  activeMailAccountId: string | null;
  /** The selected view, including virtual ones. Only restarts the autosave timer. */
  selectedAccount: string | null;
  isMobile: boolean;
}

/**
 * Compose, reply, forward and draft state. The dialog (new messages and
 * mobile) and the desktop inline reply share this one state.
 */
export function useMailCompose({ activeMailAccountId, selectedAccount, isMobile }: ComposeOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  // The account a message is sent from. It starts as the account in view; in a
  // combined view it is the one chosen in Settings, else the first connected
  // one. A reply always comes from the account that received the message.
  // Choosing another account here never changes what the Mail page shows.
  const { data: accounts = [] } = useMailAccounts();
  const preferredAccountId = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('default_mail_account_id') }).data ?? '';
  const [chosenAccountId, setChosenAccountId] = useState<string | null>(null);
  const connected = (id: string | null | undefined) => !!id && accounts.some(account => account.id === id && account.is_active && !account.disconnected_at);
  const fromAccountId = chosenAccountId ?? activeMailAccountId
    ?? (connected(preferredAccountId) ? preferredAccountId : accounts.find(account => account.is_active && !account.disconnected_at)?.id ?? null);
  const [composeMode, setComposeMode] = useState<ComposeMode>('new');
  const [isReplying, setIsReplying] = useState(false);
  const [composeForm, setComposeForm] = useState<ComposeForm>(EMPTY_COMPOSE_FORM);
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
  // One Idempotency-Key per composed message: pressing Send again after a lost
  // response returns the first result instead of sending the message twice.
  const sendKeyRef = useRef<string | null>(null);
  const sendKey = () => (sendKeyRef.current ??= `send-${crypto.randomUUID()}`);
  // Counts the messages composed here: a send's result (and its "Send again")
  // belongs to the message it sent, not to one opened since.
  const compositionRef = useRef(0);
  // One record per message: its stored draft, and the files it has uploaded
  // (by client id) with the attachment each became, kept by id and never
  // uploaded again. A save that ends after Discard or Send started still
  // records the draft it made in the record of its own message.
  const draftRef = useRef<{ composition: number; id: string | null; uploaded: Map<string, string> }>(
    { composition: 0, id: null, uploaded: new Map() });
  // A message's saves run one at a time, each from the message as it is when
  // it starts, so two saves never race over the same draft or upload.
  const savesRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSavesRef = useRef(0);
  const newComposition = () => {
    compositionRef.current += 1;
    sendKeyRef.current = null;
    draftRef.current = { composition: compositionRef.current, id: null, uploaded: new Map() };
  };
  // Counts the edits of the open message: a save marks it saved only when
  // nothing changed while the save ran.
  const revisionRef = useRef(0);
  const markChanged = ({ attachments = false } = {}) => {
    revisionRef.current += 1;
    if (attachments) setAttachmentsDirty(true);
    setIsComposeDirty(true);
  };
  // The save that shows "Saving": an earlier one ending does not clear a later one's.
  const savingRef = useRef<object | null>(null);
  // The message a reply answers, for its threading headers. Draft saves pass
  // it too: the server keeps it with the draft, so a draft opened later from
  // Drafts (which does not know it) is still sent as a reply.
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);
  const threading: ReplyThreading = replyToEmailId ? { in_reply_to_email_id: replyToEmailId } : {};

  // Open compose dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'compose') {
      const returnTo = sanitizeReturnTo(params.get('returnTo'));
      setComposeMode('new');
      setComposeForm({
        ...EMPTY_COMPOSE_FORM,
        to: params.get('to') || '',
        subject: params.get('subject') || '',
        body: params.get('body') ? plainTextToHtml(params.get('body') || '') : '',
      });
      setComposeReturnTo(returnTo);
      setIsComposeOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

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
    newComposition();
    draftRef.current.id = draft.id;
    setComposeMode('new');
    setReplyToEmailId(null);
    setActiveDraftId(draft.id);
    setExistingDraftAttachments(draft.attachments || []);
    setComposeAttachments([]);
    setAttachmentsDirty(false);
    setIsComposeDirty(false);
    setDraftSavedAt(draft.received_at || new Date().toISOString());
    setComposeForm({
      to: draft.to_addresses?.join(', ') || '',
      cc: draft.cc_addresses?.join(', ') || '',
      bcc: draft.bcc_addresses?.join(', ') || '',
      subject: draft.subject || '',
      body: sanitizeComposeHtml(draft.body_html || '') || (draft.body_text ? plainTextToHtml(draft.body_text) : ''),
    });
    setChosenAccountId(draft.mail_account_id);
    setIsReplying(false);
    setIsComposeOpen(true);
  }, []);

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
    markChanged({ attachments: true });
  };

  const removeComposeAttachment = (attachmentId: string) => {
    setComposeAttachments(prev => prev.filter(att => att.id !== attachmentId));
    markChanged({ attachments: true });
  };

  const removeExistingDraftAttachment = (attachmentId: string) => {
    setExistingDraftAttachments(prev => prev.filter(att => att.id !== attachmentId));
    markChanged({ attachments: true });
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
    if (dirty) markChanged();
  };

  const updateComposeBodyFromEditor = (editorRef: RefObject<HTMLDivElement>) => {
    setComposeForm(prev => ({ ...prev, body: editorRef.current?.innerHTML || '' }));
    markChanged();
  };

  const applyComposeCommand = (editorRef: RefObject<HTMLDivElement>, command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateComposeBodyFromEditor(editorRef);
  };

  const replaceActiveRecipient = (suggestion: ContactEmailSuggestion, field: RecipientField = 'to') => {
    setComposeForm(prev => {
      const parts = prev[field].split(',');
      parts[parts.length - 1] = ` ${formatRecipient(suggestion)}`;
      const nextValue = parts
        .map((part, index) => (index === 0 ? part.trimStart() : part.trim()))
        .filter(Boolean)
        .join(', ');
      return { ...prev, [field]: `${nextValue}, ` };
    });
    markChanged();
  };

  const resetComposeState = () => {
    newComposition();
    setComposeMode('new');
    setReplyToEmailId(null);
    setComposeForm(EMPTY_COMPOSE_FORM);
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
    setChosenAccountId(null);
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
    newComposition();
    setComposeMode(mode);
    setReplyToEmailId(mode === 'reply' ? email.id : null);
    setComposeAttachments([]);
    setExistingDraftAttachments([]);
    setActiveDraftId(null);
    setAttachmentsDirty(false);
    setIsComposeDirty(false);
    setChosenAccountId(email.mail_account_id);
    const quoted = `<p><strong>${mode === 'reply' ? 'Original Message' : 'Forwarded Message'}</strong><br>From: ${escapeHtml(email.from_name || email.from_address)}<br>Date: ${escapeHtml(format(new Date(email.received_at), 'PPpp'))}</p><blockquote>${plainTextToHtml(email.body_text || '')}</blockquote>`;
    setComposeForm({
      ...EMPTY_COMPOSE_FORM,
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
    mutationFn: ({ key, composition: _composition, ...message }: OutgoingMessage & ReplyThreading & { attachments?: AttachmentPayload; key: string; composition: number }) =>
      sendMessage(message, key),
    onSuccess: (_result, { composition }) => {
      toast({ title: '✓ Email sent successfully' });
      if (composition === compositionRef.current) closeComposeFlow({ force: true });
    },
    onError: (error: Error, { composition }) => toast(sendFailureToast(error, sendAgainFor(composition))),
  });

  // What a save reads when it starts, after the saves before it have ended.
  const latestRef = useRef({ composeForm, composeAttachments, existingDraftAttachments, fromAccountId, attachmentsDirty, replyToEmailId });
  useLayoutEffect(() => {
    latestRef.current = { composeForm, composeAttachments, existingDraftAttachments, fromAccountId, attachmentsDirty, replyToEmailId };
  });

  const saveNow = useCallback(async (options: { includeAttachments?: boolean; quiet?: boolean },
    owner: typeof draftRef.current) => {
    // A save that ends after its message was closed or replaced leaves the
    // message open now as it is; one that had not started yet (queued behind
    // another) does nothing, so it never saves the message opened since.
    const composition = owner.composition;
    if (draftRef.current !== owner || compositionRef.current !== composition) return null;
    const { composeForm, composeAttachments, existingDraftAttachments, fromAccountId, attachmentsDirty, replyToEmailId } = latestRef.current;
    if (!fromAccountId) {
      if (!options.quiet) toast({ title: 'Please select an account before saving a draft', variant: 'destructive' });
      return null;
    }
    if (!isComposeMeaningful(composeForm, composeAttachments.length, existingDraftAttachments.length)) {
      return null;
    }

    const revision = revisionRef.current;
    const saving = {};
    savingRef.current = saving;
    setIsDraftSaving(true);
    try {
      const includeAttachments = options.includeAttachments ?? attachmentsDirty;
      const payload: DraftInput = {
        account_id: fromAccountId,
        to: composeForm.to,
        cc: composeForm.cc,
        bcc: composeForm.bcc,
        subject: composeForm.subject,
        body: composeForm.body || '<p></p>',
        isHtml: true,
        ...(replyToEmailId ? { in_reply_to_email_id: replyToEmailId } : {}),
      };

      if (includeAttachments) {
        // The draft keeps exactly what the message shows now: its stored
        // attachments, and the files it holds (each uploaded once).
        const { uploaded } = owner;
        payload.existing_attachment_ids = [
          ...existingDraftAttachments.map(attachment => attachment.id),
          ...composeAttachments.flatMap(attachment => uploaded.has(attachment.id) ? [uploaded.get(attachment.id)!] : []),
        ];
        payload.attachments = await buildAttachmentPayload(composeAttachments.filter(attachment => !uploaded.has(attachment.id)));
        if (composition !== compositionRef.current) return null;
      }

      const { draft: savedDraft, uploaded } = await saveDraft(owner.id, payload);
      owner.id = savedDraft.id;
      for (const { client_id, id } of uploaded) owner.uploaded.set(client_id, id);
      if (composition !== compositionRef.current) return savedDraft;
      // Edits made while it was saved stay unsaved, and are saved next; a file
      // removed meanwhile is dropped from the draft then.
      const current = revision === revisionRef.current;
      setActiveDraftId(savedDraft.id);
      if (includeAttachments && current) setAttachmentsDirty(false);
      if (current) setIsComposeDirty(false);
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
      if (savingRef.current === saving) {
        savingRef.current = null;
        setIsDraftSaving(false);
      }
    }
  }, [queryClient, toast]);

  const saveCurrentDraft = useCallback((options: { includeAttachments?: boolean; quiet?: boolean } = {}) => {
    // Belongs to the message open when it was asked for.
    const owner = draftRef.current;
    const start = () => saveNow(options, owner);
    const run = pendingSavesRef.current === 0 ? start() : savesRef.current.catch(() => {}).then(start);
    pendingSavesRef.current += 1;
    const tracked = run.finally(() => { pendingSavesRef.current -= 1; });
    savesRef.current = tracked;
    return tracked;
  }, [saveNow]);

  useEffect(() => {
    if (!isComposeDirty || !fromAccountId) return;
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
    fromAccountId,
  ]);

  const deleteDraftById = async (draftId: string) => {
    await deleteDraft(draftId);
    void invalidateMailQueries(queryClient);
  };

  const discardCurrentCompose = async () => {
    // A send still preparing (saving the draft, reading attachments) stops
    // now, before the draft is deleted; the key stays for this message. A
    // message closed meanwhile (Save draft in the same prompt) stays closed,
    // and one opened since is not discarded with it.
    const owner = draftRef.current;
    const composition = ++compositionRef.current;
    try {
      // A first save still running may be creating the draft.
      if (!owner.id && pendingSavesRef.current) await savesRef.current.catch(() => {});
      if (owner.id) await deleteDraftById(owner.id);
      if (composition !== compositionRef.current) return;
      setComposeClosePromptOpen(false);
      closeComposeFlow({ force: true });
    } catch (error) {
      // Still open: its next saves go on with the same draft.
      if (composition === compositionRef.current && draftRef.current === owner) owner.composition = composition;
      toast({
        title: 'Failed to discard draft',
        description: error instanceof Error ? error.message : 'Could not discard the draft',
        variant: 'destructive',
      });
    }
  };

  const saveAndClose = () => {
    const composition = compositionRef.current;
    const revision = revisionRef.current;
    saveCurrentDraft({ includeAttachments: true })
      .then(() => {
        // Edited again meanwhile ("Keep editing"): the newer text is not saved yet.
        if (composition !== compositionRef.current || revision !== revisionRef.current) return;
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

  const submitCompose = async () => {
    if (!fromAccountId) {
      toast({ title: 'Please select an account', variant: 'destructive' });
      return;
    }
    if (!composeForm.to.trim() && !composeForm.cc.trim() && !composeForm.bcc.trim()) {
      toast({ title: 'Add at least one recipient', variant: 'destructive' });
      return;
    }
    if (isComposeHtmlEmpty(composeForm.body) && composeAttachments.length === 0) {
      toast({ title: 'Please enter a message or add an attachment', variant: 'destructive' });
      return;
    }

    // Taken before anything is awaited: a message closed or replaced while
    // its draft is saved or its attachments are read is not sent.
    const composition = compositionRef.current;
    const key = sendKey();
    const closedMeanwhile = () => {
      if (composition === compositionRef.current) return false;
      toast({ title: 'Not sent', description: 'The message was closed before it was sent.' });
      return true;
    };
    try {
      // A first save still running may be creating this message's draft: the
      // message is then sent as that draft, which leaves no copy in Drafts.
      if (!draftRef.current.id && pendingSavesRef.current) {
        await savesRef.current.catch(() => {});
        if (closedMeanwhile()) return;
      }
      const owner = draftRef.current;
      if (owner.id) {
        const savedDraft = await saveCurrentDraft({ includeAttachments: true, quiet: true });
        if (closedMeanwhile()) return;
        const draftId = savedDraft?.id || owner.id!;
        try {
          await sendDraft(draftId, key, threading);
        } catch (error) {
          toast(sendFailureToast(error, sendAgainFor(composition)));
          return;
        }
        toast({ title: '✓ Email sent successfully' });
        void invalidateMailQueries(queryClient);
        if (composition === compositionRef.current) closeComposeFlow({ force: true });
        return;
      }

      const attachmentPayload = await buildAttachmentPayload(composeAttachments);
      if (closedMeanwhile()) return;

      sendEmailMutation.mutate({
        key,
        composition,
        account_id: fromAccountId,
        to: composeForm.to,
        cc: composeForm.cc,
        bcc: composeForm.bcc,
        subject: composeForm.subject.trim() || '(No subject)',
        body: composeForm.body || '<p></p>',
        isHtml: true,
        attachments: attachmentPayload,
        ...threading,
      });
    } catch (error) {
      toast({
        title: 'Attachment error',
        description: error instanceof Error ? error.message : 'Failed to prepare attachments',
        variant: 'destructive',
      });
    }
  };
  // "Send again" after an unknown outcome is a new send of what the composer
  // holds when it is pressed, under a new key, while that message is still
  // the one open. Another message opened since is never sent by it.
  const submitRef = useRef(submitCompose);
  submitRef.current = submitCompose;
  function sendAgainFor(composition: number | undefined) {
    return () => {
      if (composition !== compositionRef.current) {
        toast({ title: 'Not sent again', description: 'That message is no longer open.' });
        return;
      }
      sendKeyRef.current = null;
      void submitRef.current();
    };
  }
  const handleSendEmail = (e: FormEvent) => {
    e.preventDefault();
    void submitCompose();
  };

  return {
    isComposeOpen, openCompose: () => setIsComposeOpen(true), composeMode, isReplying,
    composeForm, updateComposeForm, fromAccountId, setFromAccount: setChosenAccountId,
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
