import { useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import Tabs from '@/components/ui/Tabs';
import EnvProductsCatalog from './EnvProductsCatalog';
import WorkspaceProducts from './WorkspaceProducts';
import EnvAgentAssets from './EnvAgentAssets';
import type { CrmEnvironment } from '@/hooks/useLeads';

type ProductsTab = 'catalog' | 'assets' | 'client';

/** Página de Produtos: catálogo do ambiente (leads) + Assets de IA do agente + produtos do cliente (ações). */
export default function ProductsPage({ environment }: { environment: CrmEnvironment }) {
  const [tab, setTab] = useState<ProductsTab>('catalog');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Produtos"
        subtitle="Catálogo do ambiente para o interesse dos leads · Assets de IA para o agente · Produtos dos clientes para as ações"
      />
      <Tabs
        tabs={[
          { id: 'catalog' as const, label: 'Catálogo do ambiente' },
          { id: 'assets' as const, label: 'Assets de IA' },
          { id: 'client' as const, label: 'Produtos do cliente' },
        ]}
        activeTab={tab}
        onChange={setTab}
      />
      {tab === 'catalog' ? (
        <EnvProductsCatalog key={environment} environment={environment} />
      ) : tab === 'assets' ? (
        <EnvAgentAssets key={`assets-${environment}`} environment={environment} />
      ) : (
        <WorkspaceProducts />
      )}
    </div>
  );
}
