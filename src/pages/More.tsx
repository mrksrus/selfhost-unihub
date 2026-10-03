import { useModules } from '@/hooks/use-modules';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LayoutDashboard, Music2, Settings, Shield } from 'lucide-react';
import { BOTTOM_NAV_PAGES, orderedModulePages } from '@/lib/navigation';

const More = () => {
  const { modules, canNavigate } = useModules();
  const { user } = useAuth();
  const links = [
    // Module pages that do not fit in the mobile bar, in the user's order.
    ...orderedModulePages(modules, canNavigate).slice(BOTTOM_NAV_PAGES).map(page => ({ title: page.name, description: page.description, href: page.href, icon: page.icon })),
    { title: 'Music', description: 'Music recordings and chord notes', href: '/music', icon: Music2 },
    { title: 'Dashboard', description: 'Legacy overview page', href: '/dashboard', icon: LayoutDashboard },
    { title: 'Settings', description: 'Profile, preferences, security, and data', href: '/settings', icon: Settings },
  ];

  if (user?.role === 'admin') {
    links.push({ title: 'Admin Settings', description: 'Signup mode and admin-only configuration', href: '/admin/settings', icon: Shield });
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">More</h1>
        <p className="text-muted-foreground">Secondary modules and account-level tools</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {links.filter(item => canNavigate(item.href)).map((item) => (
          <Card key={item.href}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-accent/10">
                  <item.icon className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">{item.title}</CardTitle>
                  <CardDescription>{item.description}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link to={item.href}>Open</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default More;
