import type { Permission } from '../../api/src/contracts/organisation';
import type { User } from '@/contexts/auth-context';

/** Whether the signed-in person's role grants `permission`; the server decides, the page only shows. */
export function can(user: Pick<User, 'permissions'> | null | undefined, permission: Permission): boolean {
  return !!user?.permissions?.includes(permission);
}
