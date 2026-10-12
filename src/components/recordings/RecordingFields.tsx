import { recordingCategories, recordingCategoryLabels, type RecordingCategory } from '@/lib/recordings-api';
import type { RecordingDetailsForm } from '@/lib/recording-format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Name, tags, category, date, description and (for music) chords of a recording. */
export function RecordingFields({ id, value, onChange }: { id: string; value: RecordingDetailsForm; onChange: (value: RecordingDetailsForm) => void }) {
  const set = <K extends keyof RecordingDetailsForm>(key: K, next: RecordingDetailsForm[K]) => onChange({ ...value, [key]: next });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${id}-title`}>Name</Label>
        <Input id={`${id}-title`} value={value.title} onChange={event => set('title', event.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-tags`}>Tags</Label>
        <Input id={`${id}-tags`} value={value.tags} onChange={event => set('tags', event.target.value)} placeholder="meeting, idea" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-category`}>Category</Label>
        <Select value={value.category} onValueChange={next => set('category', next as RecordingCategory)}>
          <SelectTrigger id={`${id}-category`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {recordingCategories.map(item => <SelectItem key={item} value={item}>{recordingCategoryLabels[item]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-recorded-at`}>Recorded</Label>
        <Input id={`${id}-recorded-at`} type="datetime-local" value={value.recordedAt} onChange={event => set('recordedAt', event.target.value)} />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={`${id}-description`}>Description</Label>
        <Textarea id={`${id}-description`} rows={3} value={value.description} onChange={event => set('description', event.target.value)} />
      </div>
      {value.category === 'music' && (
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={`${id}-chords`}>Chords</Label>
          <Textarea id={`${id}-chords`} rows={4} className="font-mono" value={value.chords} onChange={event => set('chords', event.target.value)} placeholder="C  G  Am  F" />
        </div>
      )}
    </div>
  );
}
