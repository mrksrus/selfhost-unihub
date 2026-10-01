import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { mailQueryKeys, type MailAccount } from '@/lib/mail-api';
import { isOfflineMode } from '@/lib/offline';
import { useToast } from '@/hooks/use-toast';
import { useServerEventsConnected } from '@/hooks/use-server-events';
import { LIVE_POLL_MS } from '@/lib/server-events';

export interface MailSyncJob {
  account_id: string;
  job_id?: string | null;
  state: 'queued' | 'running' | 'idle' | 'error' | 'cancelled' | 'paused';
  coverage?: Partial<Record<'recent' | 'history' | 'flags' | 'bodies', { complete?: boolean; current?: boolean; updated_at?: string | null } | null>>;
  cancellation_requested?: boolean;
  phase: string | null;
  processed: number;
  total: number | null;
  started_at: string | null;
  updated_at: string | null;
  error: string | null;
}

interface MailSyncAcceptance {
  success: boolean;
  started: boolean;
  alreadyRunning: boolean;
  account_id: string;
  message: string;
}

const key = ['mail-sync-jobs'] as const;
const active = (job: MailSyncJob) => job.state === 'queued' || job.state === 'running';

export function useMailSyncJobs(accounts: MailAccount[]) {
  const client = useQueryClient();
  const { toast } = useToast();
  const requested = useRef(new Set<string>());
  const cancellationRequested = useRef(new Set<string>());
  const previous = useRef<Map<string, MailSyncJob>>(new Map());
  const lastProgressRefresh = useRef(0);
  const requests = useRef(new Set<string>());
  const [syncingAccountIds, setSyncingAccountIds] = useState(new Set<string>());
  const cancellations = useRef(new Set<string>());
  const [cancellingAccountIds, setCancellingAccountIds] = useState(new Set<string>());
  const live = useServerEventsConnected();
  const jobs = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const response = await api.get<{ accounts: MailSyncJob[] }>('/mail/sync/status', { signal });
      if (response.error) throw new Error(response.error);
      if (!Array.isArray(response.data?.accounts)) throw new Error('Invalid mail sync status response');
      return response.data.accounts;
    },
    enabled: accounts.length > 0 && !isOfflineMode(),
    retry: false,
    // Discover jobs started by the scheduler or another device, even after an
    // idle response. Errors also retain this bounded recovery cadence. While
    // the live stream is connected, its job events trigger the refetches and
    // this interval is only a safety net.
    refetchInterval: query => live ? LIVE_POLL_MS.syncJobs : query.state.data?.some(active) ? 3000 : 30000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!jobs.data) return;
    let progressAdvanced = false;
    for (const job of jobs.data) {
      const old = previous.current.get(job.account_id);
      if (active(job) && job.processed > 0 && (!old || old.phase !== job.phase || job.processed > old.processed)) {
        progressAdvanced = true;
      }
      if (old && active(old) && !active(job)) {
        const userRequested = requested.current.has(job.account_id);
        if (job.state === 'error' || job.state === 'cancelled' || (job.state === 'idle' && job.coverage?.history?.complete === true && job.coverage?.recent?.current === true)) requested.current.delete(job.account_id);
        const cancelledByUser = cancellationRequested.current.delete(job.account_id);
        if (job.state === 'cancelled' && (userRequested || cancelledByUser)) {
          toast({ title: 'Mail sync cancelled', description: accounts.find(a => a.id === job.account_id)?.email_address });
        } else if (userRequested && job.state === 'idle' && job.coverage?.history?.complete === true && job.coverage?.recent?.current === true) {
          toast({ title: 'Mail sync coverage current', description: accounts.find(a => a.id === job.account_id)?.email_address });
        } else if (userRequested && job.state === 'error') {
          toast({ title: 'Mail sync failed', description: job.error || 'Check the account and try again.', variant: 'destructive' });
        }
        // A stopped job may have committed new mail, but does not imply all
        // streams or all historical messages were covered.
        void client.invalidateQueries({ queryKey: mailQueryKeys.all });
      }
    }
    // Long imports publish durable messages before the job finishes. Refresh
    // lists at most once per ten seconds of actual progress, not every poll;
    // leave the open reader and unrelated account/folder queries alone.
    if (progressAdvanced && Date.now() - lastProgressRefresh.current >= 10000) {
      lastProgressRefresh.current = Date.now();
      void client.invalidateQueries({ queryKey: mailQueryKeys.all });
    }
    previous.current = new Map(jobs.data.map(job => [job.account_id, job]));
  }, [jobs.data, accounts, client, toast]);

  const sync = useMutation({
    mutationFn: async (account_id: string) => {
      const response = await api.post<MailSyncAcceptance>('/mail/sync', { account_id });
      if (response.error) throw new Error(response.error);
      const data = response.data;
      if (!data?.success || data.account_id !== account_id || (data.started !== true && data.alreadyRunning !== true)) {
        throw new Error('The server did not confirm that this account was queued for sync.');
      }
      return data;
    },
    retry: false,
    onSuccess: data => {
      if (data.started || data.alreadyRunning) {
        const existing = client.getQueryData<MailSyncJob[]>(key) ?? [];
        const current = existing.find(job => job.account_id === data.account_id);
        if (!current || !active(current)) {
          const queued: MailSyncJob = { account_id: data.account_id, state: 'queued', phase: null, processed: 0, total: null, started_at: null, updated_at: null, error: null };
          previous.current.set(data.account_id, queued);
          client.setQueryData<MailSyncJob[]>(key, [
            ...existing.filter(job => job.account_id !== data.account_id),
            queued,
          ]);
        }
      }
      requested.current.add(data.account_id);
      toast({ title: data.started ? 'Mail sync queued' : 'Mail sync already in progress', description: data.message });
      void client.invalidateQueries({ queryKey: key });
    },
    onError: (error: Error) => toast({ title: 'Could not request mail sync', description: error.message, variant: 'destructive' }),
  });

  const cancel = useMutation({
    mutationFn: async (account_id: string) => {
      const response = await api.post('/mail/sync/cancel', { account_id });
      if (response.error) throw new Error(response.error);
      return account_id;
    },
    retry: false,
    onSuccess: accountId => {
      cancellationRequested.current.add(accountId);
      // The response only acknowledges the request. Wait for a cancelled
      // status before telling the user the job actually stopped.
      void client.invalidateQueries({ queryKey: key });
    },
    onError: (error: Error) => toast({ title: 'Could not cancel mail sync', description: error.message, variant: 'destructive' }),
  });

  const requestSync = useCallback((accountId: string) => {
    if (requests.current.has(accountId)) return;
    requests.current.add(accountId);
    setSyncingAccountIds(new Set(requests.current));
    void sync.mutateAsync(accountId).catch(() => { /* onError already explains the failure. */ }).finally(() => {
      requests.current.delete(accountId);
      setSyncingAccountIds(new Set(requests.current));
    });
  }, [sync]);

  const requestCancel = useCallback((accountId: string) => {
    if (cancellations.current.has(accountId)) return;
    cancellations.current.add(accountId);
    setCancellingAccountIds(new Set(cancellations.current));
    void cancel.mutateAsync(accountId).catch(() => { /* onError already explains the failure. */ }).finally(() => {
      cancellations.current.delete(accountId);
      setCancellingAccountIds(new Set(cancellations.current));
    });
  }, [cancel]);

  return { jobs, requestSync, syncingAccountIds, requestCancel, cancellingAccountIds };
}
