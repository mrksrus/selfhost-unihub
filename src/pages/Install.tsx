import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Smartphone, Monitor, Share, Plus, MoreVertical, Download } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

const Install = () => {
  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="max-w-3xl mx-auto">
        <Button variant="ghost" asChild className="mb-6">
          <Link to="/">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to App
          </Link>
        </Button>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="text-3xl font-bold text-foreground mb-2">Install UniHub</h1>
          <p className="text-muted-foreground mb-8">
            UniHub is a Progressive Web App (PWA) that can be installed on your device for quick access and offline use.
          </p>
        </motion.div>

        <div className="space-y-6">
          {/* iOS Instructions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-accent/10">
                    <Smartphone className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">iPhone / iPad (Safari)</CardTitle>
                    <CardDescription>Install on iOS devices</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ol className="space-y-4">
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">1</span>
                    <div>
                      <p className="font-medium text-foreground">Tap the Share button</p>
                      <p className="text-sm text-muted-foreground">Located at the bottom of Safari's toolbar</p>
                      <div className="mt-2 p-3 bg-muted rounded-lg inline-flex items-center gap-2">
                        <Share className="h-5 w-5 text-muted-foreground" />
                        <span className="text-sm">Share</span>
                      </div>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">2</span>
                    <div>
                      <p className="font-medium text-foreground">Scroll down and tap "Add to Home Screen"</p>
                      <div className="mt-2 p-3 bg-muted rounded-lg inline-flex items-center gap-2">
                        <Plus className="h-5 w-5 text-muted-foreground" />
                        <span className="text-sm">Add to Home Screen</span>
                      </div>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">3</span>
                    <div>
                      <p className="font-medium text-foreground">Tap "Add" to confirm</p>
                      <p className="text-sm text-muted-foreground">UniHub will appear on your home screen</p>
                    </div>
                  </li>
                </ol>
              </CardContent>
            </Card>
          </motion.div>

          {/* Android Instructions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.2 }}
          >
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-accent/10">
                    <Smartphone className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Android (Chrome)</CardTitle>
                    <CardDescription>Install on Android devices</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ol className="space-y-4">
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">1</span>
                    <div>
                      <p className="font-medium text-foreground">Tap the menu button</p>
                      <p className="text-sm text-muted-foreground">Three dots in the top right corner of Chrome</p>
                      <div className="mt-2 p-3 bg-muted rounded-lg inline-flex items-center gap-2">
                        <MoreVertical className="h-5 w-5 text-muted-foreground" />
                        <span className="text-sm">Menu</span>
                      </div>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">2</span>
                    <div>
                      <p className="font-medium text-foreground">Tap "Install app" or "Add to Home screen"</p>
                      <div className="mt-2 p-3 bg-muted rounded-lg inline-flex items-center gap-2">
                        <Download className="h-5 w-5 text-muted-foreground" />
                        <span className="text-sm">Install app</span>
                      </div>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">3</span>
                    <div>
                      <p className="font-medium text-foreground">Confirm the installation</p>
                      <p className="text-sm text-muted-foreground">UniHub will be added to your app drawer</p>
                    </div>
                  </li>
                </ol>
              </CardContent>
            </Card>
          </motion.div>

          {/* Desktop Instructions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
          >
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-accent/10">
                    <Monitor className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Desktop (Chrome, Edge, Brave)</CardTitle>
                    <CardDescription>Install on your computer</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ol className="space-y-4">
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">1</span>
                    <div>
                      <p className="font-medium text-foreground">Look for the install icon in the address bar</p>
                      <p className="text-sm text-muted-foreground">It appears on the right side of the URL bar</p>
                      <div className="mt-2 p-3 bg-muted rounded-lg inline-flex items-center gap-2">
                        <Download className="h-5 w-5 text-muted-foreground" />
                        <span className="text-sm">Install</span>
                      </div>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-sm font-medium shrink-0">2</span>
                    <div>
                      <p className="font-medium text-foreground">Click "Install" when prompted</p>
                      <p className="text-sm text-muted-foreground">UniHub will open as a standalone app window</p>
                    </div>
                  </li>
                </ol>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export default Install;
