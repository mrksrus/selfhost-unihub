import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, Calendar, Mail, Plus, ArrowRight, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { format } from 'date-fns';

const Dashboard = () => {
  const { user } = useAuth();
  const firstName = user?.full_name?.split(' ')[0] || 'there';

  // Fetch stats
  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => {
      const response = await api.get<{ contacts: number; upcomingEvents: number; unreadEmails: number }>('/stats');
      if (response.error) throw new Error(response.error);
      return response.data || { contacts: 0, upcomingEvents: 0, unreadEmails: 0 };
    },
  });

  // Fetch upcoming events
  const { data: upcomingEvents = [] } = useQuery({
    queryKey: ['upcoming-events'],
    queryFn: async () => {
      const response = await api.get<{ events: any[] }>('/calendar/events');
      if (response.error) throw new Error(response.error);
      const events = response.data?.events || [];
      return events
        .filter((e: any) => new Date(e.start_time) >= new Date())
        .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
        .slice(0, 3);
    },
  });

  // Fetch mail accounts count
  const { data: mailAccountsCount = 0 } = useQuery({
    queryKey: ['mail-accounts-count'],
    queryFn: async () => {
      const response = await api.get<{ accounts: any[] }>('/mail/accounts');
      if (response.error) throw new Error(response.error);
      return response.data?.accounts?.length || 0;
    },
  });

  const contactsCount = stats?.contacts || 0;
  const unreadCount = stats?.unreadEmails || 0;

  const modules = [
    {
      name: 'Contacts',
      description: 'Manage your contacts',
      icon: Users,
      href: '/contacts',
      stat: `${contactsCount} contacts`,
      color: 'contacts',
      cardClass: 'module-card-contacts',
    },
    {
      name: 'Calendar',
      description: 'Schedule and organize',
      icon: Calendar,
      href: '/calendar',
      stat: `${upcomingEvents.length} upcoming events`,
      color: 'calendar',
      cardClass: 'module-card-calendar',
    },
    {
      name: 'Mail',
      description: 'Unified inbox',
      icon: Mail,
      href: '/mail',
      stat: unreadCount > 0 ? `${unreadCount} unread` : `${mailAccountsCount} accounts`,
      color: 'mail',
      cardClass: 'module-card-mail',
    },
  ];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-8"
      >
        <h1 className="text-3xl font-bold text-foreground">
          Good {getTimeOfDay()}, {firstName}!
        </h1>
        <p className="text-muted-foreground mt-1">
          Here's an overview of your productivity hub.
        </p>
      </motion.div>

      {/* Module Cards */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8"
      >
        {modules.map((module) => (
          <motion.div key={module.name} variants={itemVariants}>
            <Link to={module.href} className="block">
              <Card className={module.cardClass}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className={`p-2.5 rounded-xl bg-${module.color}/10`}>
                      <module.icon className={`h-6 w-6 text-${module.color}`} />
                    </div>
                    <ArrowRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent>
                  <CardTitle className="text-xl mb-1">{module.name}</CardTitle>
                  <CardDescription>{module.description}</CardDescription>
                  <p className="mt-4 text-sm font-medium text-foreground">{module.stat}</p>
                </CardContent>
              </Card>
            </Link>
          </motion.div>
        ))}
      </motion.div>

      {/* Quick Actions & Upcoming */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quick Actions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button asChild variant="outline" className="w-full justify-start">
                <Link to="/contacts?action=new">
                  <Plus className="h-4 w-4 mr-2" />
                  Add New Contact
                </Link>
              </Button>
              <Button asChild variant="outline" className="w-full justify-start">
                <Link to="/calendar?action=new">
                  <Plus className="h-4 w-4 mr-2" />
                  Create Event
                </Link>
              </Button>
              <Button asChild variant="outline" className="w-full justify-start">
                <Link to="/mail?action=compose">
                  <Plus className="h-4 w-4 mr-2" />
                  Compose Email
                </Link>
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Upcoming Events */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Upcoming Events</CardTitle>
            </CardHeader>
            <CardContent>
              {upcomingEvents.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <Calendar className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p>No upcoming events</p>
                  <Button asChild variant="link" className="mt-2">
                    <Link to="/calendar?action=new">Create your first event</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {upcomingEvents.map((event: any) => (
                    <div key={event.id} className="flex items-start gap-3">
                      <div 
                        className="w-1 h-12 rounded-full" 
                        style={{ backgroundColor: event.color || 'hsl(var(--calendar-color))' }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground truncate">{event.title}</p>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Clock className="h-3.5 w-3.5" />
                          <span>
                            {format(new Date(event.start_time), 'dd/MM/yyyy HH:mm')}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
};

const getTimeOfDay = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
};

export default Dashboard;
