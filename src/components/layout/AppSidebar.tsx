import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { 
  LayoutDashboard, 
  Users, 
  Calendar, 
  Mail, 
  Settings, 
  Shield,
  LogOut,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Contacts', href: '/contacts', icon: Users },
  { name: 'Calendar', href: '/calendar', icon: Calendar },
  { name: 'Mail', href: '/mail', icon: Mail },
];

const AppSidebar = () => {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const userInitials = user?.full_name
    ?.split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase() || user?.email?.[0].toUpperCase() || '?';

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 80 : 280 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col h-screen bg-sidebar border-r border-sidebar-border"
    >
      {/* Logo */}
      <div className="flex items-center justify-between h-16 px-4">
        <AnimatePresence mode="wait">
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex items-center gap-2"
            >
              <div className="w-8 h-8 rounded-lg bg-gradient-accent flex items-center justify-center">
                <span className="text-sidebar-primary-foreground font-bold text-sm">U</span>
              </div>
              <span className="font-semibold text-lg text-sidebar-foreground">UniHub</span>
            </motion.div>
          )}
        </AnimatePresence>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCollapsed(!collapsed)}
          className="text-sidebar-foreground hover:bg-sidebar-accent"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = location.pathname === item.href;
          return (
            <NavLink
              key={item.name}
              to={item.href}
              className={cn(
                'sidebar-nav-item',
                isActive && 'active'
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              <AnimatePresence mode="wait">
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 'auto' }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.15 }}
                    className="whitespace-nowrap"
                  >
                    {item.name}
                  </motion.span>
                )}
              </AnimatePresence>
            </NavLink>
          );
        })}
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Settings & Admin */}
      <div className="p-3 space-y-1">
        <NavLink
          to="/settings"
          className={cn(
            'sidebar-nav-item',
            location.pathname === '/settings' && 'active'
          )}
        >
          <Settings className="h-5 w-5 shrink-0" />
          <AnimatePresence mode="wait">
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.15 }}
                className="whitespace-nowrap"
              >
                Settings
              </motion.span>
            )}
          </AnimatePresence>
        </NavLink>
        {user?.role === 'admin' && (
          <NavLink
            to="/admin/users"
            className={cn(
              'sidebar-nav-item',
              location.pathname === '/admin/users' && 'active'
            )}
          >
            <Shield className="h-5 w-5 shrink-0" />
            <AnimatePresence mode="wait">
              {!collapsed && (
                <motion.span
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.15 }}
                  className="whitespace-nowrap"
                >
                  Admin
                </motion.span>
              )}
            </AnimatePresence>
          </NavLink>
        )}
      </div>

      <Separator className="bg-sidebar-border" />

      {/* User Profile */}
      <div className="p-3">
        <div className={cn(
          'flex items-center gap-3 p-2 rounded-lg',
          collapsed ? 'justify-center' : ''
        )}>
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarImage src={user?.avatar_url} />
            <AvatarFallback className="bg-sidebar-accent text-sidebar-foreground text-sm">
              {userInitials}
            </AvatarFallback>
          </Avatar>
          <AnimatePresence mode="wait">
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.15 }}
                className="flex-1 min-w-0"
              >
                <p className="text-sm font-medium text-sidebar-foreground truncate">
                  {user?.full_name || 'User'}
                </p>
                <p className="text-xs text-sidebar-foreground/60 truncate">
                  {user?.email}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence mode="wait">
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={signOut}
                  className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent shrink-0"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.aside>
  );
};

export default AppSidebar;
