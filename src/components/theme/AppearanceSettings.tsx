import { useTheme } from 'next-themes';
import { Moon, Sun, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  return <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="appearance-heading">
    <h2 id="appearance-heading" className="font-semibold">Appearance</h2>
    <p className="text-sm text-muted-foreground">Black surfaces, white text and blue accents. Your choice is saved on this device.</p>
    <div className="flex flex-wrap gap-2">
      {([{value:'dark',label:'Dark',Icon:Moon},{value:'light',label:'Light',Icon:Sun},{value:'system',label:'System',Icon:Monitor}] as const).map(({value,label,Icon}) =>
        <Button key={value} type="button" variant={theme===value?'default':'outline'} aria-pressed={theme===value} onClick={()=>setTheme(value)}>
          <Icon className="mr-2 h-4 w-4" />{label}
        </Button>)}
    </div>
  </section>;
}
