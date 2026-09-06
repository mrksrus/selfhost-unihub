import UpdatePrompt from '@/components/pwa/UpdatePrompt';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lazy, Suspense } from "react";
import { SessionQueryProvider } from "@/components/SessionQueryProvider";
import { useAuth } from "@/contexts/useAuth";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import AppLayout from "@/components/layout/AppLayout";
import InstallPrompt from "@/components/pwa/InstallPrompt";
const Auth = lazy(() => import("./pages/Auth"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Contacts = lazy(() => import("./pages/Contacts"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const MailPage = lazy(() => import("./pages/MailPage"));
const TodoPage = lazy(() => import("./pages/TodoPage"));
const Settings = lazy(() => import("./pages/Settings"));
const AdminUsers = lazy(() => import("./pages/AdminUsers"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Games = lazy(() => import("./pages/Games"));
const Recordings = lazy(() => import("./pages/Recordings"));
const Music = lazy(() => import("./pages/Music"));
const More = lazy(() => import("./pages/More"));
const AdminSettings = lazy(() => import("./pages/AdminSettings"));
const StartRedirect = lazy(() => import("./pages/StartRedirect"));

const AuthenticatedApp = () => {
  const { user } = useAuth();
  return (
    <SessionQueryProvider key={user?.id ?? "signed-out"}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Suspense fallback={<div role="status" className="flex min-h-[40vh] items-center justify-center text-muted-foreground">Loading…</div>}>
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route element={<AppLayout />}>
              <Route path="/" element={<StartRedirect />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/todo" element={<TodoPage />} />
              <Route path="/mail" element={<MailPage />} />
              <Route path="/recordings" element={<Recordings />} />
              <Route path="/music" element={<Music />} />
              <Route path="/games" element={<Games />} />
              <Route path="/more" element={<More />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/admin/users" element={<AdminUsers />} />
              <Route path="/admin/settings" element={<AdminSettings />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          <InstallPrompt />
          <UpdatePrompt />
        </BrowserRouter>
      </TooltipProvider>
    </SessionQueryProvider>
  );
};

const App = () => <ThemeProvider><AuthProvider><AuthenticatedApp /></AuthProvider></ThemeProvider>;

export default App;
