import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Menu, Settings, Shield, LogOut } from 'lucide-react';

const MobileHeader = () => {
  const { user, signOut } = useAuth();

  return (
    <header className="md:hidden sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card px-4 pt-[env(safe-area-inset-top,0)]">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-gradient-accent flex items-center justify-center">
          <span className="text-accent-foreground font-bold text-sm">U</span>
        </div>
        <span className="font-semibold text-lg text-foreground">UniHub</span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="text-foreground">
            <Menu className="h-6 w-6" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem asChild>
            <Link to="/settings" className="flex items-center gap-2 cursor-pointer">
              <Settings className="h-4 w-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          {user?.role === 'admin' && (
            <DropdownMenuItem asChild>
              <Link to="/admin/users" className="flex items-center gap-2 cursor-pointer">
                <Shield className="h-4 w-4" />
                Admin
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={signOut}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
};

export default MobileHeader;
