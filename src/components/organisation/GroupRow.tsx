import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

/** A group in a list: the whole row opens it. Name and description on the left, its numbers on the right. */
export function GroupRow({ to, name, description, meta }: { to: string; name: string; description?: ReactNode; meta: ReactNode }) {
  return (
    <li>
      <Link to={to} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-3.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{name}</span>
          {description && <span className="block truncate text-sm text-muted-foreground">{description}</span>}
        </span>
        {/* Under the name on a phone, beside it from there up. */}
        <span className="row-start-2 text-xs text-muted-foreground sm:col-start-2 sm:row-start-1 sm:text-sm">{meta}</span>
        <ChevronRight aria-hidden="true" className="col-start-2 row-span-2 row-start-1 h-4 w-4 text-muted-foreground sm:col-start-3 sm:row-span-1" />
      </Link>
    </li>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "5 members, 1 manager, own rules". */
export function groupMeta(group: { member_count: number; manager_count: number; has_policies: boolean }) {
  return [plural(group.member_count, 'member', 'members'), group.manager_count ? plural(group.manager_count, 'manager', 'managers') : 'no manager', group.has_policies ? 'own rules' : null].filter(Boolean).join(', ');
}
