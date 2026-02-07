import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import AppSidebar from './AppSidebar';
import MobileHeader from './MobileHeader';
import BottomNav from './BottomNav';
import { Loader2 } from 'lucide-react';

const AppLayout = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-background">
      <div className="hidden md:block">
        <AppSidebar />
      </div>
      <MobileHeader />
      <main className="flex-1 overflow-auto w-full pb-mobile-nav md:pb-0 min-w-0">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
};

export default AppLayout;
