import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LayoutDashboard, Gamepad2, Music2, Users, Settings, Shield } from 'lucide-react';

const More = () => {
  const { user } = useAuth();
  const links = [
    { title: 'Music', description: 'Music recordings and chord notes', href: '/music', icon: Music2 },
    { title: 'Contacts', description: 'People, phone numbers, and email addresses', href: '/contacts', icon: Users },
    { title: 'Games', description: 'Small extras and future modules', href: '/games', icon: Gamepad2 },
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
        {links.map((item) => (
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
