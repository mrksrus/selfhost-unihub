import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { noteResponse, notePath, downloadNoteFile, type Note, type NoteDetail } from '@/lib/notes-api';
import { emptyNoteDraft, noteDraftDirty, useNoteDraft } from '@/hooks/use-note-draft';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

export default function Notes() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { draft, setDraft, busy, setBusy } = useNoteDraft();
  const [query, setQuery] = useState('');
  const [trash, setTrash] = useState(false);
  const [editing, setEditing] = useState(!!draft.detail || noteDraftDirty(draft));
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const dirty = noteDraftDirty(draft);
  const search = useDebouncedValue(query, 200);
  const { data: notes = [], isPending, error: listError } = useQuery({ queryKey: ['notes', search, trash], queryFn: async ({ signal }) => (await noteResponse(api.get<{ notes: Note[] }>(`/notes?q=${encodeURIComponent(search)}&trash=${trash}`, { signal }))).notes });
  const apply = (detail: NoteDetail) => { setDraft({ detail, title: detail.note.title, body: detail.note.body, links: detail.links.map(link => link.id) }); setConflict(false); setEditing(true); };
  const allowDiscard = () => !dirty || window.confirm('Discard the unsaved changes to this note?');
  const openNote = async (id: string) => {
    if (busy || !allowDiscard()) return;
    const current = ++generation.current;
    setBusy(true); setError('');
    try { const detail = await noteResponse(api.get<NoteDetail>(notePath(id))); if (current === generation.current) { apply(detail); setParams({ note: id }, { replace: true }); } }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not load note.'); }
    finally { setBusy(false); }
  };
  useEffect(() => () => { ++generation.current; }, []);
  const requestedNote = params.get('note');
  useEffect(() => {
    // A retained unsaved draft always takes precedence over an incoming search link.
    if (requestedNote && requestedNote !== draft.detail?.note.id && !dirty) void openNote(requestedNote);
    else if (requestedNote && requestedNote !== draft.detail?.note.id && dirty) setNotice('Your unsaved draft was kept. Save it or start a new note before opening another note.');
    // Re-run only for actual navigation, not edits to the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedNote]);
  const mutate = async (request: () => Promise<NoteDetail>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const detail = await request(); apply(detail); setParams({ note: detail.note.id }, { replace: true }); setNotice('Saved.'); await client.invalidateQueries({ queryKey: ['notes'] }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save note.'); setConflict((error as { status?: number }).status === 409); }
    finally { setBusy(false); }
  };
  const save = () => mutate(() => noteResponse(draft.detail ? api.put<NoteDetail>(notePath(draft.detail.note.id), { title: draft.title, body: draft.body, linked_note_ids: draft.links, expected_revision: draft.detail.note.revision }) : api.post<NoteDetail>('/notes', { title: draft.title, body: draft.body, linked_note_ids: draft.links })));
  const download = async (path: string, name: string) => { try { await downloadNoteFile(path, name); } catch (error) { setError(error instanceof Error ? error.message : 'Download failed.'); } };
  const upload = async (file?: File) => {
    if (!file || !draft.detail || dirty || busy) return;
    if (file.size > 2 * 1024 * 1024 || file.size === 0) { setError('Choose a nonempty attachment up to 2 MiB.'); return; }
    const detail = draft.detail;
    await mutate(async () => {
      const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read attachment.')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
      return noteResponse(api.post<NoteDetail>(`${notePath(detail.note.id)}/attachments`, { filename: file.name, content_type: file.type || 'application/octet-stream', content_base64: content, expected_revision: detail.note.revision }));
    });
  };
  const saved = draft.detail;
  return <div className="flex min-h-full flex-col"><header className="border-b p-4 sm:p-6"><h1 className="text-2xl font-semibold">Notes</h1><p className="mt-1 text-sm text-muted-foreground">Plain text and Markdown. Online access required. Unsaved drafts stay in this session when you change pages; save before signing out.</p></header>
    <div className="flex flex-1 min-h-0 flex-col md:flex-row">
      <aside className={`${editing ? 'hidden md:block' : ''} w-full md:w-72 shrink-0 border-r p-4 space-y-3`} aria-label="Notes list">
        <Button className="w-full" disabled={busy} onClick={() => { if (allowDiscard()) { setDraft(emptyNoteDraft()); setEditing(true); setParams({}, { replace: true }); setError(''); setConflict(false); } }}>New note</Button>
        <Input aria-label="Search notes" placeholder="Search notes" value={query} onChange={event => setQuery(event.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={trash} onChange={event => setTrash(event.target.checked)} />Show trash</label>
        {isPending && <p role="status">Loading notes…</p>}{listError && <p role="alert">{listError.message}</p>}
        {!isPending && notes.length === 0 && <p className="text-sm text-muted-foreground">{trash ? 'No notes in trash.' : 'No notes found. Create a note to get started.'}</p>}
        <ul className="divide-y">{notes.map(note => <li key={note.id}><button className="w-full text-left py-3 px-2 rounded focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted" aria-current={saved?.note.id === note.id ? 'page' : undefined} disabled={busy} onClick={() => void openNote(note.id)}><span className="block truncate font-medium">{note.title || 'Untitled note'}</span><span className="text-xs text-muted-foreground">Revision {note.revision}</span></button></li>)}</ul>
      </aside>
      <section className={`${editing ? '' : 'hidden md:block'} flex-1 min-w-0 p-4 sm:p-6 space-y-4`} aria-label="Note editor">
        <Button className="md:hidden" variant="outline" onClick={() => setEditing(false)}>Back to notes</Button>
        {error && <div role="alert" className="border p-3 space-y-2"><p>{error}</p>{conflict && <><p>Your draft is unchanged. Copy it before reloading to compare with the saved version.</p><Button variant="outline" disabled={busy} onClick={() => saved && void openNote(saved.note.id)}>Reload saved note</Button></>}</div>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {editing ? <><div className="flex flex-wrap gap-2 items-center"><Button disabled={busy || !!saved?.note.trashed_at || !draft.title.trim()} onClick={() => void save()}>{busy ? 'Working…' : 'Save note'}</Button><span className="text-sm text-muted-foreground">{dirty ? 'Unsaved changes' : saved ? `Saved revision ${saved.note.revision}` : 'New note'}</span>{saved && <><Button variant="outline" disabled={busy || dirty} onClick={() => void download(`${notePath(saved.note.id)}/export`, 'note.md')}>Download Markdown</Button><Button variant="outline" disabled={busy || dirty} onClick={() => { if (saved.note.trashed_at) void mutate(() => noteResponse(api.post<NoteDetail>(`${notePath(saved.note.id)}/restore`, { expected_revision: saved.note.revision }))); else if (window.confirm('Move this note to trash? Its revision history is retained.')) void mutate(() => noteResponse(api.delete<NoteDetail>(notePath(saved.note.id), { expected_revision: saved.note.revision }))); }}>{saved.note.trashed_at ? 'Restore from trash' : 'Move to trash'}</Button></>}</div>
          {saved?.note.trashed_at && <p>This note is in trash. Restore it to edit.</p>}
          <fieldset disabled={busy || !!saved?.note.trashed_at} className="space-y-4"><div><Label htmlFor="note-title">Title</Label><Input id="note-title" value={draft.title} maxLength={255} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /></div><div><Label htmlFor="note-body">Text or Markdown</Label><Textarea id="note-body" className="min-h-[40dvh] leading-relaxed" value={draft.body} onChange={event => setDraft(current => ({ ...current, body: event.target.value }))} /></div>
          <details><summary className="cursor-pointer font-medium">Linked notes ({draft.links.length})</summary><p className="text-sm text-muted-foreground my-2">Choose notes from the current list. Links are saved with the note.</p>{saved?.links.filter(link => !notes.some(note => note.id === link.id)).map(link => <label key={link.id} className="flex items-center gap-2 py-1"><input type="checkbox" checked={draft.links.includes(link.id)} onChange={event => setDraft(current => ({ ...current, links: event.target.checked ? [...current.links, link.id] : current.links.filter(id => id !== link.id) }))} />{link.title}</label>)}{notes.filter(note => note.id !== saved?.note.id && !note.trashed_at).map(note => <label key={note.id} className="flex items-center gap-2 py-1"><input type="checkbox" checked={draft.links.includes(note.id)} onChange={event => setDraft(current => ({ ...current, links: event.target.checked ? [...current.links, note.id] : current.links.filter(id => id !== note.id) }))} />{note.title}</label>)}</details></fieldset>
          {saved && <>{saved.links.length > 0 && <nav aria-label="Linked notes" className="flex flex-wrap gap-2">{saved.links.map(link => <Button key={link.id} variant="link" disabled={busy} onClick={() => void openNote(link.id)}>{link.title}</Button>)}</nav>}<section className="border-t pt-4 space-y-3"><h2 className="font-medium">Attachments</h2><p className="text-sm text-muted-foreground">Save text changes before adding or removing files. Maximum attachment size: 2 MiB.</p><Input aria-label="Attach a file" type="file" disabled={busy || dirty || !!saved.note.trashed_at} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} /><ul className="divide-y">{saved.attachments.map(file => <li key={file.id} className="flex flex-wrap items-center gap-2 py-2"><Button variant="link" onClick={() => void download(`${notePath(saved.note.id)}/attachments/${encodeURIComponent(file.id)}/download`, file.filename)}>{file.filename}</Button><span className="text-xs text-muted-foreground">{file.size_bytes.toLocaleString()} bytes</span><Button size="sm" variant="outline" disabled={busy || dirty || !!saved.note.trashed_at} onClick={() => { if (window.confirm(`Remove ${file.filename}?`)) void mutate(() => noteResponse(api.delete<NoteDetail>(`${notePath(saved.note.id)}/attachments/${encodeURIComponent(file.id)}`, { expected_revision: saved.note.revision }))); }}>Remove</Button></li>)}</ul></section>
          <details className="border-t pt-4"><summary className="font-medium cursor-pointer">Revision history ({saved.revisions.length})</summary><p className="text-sm text-muted-foreground py-2">Restoring text creates a new revision. Current attachments and links stay in place.</p>{saved.revisions.map(revision => <details key={revision.revision} className="border-b py-2"><summary className="cursor-pointer">Revision {revision.revision}: {revision.title}</summary><p className="text-sm text-muted-foreground py-2">{new Date(revision.created_at).toLocaleString()}</p><Button size="sm" variant="outline" disabled={busy || dirty || !!saved.note.trashed_at || revision.revision === saved.note.revision} onClick={() => { if (window.confirm(`Restore text from revision ${revision.revision}?`)) void mutate(() => noteResponse(api.post<NoteDetail>(`${notePath(saved.note.id)}/revisions/${revision.revision}/restore`, { expected_revision: saved.note.revision }))); }}>Restore this text</Button></details>)}</details></>}
        </> : <p className="text-muted-foreground">Choose a note or create a new one.</p>}
      </section>
    </div>
  </div>;
}
