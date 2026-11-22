import { Lock, Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCallTo, type CallPerson } from '@/components/chat/call-state';

interface Props {
  person: CallPerson | undefined;
  /** The direct chat with the person, where the button stands in one. */
  conversationId?: string;
  /** "Call back" under a call's entry; the default is "Call". */
  label?: string;
  /** In a chat's header: the handset alone. */
  icon?: boolean;
  /** Under a call's entry: without the outline, so a row of entries stays quiet. */
  quiet?: boolean;
  className?: string;
}

/** "Call": starts a voice call with the person. Greyed, it opens its reason when pressed. */
export function CallButton({ person, conversationId, label = 'Call', icon = false, quiet = false, className }: Props) {
  const call = useCallTo(person, conversationId);
  if (!call || !person) return null;
  const { reason } = call;
  const button = (
    <Button variant={icon || quiet ? 'ghost' : 'outline'} size={icon ? 'icon' : 'sm'} aria-label={icon ? `${label} ${person.name}` : undefined} aria-disabled={reason ? true : undefined} title={reason}
      className={cn(reason && 'opacity-50', className)} onClick={reason ? undefined : call.start}>
      <Phone aria-hidden="true" />{!icon && label}
    </Button>
  );
  if (!reason) return button;
  return (
    <Popover>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 items-start gap-2 p-3 text-sm">
        <Lock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />{reason}
      </PopoverContent>
    </Popover>
  );
}
