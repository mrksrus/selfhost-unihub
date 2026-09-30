import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { captureOfflineSave, getOfflineSnapshotInfo, isOfflineMode, saveOfflineSnapshot, type OfflineSnapshot } from '@/lib/offline';
import { Button } from '@/components/ui/button';

export default function OfflineBanner() {
  const {user,isOffline,offlineSavedAt}=useAuth();
  const [online,setOnline]=useState(navigator.onLine);
  const [savedAt,setSavedAt]=useState(offlineSavedAt);
  useEffect(()=>{
    const status=()=>setOnline(navigator.onLine&&!isOfflineMode());
    const info=()=>{void getOfflineSnapshotInfo().then(value=>setSavedAt(value?.savedAt));};
    status();info();
    window.addEventListener('online',status);window.addEventListener('offline',status);window.addEventListener('unihub-offline-mode',status);window.addEventListener('unihub-offline-change',info);
    return()=>{window.removeEventListener('online',status);window.removeEventListener('offline',status);window.removeEventListener('unihub-offline-mode',status);window.removeEventListener('unihub-offline-change',info);};
  },[]);
  useEffect(()=>{
    if(!user||isOffline)return;
    const controller=new AbortController();let busy=false,last=0;
    const refresh=async()=>{
      if(busy||!navigator.onLine||isOfflineMode()||document.visibilityState==='hidden'||Date.now()-last<60_000)return;
      busy=true;
      try{
        if(!await getOfflineSnapshotInfo()||controller.signal.aborted)return;
        last=Date.now();
        const token=captureOfflineSave(user.id);
        const response=await api.get<{snapshot:OfflineSnapshot}>('/offline/snapshot',{signal:controller.signal});
        if(response.data?.snapshot&&!controller.signal.aborted)await saveOfflineSnapshot(response.data.snapshot,user,controller.signal,token);
      }catch{/* Keep the previous complete snapshot; Settings exposes a retry and its age. */}
      finally{busy=false;}
    };
    const trigger=()=>{void refresh();};trigger();
    const timer=window.setInterval(trigger,5*60_000);window.addEventListener('focus',trigger);window.addEventListener('online',trigger);
    return()=>{controller.abort();window.clearInterval(timer);window.removeEventListener('focus',trigger);window.removeEventListener('online',trigger);};
  },[user,isOffline]);
  if(online&&!isOffline)return null;
  return <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm">
    <span>Offline · read-only{savedAt?' · saved '+new Date(savedAt).toLocaleString():''}. Mail counts reflect saved messages.</span>
    <Button size="sm" variant="outline" type="button" onClick={()=>window.dispatchEvent(new Event('unihub:retry-session'))}>Retry connection</Button>
  </div>;
}
