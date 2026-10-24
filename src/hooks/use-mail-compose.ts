import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { deleteDraft, saveDraft, sendDraft, sendMessage, type AttachmentPayload, type DraftInput, type OutgoingMessage, type ReplyThreading } from '@/lib/mail-compose-api';
import { invalidateMailQueries, type Email, type EmailAttachment } from '@/lib/mail-api';
import { ApiError } from '@/lib/api-error';
import { cancelMailSchedule, createMailTemplate, mailTemplatesKey, scheduleMailDraft, type MailTemplate } from '@/lib/mail-essentials-api';
import { contactsQueryOptions } from '@/lib/contacts-api';
import { plainTextToHtml, sanitizeComposeHtml, sanitizeReturnTo, isComposeBodyEmpty, isComposeMeaningful, validateComposeAttachments } from '@/lib/mail-compose';
import { composeBody, convertBody, htmlToPlainText, quoteOf, responseRecipients, signatureFor, type BodyParts, type ComposeFormat, type ResponseMode } from '@/lib/compose-body';
import { formatWhen } from '@/lib/mail-times';
import { useToast } from '@/hooks/use-toast';
import { sendFailureToast } from '@/components/mail/send-failure-toast';
import { scheduledSendToast } from '@/components/mail/scheduled-send-toast';
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

