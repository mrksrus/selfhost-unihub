import { useEffect, useState } from 'react';
import { contactInitials, contactPhotoUrl, type Contact } from '@/lib/contacts-api';
import { cn } from '@/lib/utils';

type Size = 'row' | 'detail' | 'editor';

const SIZES: Record<Size, string> = {
  row: 'h-9 w-9 text-xs touch:h-10 touch:w-10',
  detail: 'h-20 w-20 text-2xl',
  editor: 'h-16 w-16 text-xl',
};

/**
 * The contact's photo, or its initials in a muted circle. The thumbnail loads
 * lazily; a picture that cannot be loaded (no photo route yet, a swept file)
 * falls back to the initials without a broken image.
 */
export function ContactAvatar({ contact, size = 'row', className, src }: {
  contact: Pick<Contact, 'id' | 'photo' | 'display_name' | 'name' | 'emails' | 'phones'>; size?: Size; className?: string;
  /** A picture chosen in the editor, shown before it is saved. */
  src?: string | null;
}) {
  const url = src ?? contactPhotoUrl(contact, size === 'row' ? 'thumb' : 'full');
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { setFailed(null); }, [url]);
  const showPhoto = url && failed !== url;
  return (
    <span aria-hidden="true" className={cn('flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground', SIZES[size], className)}>
      {showPhoto
        ? <img src={url} alt="" loading={size === 'row' ? 'lazy' : 'eager'} decoding="async" className="h-full w-full object-cover" onError={() => setFailed(url)} />
        : contactInitials(contact)}
    </span>
  );
}
