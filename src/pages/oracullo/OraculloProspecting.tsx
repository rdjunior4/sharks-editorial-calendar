import { useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import EnvSwitcher, { type CrossEnv } from '@/components/oracullo/EnvSwitcher';
import ProspectingHub from '@/components/prospecting/ProspectingHub';
import { useAuth } from '@/contexts/AuthContext';

/** Prospecção IA centrale do Oracullo: acompanha as duas esteiras (god-view guardian). */
export default function OraculloProspecting() {
  const { isOracullo } = useAuth();
  const [env, setEnv] = useState<CrossEnv>('sharks_company');
  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      <div className="flex items-center justify-between shrink-0">
        <PageHeader title="Prospecção IA — central" subtitle="Acompanhe campanhas, agente e abordagens dos dois ambientes" />
        <EnvSwitcher value={env} onChange={setEnv} />
      </div>
      <ProspectingHub environment={env} editable={isOracullo} />
    </div>
  );
}
