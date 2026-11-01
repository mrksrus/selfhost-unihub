import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { fetchPublicSignupMode } from '@/lib/auth-api';
import type { SignupMode } from '@/lib/admin-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Lock } from 'lucide-react';
import { z } from 'zod';

const emailSchema = z.email('Please enter a valid email address');
const passwordSchema = z.string().min(12, 'Password must be at least 12 characters');

const Auth = () => {
  const { user, signIn, signUp, verifyTwoFactorLogin, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [twoFactorChallengeToken, setTwoFactorChallengeToken] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [signupMode, setSignupMode] = useState<SignupMode>('disabled');

  useEffect(() => {
    if (user) {
      navigate('/');
    }
  }, [user, navigate]);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicSignupMode().then(mode => {
      if (!cancelled) setSignupMode(mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const validateForm = () => {
    const newErrors: { email?: string; password?: string } = {};
    
    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      newErrors.email = emailResult.error.issues[0].message;
    }
    
    const passwordResult = passwordSchema.safeParse(password);
    if (!passwordResult.success) {
      newErrors.password = passwordResult.error.issues[0].message;
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;
    
    setLoading(true);
    const { error, requires2fa, challengeToken } = await signIn(email, password);
    setLoading(false);
    
    if (error) {
      toast({
        title: 'Sign in failed',
        description: error.message === 'Invalid login credentials' 
          ? 'Invalid email or password. Please try again.'
          : error.message,
        variant: 'destructive',
      });
    } else if (requires2fa && challengeToken) {
      setTwoFactorChallengeToken(challengeToken);
      setTwoFactorCode('');
    }
  };

  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactorChallengeToken) return;

    setLoading(true);
    const { error, usedRecoveryCode, recoveryCodesRemaining } = await verifyTwoFactorLogin(twoFactorChallengeToken, twoFactorCode);
    setLoading(false);

    if (error) {
      toast({
        title: 'Verification failed',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    if (usedRecoveryCode) {
      toast({
        title: 'Recovery code used',
        description: `${recoveryCodesRemaining ?? 0} recovery codes remain. Generate new ones from Settings soon.`,
      });
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signupMode === 'disabled') {
      toast({
        title: 'Signups are disabled',
        description: 'Contact an administrator if you need an account.',
        variant: 'destructive',
      });
      return;
    }
    if (!validateForm()) return;
    
    setLoading(true);
    const { error, requiresApproval } = await signUp(email, password, fullName);
    setLoading(false);
    
    if (error) {
      let message = error.message;
      if (error.message.includes('already registered') || error.message.includes('already exists')) {
        message = 'This email is already registered. Please sign in instead.';
      } else if (error.message.includes('Signups are currently disabled')) {
        message = 'Signups are currently disabled. Contact an administrator if you need an account.';
      }
      toast({
        title: error.message.includes('Signups are currently disabled') ? 'Signups are disabled' : 'Sign up failed',
        description: message,
        variant: 'destructive',
      });
    } else if (requiresApproval) {
      toast({
        title: 'Account created',
        description: 'Your account is pending admin approval. You will be able to sign in once an administrator activates your account.',
        duration: 8000,
      });
      // Clear form
      setEmail('');
      setPassword('');
      setFullName('');
    } else {
      toast({
        title: 'Account created',
        description: "You're signed in. Welcome!",
      });
    }
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent text-lg font-semibold text-accent-foreground">U</span>
          <h1 className="text-2xl font-semibold tracking-tight">UniHub</h1>
        </div>
          <Card>
            <CardContent className="pt-6">
              <Tabs defaultValue="signin" className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-6">
                  <TabsTrigger value="signin">Sign in</TabsTrigger>
                  <TabsTrigger value="signup">Create account</TabsTrigger>
                </TabsList>
                
                <TabsContent value="signin">
                  {twoFactorChallengeToken ? (
                    <form onSubmit={handleTwoFactorSubmit} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="signin-2fa">Authentication code</Label>
                        <Input
                          id="signin-2fa"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="123456 or recovery code"
                          value={twoFactorCode}
                          onChange={(e) => setTwoFactorCode(e.target.value)}
                          required
                        />
                        <p className="text-xs text-muted-foreground">
                          Enter the 6-digit code from your authenticator app, or one unused recovery code.
                        </p>
                      </div>
                      <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Verifying...
                          </>
                        ) : (
                          'Verify and sign in'
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full"
                        onClick={() => {
                          setTwoFactorChallengeToken(null);
                          setTwoFactorCode('');
                        }}
                      >
                        Use a different account
                      </Button>
                    </form>
                  ) : (
                    <form onSubmit={handleSignIn} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="signin-email">Email</Label>
                      <Input
                        id="signin-email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={errors.email ? 'border-destructive' : ''}
                        required
                      />
                      {errors.email && (
                        <p className="text-sm text-destructive">{errors.email}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signin-password">Password</Label>
                      <Input
                        id="signin-password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className={errors.password ? 'border-destructive' : ''}
                        required
                      />
                      {errors.password && (
                        <p className="text-sm text-destructive">{errors.password}</p>
                      )}
                    </div>
                    <Button type="submit" className="w-full" disabled={loading}>
                      {loading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Signing in…
                        </>
                      ) : (
                        'Sign in'
                      )}
                    </Button>
                    </form>
                  )}
                </TabsContent>
                
                <TabsContent value="signup">
                  <form onSubmit={handleSignUp} className="space-y-4">
                    {signupMode === 'disabled' && (
                      <Alert>
                        <Lock className="h-4 w-4" />
                        <AlertDescription>
                          New account signups are currently disabled. Contact an administrator if you need access.
                        </AlertDescription>
                      </Alert>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="signup-name">Full name</Label>
                      <Input
                        id="signup-name"
                        type="text"
                        placeholder="John Doe"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        disabled={signupMode === 'disabled'}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signup-email">Email</Label>
                      <Input
                        id="signup-email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={errors.email ? 'border-destructive' : ''}
                        disabled={signupMode === 'disabled'}
                        required
                      />
                      {errors.email && (
                        <p className="text-sm text-destructive">{errors.email}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signup-password">Password</Label>
                      <Input
                        id="signup-password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className={errors.password ? 'border-destructive' : ''}
                        disabled={signupMode === 'disabled'}
                        required
                      />
                      {errors.password && (
                        <p className="text-sm text-destructive">{errors.password}</p>
                      )}
                    </div>
                    <Button type="submit" className="w-full" disabled={loading || signupMode === 'disabled'}>
                      {loading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Creating account…
                        </>
                      ) : (
                        'Create account'
                      )}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
      </div>
    </div>
  );
};

export default Auth;