/** An added file in the draft: being uploaded with a save, stored with it, or that save failed. */
export type AttachmentUpload = 'uploading' | 'saved' | 'failed';

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
  const formatSetting = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('compose_format') });
  const defaultFormat = formatSetting.data ?? 'rich';
  // The saved default is known (or could not be loaded): a compose link may open.
  const formatKnown = formatSetting.isFetched || formatSetting.isError;
  // The optional compose features (P-26): off until switched on in Settings,
  // Mail; only then does the composer show their button.
  const features = {
    templates: useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('compose_templates') }).data ?? false,
    scheduledSend: useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('compose_scheduled_send') }).data ?? false,
    formatSwitch: useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('compose_format_switch') }).data ?? false,
  };
  const [chosenAccountId, setChosenAccountId] = useState<string | null>(null);
  const connected = (id: string | null | undefined) => !!id && accounts.some(account => account.id === id && account.is_active && !account.disconnected_at);
  const fromAccountId = chosenAccountId ?? activeMailAccountId
    ?? (connected(preferredAccountId) ? preferredAccountId : accounts.find(account => account.is_active && !account.disconnected_at)?.id ?? null);
  const [composeMode, setComposeMode] = useState<ComposeMode>('new');
  const [isReplying, setIsReplying] = useState(false);
  const [composeForm, setComposeForm] = useState<ComposeForm>(EMPTY_COMPOSE_FORM);
  // Rich text or plain text: the account's default for each new message,
  // switched per message where the switch is on (Settings, Mail).
  const [bodyFormat, setBodyFormat] = useState<ComposeFormat>('rich');
  // What the message started from (a template, the quoted message), so a
  // signature can follow the From account while nothing was written yet.
  const partsRef = useRef<BodyParts>({});
  const [composeReturnTo, setComposeReturnTo] = useState<string | null>(null);
  const [focusedRecipientInput, setFocusedRecipientInput] = useState<string | null>(null);
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [existingDraftAttachments, setExistingDraftAttachments] = useState<EmailAttachment[]>([]);
  // What the last draft save did with each added file (by its composer id);
  // a file without an entry has not been saved with the draft yet.
  const [attachmentUploads, setAttachmentUploads] = useState<Record<string, AttachmentUpload>>({});
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  // When the open draft is scheduled to be sent (opened from Drafts); null otherwise.
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [isComposeDirty, setIsComposeDirty] = useState(false);
  const [attachmentsDirty, setAttachmentsDirty] = useState(false);
  const [isDraftSaving, setIsDraftSaving] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [composeClosePromptOpen, setComposeClosePromptOpen] = useState(false);
  const [draftToDelete, setDraftToDelete] = useState<Email | null>(null);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const inlineComposeEditorRef = useRef<HTMLDivElement | null>(null);
  const dialogComposeEditorRef = useRef<HTMLDivElement | null>(null);
  // Where the person last wrote: a template is inserted there once the body
  // has been touched. The rich editor's selection is gone once a menu takes
  // focus, so it is remembered as the editor loses it.
  const richRangeRef = useRef<{ editor: HTMLElement; range: Range } | null>(null);
  const plainSelectionRef = useRef<{ start: number; end: number } | null>(null);
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
    setAttachmentUploads({});
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
  const accountById = (id: string | null | undefined) => accounts.find(account => account.id === id) ?? null;
  const startingBody = (accountId: string | null, nextFormat: ComposeFormat, parts: BodyParts) => {
    partsRef.current = parts;
    return composeBody(nextFormat, signatureFor(accountById(accountId), nextFormat), parts);
  };

  // Open compose dialog if linked from dashboard, in the person's compose
  // format once that is known.
  const composeLinkHandled = useRef(false);
  useEffect(() => {
    if (composeLinkHandled.current || !formatKnown) return;
    composeLinkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') !== 'compose') return;
    // A message started while the settings loaded is kept; the link gives way.
    if (compositionRef.current !== 0) {
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    newComposition();
    const returnTo = sanitizeReturnTo(params.get('returnTo'));
    const linkBody = params.get('body') || '';
    setComposeMode('new');
    setBodyFormat(defaultFormat);
    // A body from the link is the start of the message, above the signature.
    partsRef.current = linkBody ? { intro: { html: null, text: linkBody } } : {};
    setComposeForm({
      ...EMPTY_COMPOSE_FORM,
      to: params.get('to') || '',
      subject: params.get('subject') || '',
      body: linkBody ? (defaultFormat === 'plain' ? linkBody : plainTextToHtml(linkBody)) : '',
    });
    setComposeReturnTo(returnTo);
    setIsComposeOpen(true);
    window.history.replaceState({}, '', window.location.pathname);
  }, [formatKnown, defaultFormat]);

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
    isComposeMeaningful(composeForm, composeAttachments.length, existingDraftAttachments.length, bodyFormat);

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
    setScheduledAt(draft.scheduled_send_status === 'scheduled' ? draft.scheduled_send_at ?? null : null);
    setComposeForm({
      to: draft.to_addresses?.join(', ') || '',
      cc: draft.cc_addresses?.join(', ') || '',
      bcc: draft.bcc_addresses?.join(', ') || '',
      subject: draft.subject || '',
      body: draft.body_html ? sanitizeComposeHtml(draft.body_html) : draft.body_text || '',
    });
    // A draft keeps the format it was written in.
    setBodyFormat(draft.body_html || !draft.body_text ? 'rich' : 'plain');
    partsRef.current = {};
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

  // A new From account is an edit: a save in progress is followed by another
  // (Send later), and a stored draft is saved again. An untouched new message
  // stays untouched, so its signature keeps following the account.
  const setFromAccount = (id: string) => {
    if (id === fromAccountId) return;
    setChosenAccountId(id);
    if (isComposeDirty || activeDraftId) markChanged();
    else revisionRef.current += 1;
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

  /** Remembers the rich editor's caret, so a template can be inserted where the person was writing. */
  const rememberRichSelection = (editorRef: RefObject<HTMLDivElement>) => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer)) richRangeRef.current = { editor, range: range.cloneRange() };
  };
  const rememberPlainSelection = (start: number, end: number) => { plainSelectionRef.current = { start, end }; };

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
    setBodyFormat('rich');
    partsRef.current = {};
    setFocusedRecipientInput(null);
    setComposeAttachments([]);
    setExistingDraftAttachments([]);
    setActiveDraftId(null);
    setScheduledAt(null);
    setIsComposeDirty(false);
    setAttachmentsDirty(false);
    setIsDraftSaving(false);
    setDraftSavedAt(null);
    setIsAttachmentDragOver(false);
    setIsReplying(false);
    setChosenAccountId(null);
    richRangeRef.current = null;
    plainSelectionRef.current = null;
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

  /** Starts a reply, reply to all or forward of the open message; asks first when a dirty compose would be replaced. */
  const startResponse = (email: Email, mode: ResponseMode) => {
    if ((isReplying || isComposeOpen) && (isComposeDirty || attachmentsDirty) && hasMeaningfulContent()) {
      setComposeClosePromptOpen(true);
      return;
    }
    newComposition();
    setComposeMode(mode === 'forward' ? 'forward' : 'reply');
    setReplyToEmailId(mode === 'forward' ? null : email.id);
    setComposeAttachments([]);
    setExistingDraftAttachments([]);
    setActiveDraftId(null);
    setScheduledAt(null);
    setAttachmentsDirty(false);
    setIsComposeDirty(false);
    setChosenAccountId(email.mail_account_id);
    setBodyFormat(defaultFormat);
    const recipients = responseRecipients(email, mode, accountById(email.mail_account_id)?.email_address);
    setComposeForm({
      ...EMPTY_COMPOSE_FORM,
      ...recipients,
      subject: `${mode === 'forward' ? 'Fwd' : 'Re'}: ${email.subject || ''}`,
      body: startingBody(email.mail_account_id, defaultFormat, { quote: quoteOf(email, mode) }),
    });
    if (isMobile) {
      setIsComposeOpen(true);
    } else {
      setIsReplying(true);
    }
  };

  /** Opens an empty new message in the account's compose format, with the sending account's signature. */
  const startNewMessage = () => {
    if (!isComposeOpen && !isReplying) {
      newComposition();
      setComposeMode('new');
      setBodyFormat(defaultFormat);
      setComposeForm({ ...EMPTY_COMPOSE_FORM, body: startingBody(fromAccountId, defaultFormat, {}) });
      setIsComposeDirty(false);
    }
    setIsComposeOpen(true);
  };

  // While nothing was written yet, the body follows the From account's
  // signature: a choice in the composer, or the accounts and the default
  // send-from account arriving after the composer opened.
  const signature = signatureFor(accountById(fromAccountId), bodyFormat);
  useEffect(() => {
    if ((!isComposeOpen && !isReplying) || isComposeDirty || activeDraftId) return;
    setComposeForm(prev => ({ ...prev, body: composeBody(bodyFormat, signature, partsRef.current) }));
    // bodyFormat changes only with a switch, which marks the message changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, isComposeOpen, isReplying, isComposeDirty, activeDraftId]);

  /** Switches this message between rich text and plain text. */
  const switchBodyFormat = (next: ComposeFormat) => {
    if (next === bodyFormat) return;
    setBodyFormat(next);
    setComposeForm(prev => ({ ...prev, body: convertBody(prev.body, next) }));
    markChanged();
  };

  /**
   * Inserts a template: the subject only while none is written; the text
   * replaces an untouched body (above the signature and quote), or goes in
   * where the person was writing.
   */
  const applyTemplate = (template: MailTemplate) => {
    const intro = { html: template.body_html, text: template.body_text };
    const untouched = (!isComposeDirty && !activeDraftId) || composeForm.body === composeBody(bodyFormat, signature, partsRef.current);
    const subjectOf = (current: string) => current.trim() ? current : template.subject || '';
    if (untouched) {
      setComposeForm(prev => ({ ...prev, subject: subjectOf(prev.subject), body: startingBody(fromAccountId, bodyFormat, { ...partsRef.current, intro }) }));
      markChanged();
      return;
    }
    if (bodyFormat === 'plain') {
      const text = intro.text || (intro.html ? htmlToPlainText(intro.html) : '');
      const at = plainSelectionRef.current ?? { start: 0, end: 0 };
      setComposeForm(prev => ({ ...prev, subject: subjectOf(prev.subject), body: `${prev.body.slice(0, at.start)}${text}${prev.body.slice(at.end)}` }));
      plainSelectionRef.current = { start: at.start + text.length, end: at.start + text.length };
      markChanged();
      return;
    }
    const editor = (isComposeOpen ? dialogComposeEditorRef : inlineComposeEditorRef).current;
    const html = intro.html ? sanitizeComposeHtml(intro.html) : plainTextToHtml(intro.text);
    if (!editor) {
      setComposeForm(prev => ({ ...prev, subject: subjectOf(prev.subject), body: `${html}${prev.body}` }));
      markChanged();
      return;
    }
    // At the remembered caret, else at the top of the message. Only
    // sanitized HTML reaches the editor (sanitizeComposeHtml above).
    const remembered = richRangeRef.current?.editor === editor && editor.contains(richRangeRef.current.range.startContainer) ? richRangeRef.current.range : null;
    const range = remembered ?? document.createRange();
    if (!remembered) range.setStart(editor, 0);
    range.deleteContents();
    const fragment = document.createElement('template');
    fragment.innerHTML = html;
    const last = fragment.content.lastChild;
    range.insertNode(fragment.content);
    if (last) { range.setStartAfter(last); range.collapse(true); }
    editor.focus();
    const selection = window.getSelection();
    if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    richRangeRef.current = { editor, range: range.cloneRange() };
    setComposeForm(prev => ({ ...prev, subject: subjectOf(prev.subject), body: editor.innerHTML }));
    markChanged();
  };

  /** The message as written, without the signature and the quoted message: what a template holds. */
  const templateBody = () => {
    const body = composeForm.body;
    if (bodyFormat === 'plain') {
      const cutAt = [signature ? body.indexOf(signature) : -1, body.indexOf('-------- ')].filter(index => index >= 0);
      return (cutAt.length ? body.slice(0, Math.min(...cutAt)) : body).trimEnd();
    }
    const cutAt = [signature ? body.indexOf(signature) : -1, body.indexOf('<hr>')].filter(index => index >= 0);
    return cutAt.length ? body.slice(0, Math.min(...cutAt)) : body;
  };

  /** Saves the open message as a template under the given name; a taken name is refused (ApiError TEMPLATE_NAME_TAKEN). */
  const saveAsTemplate = async (name: string) => {
    const body = templateBody();
    const template = await createMailTemplate({
      name, subject: composeForm.subject.trim(),
      body_html: bodyFormat === 'rich' ? body : null,
      body_text: bodyFormat === 'rich' ? htmlToPlainText(body) : body,
    });
    void queryClient.invalidateQueries({ queryKey: mailTemplatesKey });
    toast({ title: 'Template saved', description: `"${template.name}" is in the Templates menu.` });
    return template;
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
  const latestRef = useRef({ composeForm, composeAttachments, existingDraftAttachments, fromAccountId, attachmentsDirty, bodyFormat, replyToEmailId });
  useLayoutEffect(() => {
    latestRef.current = { composeForm, composeAttachments, existingDraftAttachments, fromAccountId, attachmentsDirty, bodyFormat, replyToEmailId };
  });

  const saveNow = useCallback(async (options: { includeAttachments?: boolean; quiet?: boolean },
    owner: typeof draftRef.current) => {
    // A save that ends after its message was closed or replaced leaves the
    // message open now as it is; one that had not started yet (queued behind
    // another) does nothing, so it never saves the message opened since.
    const composition = owner.composition;
    if (draftRef.current !== owner || compositionRef.current !== composition) return null;
    const { composeForm, composeAttachments, existingDraftAttachments, fromAccountId, attachmentsDirty, bodyFormat, replyToEmailId } = latestRef.current;
    if (!fromAccountId) {
      if (!options.quiet) toast({ title: 'Please select an account before saving a draft', variant: 'destructive' });
      return null;
    }
    if (!isComposeMeaningful(composeForm, composeAttachments.length, existingDraftAttachments.length, bodyFormat)) {
      return null;
    }

    const revision = revisionRef.current;
    const saving = {};
    savingRef.current = saving;
    setIsDraftSaving(true);
    let uploading: string[] = [];
    const markUploads = (ids: string[], state: AttachmentUpload | null) => {
      if (ids.length === 0 || composition !== compositionRef.current) return;
      setAttachmentUploads(prev => {
        const next = { ...prev };
        for (const id of ids) if (state) next[id] = state; else delete next[id];
        return next;
      });
    };
    try {
      const includeAttachments = options.includeAttachments ?? attachmentsDirty;
      const payload: DraftInput = {
        account_id: fromAccountId,
        to: composeForm.to,
        cc: composeForm.cc,
        bcc: composeForm.bcc,
        subject: composeForm.subject,
        body: composeForm.body || (bodyFormat === 'rich' ? '<p></p>' : ''),
        isHtml: bodyFormat === 'rich',
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
        const toUpload = composeAttachments.filter(attachment => !uploaded.has(attachment.id));
        uploading = toUpload.map(attachment => attachment.id);
        markUploads(uploading, 'uploading');
        payload.attachments = await buildAttachmentPayload(toUpload);
        if (composition !== compositionRef.current) return null;
      }

      const { draft: savedDraft, uploaded } = await saveDraft(owner.id, payload);
      owner.id = savedDraft.id;
      for (const { client_id, id } of uploaded) owner.uploaded.set(client_id, id);
      if (composition !== compositionRef.current) return savedDraft;
      const stored = new Set(uploaded.map(({ client_id }) => client_id));
      markUploads(uploading.filter(id => stored.has(id)), 'saved');
      markUploads(uploading.filter(id => !stored.has(id)), null);
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
      markUploads(uploading, 'failed');
      // A quiet save (autosave) keeps typing uninterrupted, except when the
      // draft is being sent by its schedule: the person must know their
      // edits did not reach the message.
      const beingSent = error instanceof ApiError && error.code === 'SCHEDULED_SEND_IN_PROGRESS';
      if (!options.quiet || beingSent) {
        toast({
          title: beingSent ? 'Not saved' : 'Failed to save draft',
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
    if (!isComposeMeaningful(composeForm, composeAttachments.length, existingDraftAttachments.length, bodyFormat)) return;

    const timeout = window.setTimeout(() => {
      saveCurrentDraft({ quiet: true }).catch(() => {
        // Explicit saves and sends surface errors. Autosave should not interrupt typing.
      });
    }, 1500);

    return () => window.clearTimeout(timeout);
  }, [
    bodyFormat,
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
    if (isComposeBodyEmpty(composeForm.body, bodyFormat) && composeAttachments.length === 0) {
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
        body: composeForm.body || (bodyFormat === 'rich' ? '<p></p>' : ''),
        isHtml: bodyFormat === 'rich',
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
  /**
   * Send later: the draft is saved first (the stored draft is what goes out),
   * then scheduled; the composer closes with an Undo that cancels the schedule.
   */
  const scheduleSend = async (sendAt: Date) => {
    if (!fromAccountId) {
      toast({ title: 'Please select an account', variant: 'destructive' });
      return;
    }
    if (!composeForm.to.trim() && !composeForm.cc.trim() && !composeForm.bcc.trim()) {
      toast({ title: 'Add at least one recipient', variant: 'destructive' });
      return;
    }
    if (isComposeBodyEmpty(composeForm.body, bodyFormat) && composeAttachments.length === 0 && existingDraftAttachments.length === 0) {
      toast({ title: 'Please enter a message or add an attachment', variant: 'destructive' });
      return;
    }
    const composition = compositionRef.current;
    // Saves until a save ends with nothing typed meanwhile, so what is stored
    // (and later sent) is what the composer shows when it closes.
    const saveCurrent = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = revisionRef.current;
        const saved = await saveCurrentDraft({ includeAttachments: true, quiet: true });
        if (composition !== compositionRef.current) return { closed: true as const };
        const id = saved?.id ?? draftRef.current.id;
        if (!id) throw new Error('The draft could not be saved');
        if (revision === revisionRef.current) return { id };
      }
      throw new Error('The message kept changing while it was saved. Try again.');
    };
    let draftId: string;
    try {
      const saved = await saveCurrent();
      if ('closed' in saved) {
        toast({ title: 'Not scheduled', description: 'The message was closed before it was scheduled.' });
        return;
      }
      draftId = saved.id;
    } catch (error) {
      toast({ title: 'Not scheduled', description: error instanceof Error ? error.message : 'The draft could not be saved', variant: 'destructive' });
      return;
    }
    try {
      const revision = revisionRef.current;
      const schedule = await scheduleMailDraft(draftId, sendAt);
      void invalidateMailQueries(queryClient);
      // Typed while the schedule was set: saved too (a scheduled draft can still
      // change) before the composer closes; if that fails, it stays open.
      let current = composition === compositionRef.current;
      if (current && revision !== revisionRef.current) {
        try {
          current = !('closed' in await saveCurrent());
        } catch (error) {
          current = false;
          toast({ title: 'Scheduled, but your latest changes are not saved', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
        }
      }
      if (current) closeComposeFlow({ force: true });
      const id = draftId;
      toast(scheduledSendToast(schedule.send_at, async () => {
        try {
          await cancelMailSchedule(id);
          void invalidateMailQueries(queryClient);
          toast({ title: 'Scheduled send cancelled', description: 'The message stays in Drafts.' });
        } catch (error) {
          toast({ title: 'Could not cancel the scheduled send', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
        }
      }));
    } catch (error) {
      toast({ title: 'Not scheduled', description: error instanceof Error ? error.message : 'Could not schedule the message', variant: 'destructive' });
    }
  };

  /** Cancels the open draft's scheduled send; the draft stays open. */
  const cancelScheduledSend = async () => {
    const id = draftRef.current.id ?? activeDraftId;
    if (!id) return;
    try {
      await cancelMailSchedule(id);
      setScheduledAt(null);
      void invalidateMailQueries(queryClient);
      toast({ title: 'Scheduled send cancelled', description: `Sending at ${formatWhen(scheduledAt ?? '')} is off; the message stays in Drafts.` });
    } catch (error) {
      toast({ title: 'Could not cancel the scheduled send', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
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
    isComposeOpen, openCompose: startNewMessage, composeMode, isReplying,
    composeForm, updateComposeForm, fromAccountId, setFromAccount,
    bodyFormat, switchBodyFormat, applyTemplate, saveAsTemplate, features,
    rememberRichSelection, rememberPlainSelection,
    scheduledAt, scheduleSend, cancelScheduledSend,
    focusedRecipientInput, setFocusedRecipientInput, replaceActiveRecipient, contactEmailSuggestions,
    composeAttachments, existingDraftAttachments, attachmentUploads, isAttachmentDragOver, setIsAttachmentDragOver,
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
