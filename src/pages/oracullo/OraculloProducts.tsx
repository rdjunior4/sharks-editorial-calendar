import { useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import EnvSwitcher, { type CrossEnv } from '@/components/oracullo/EnvSwitcher';
import ProductsPage from '@/components/products/ProductsPage';

/** Produtos centrais do Oracullo: catálogo dos dois ambientes. */
export default function OraculloProducts() {
  const [env, setEnv] = useState<CrossEnv>('sharks_company');
  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      <div className="flex items-center justify-between shrink-0">
        <PageHeader title="Produtos — central" subtitle="Catálogo e grupos de produtos dos dois ambientes" />
        <EnvSwitcher value={env} onChange={setEnv} />
      </div>
      <ProductsPage environment={env} />
    </div>
  );
}
