import { useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import EnvSwitcher, { type CrossEnv } from '@/components/oracullo/EnvSwitcher';
import PartnersPage from '@/components/partners/PartnersPage';

/** Parceiros centrais do Oracullo: cadastros de Sharks + Estratégos. */
export default function OraculloPartners() {
  const [env, setEnv] = useState<CrossEnv>('sharks_company');
  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      <div className="flex items-center justify-between shrink-0">
        <PageHeader title="Parceiros — central" subtitle="Cadastros e marcos de parceiros dos dois ambientes" />
        <EnvSwitcher value={env} onChange={setEnv} />
      </div>
      <PartnersPage environment={env} />
    </div>
  );
}
