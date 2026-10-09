import { useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import EnvSwitcher, { type CrossEnv } from '@/components/oracullo/EnvSwitcher';
import SharksCalendar from '@/pages/sharks/SharksCalendar';

/** Calendário central do Oracullo: auditoria multiambiente (god-view guardian). */
export default function OraculloCalendar() {
  const [env, setEnv] = useState<CrossEnv>('sharks_company');
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageHeader title="Calendário central" subtitle="Audite os calendários Sharks e Estratégos em um só lugar" />
        <EnvSwitcher value={env} onChange={setEnv} />
      </div>
      <SharksCalendar environment={env} />
    </div>
  );
}
