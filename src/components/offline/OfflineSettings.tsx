import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { captureOfflineSave, clearOfflineData, getOfflineSnapshotInfo, saveOfflineSnapshot, type OfflineSnapshot } from '@/lib/offline';
import { Button } from '@/components/ui/button';

type Info = Awaited<ReturnType<typeof getOfflineSnapshotInfo>>;
export default function OfflineSettings() {
  const {user,isOffline} = useAuth();
  const [info,setInfo] = useState<Info>(null), [busy,setBusy]=useState<'saving' | 'clearing' | null>(null), [error,setError]=useState('');
  const [loadingInfo,setLoadingInfo]=useState(true);
  const request=useRef<AbortController|null>(null);
  useEffect(()=>{
    let active=true;
    const refresh=()=>{void getOfflineSnapshotInfo().then(value=>{if(active){setInfo(value);setLoadingInfo(false);}});};refresh();
    window.addEventListener('unihub-offline-change',refresh);
    return ()=>{active=false;request.current?.abort();window.removeEventListener('unihub-offline-change',refresh);};
  },[user?.id]);
  const sync=async()=>{
    if(!user)return;
    const controller=new AbortController();request.current?.abort();request.current=controller;setBusy('saving');setError('');
    try {
      const token=captureOfflineSave(user.id);
      const response=await api.get<{snapshot:OfflineSnapshot}>('/offline/snapshot',{signal:controller.signal});
      if(response.error||!response.data?.snapshot)throw new Error(response.error||'Offline data was incomplete.');
      if(controller.signal.aborted)return;
      await saveOfflineSnapshot(response.data.snapshot,user,controller.signal,token);
    } catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Offline sync failed.');}
    finally{if(request.current===controller){request.current=null;setBusy(null);}}
  };
  const clear=async()=>{request.current?.abort();request.current=null;setBusy('clearing');setError('');try{await clearOfflineData();setInfo(null);}catch(error){setError(error instanceof Error?error.message:'Could not clear offline data.');}finally{setBusy(null);}};
  return <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="offline-heading">
    <h2 id="offline-heading" className="font-semibold">Offline reading</h2>
    <p className="text-sm text-muted-foreground">Keep the latest 100 full emails, all contacts and events on this device. Attachments stay online. Offline data is read-only and cleared when you sign out.</p>
    {loadingInfo ? <p role="status" className="text-sm text-muted-foreground">Checking saved data…</p> : info ? <p className="text-sm">{info.emails} emails · {info.contacts} contacts · {info.events} events · {(info.bytes/1024/1024).toFixed(1)} MiB<br/><span className="text-muted-foreground">Last saved {new Date(info.savedAt).toLocaleString()}</span></p> : <p className="text-sm text-muted-foreground">Offline reading is not enabled on this device.</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" onClick={()=>void sync()} disabled={!!busy||loadingInfo||isOffline||!navigator.onLine}>{info?<RefreshCw className="mr-2 h-4 w-4"/>:<Download className="mr-2 h-4 w-4"/>}{busy==='saving'?'Saving…':info?'Refresh offline data':'Enable offline reading'}</Button>
      {info&&<Button type="button" variant="outline" disabled={!!busy} onClick={()=>void clear()}><Trash2 className="mr-2 h-4 w-4"/>{busy==='clearing'?'Clearing…':'Clear device data'}</Button>}
    </div>
    <p className="text-xs text-muted-foreground">32 MiB limit. Saved data refreshes while UniHub is open and connected; the timestamp shows what is available offline.</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
