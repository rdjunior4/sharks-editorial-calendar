import { ReactNode, useEffect, useState } from 'react';
import AppSidebar from './AppSidebar';
import TopHeader from './TopHeader';
import BottomNav from './BottomNav';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { useOverdueSweep } from '@/hooks/useOverdueSweep';
import { cn } from '@/lib/utils';

interface AppLayoutProps {
  children: ReactNode;
}

const SIDEBAR_KEY = 'sidebar-collapsed';

export default function AppLayout({ children }: AppLayoutProps) {
  const { user, loading, isSharks } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  /** Recolhimento aqui: sidebar E conteúdo leem o MESMO estado — o ml transiciona junto. */
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  const toggleCollapsed = () => setCollapsed(c => {
    const next = !c;
    localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
    return next;
  });
  useEffect(() => { setMobileNavOpen(false); }, [collapsed]);
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-dvh bg-gray-50 flex flex-col">
      <AppSidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      <div className={cn(
        'flex flex-col flex-1 transition-[margin] duration-300 ease-in-out',
        'lg:ml-[240px] lg:will-change-[margin]',
        collapsed && 'lg:ml-[68px]',
      )}>
        <TopHeader onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="p-4 pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-6 flex-1 flex flex-col">
          <div className="mx-auto w-full max-w-[1400px] flex-1 flex flex-col">
            {children}
          </div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

// Layout for Sharks pages only
export function SharksLayout({ children }: { children: ReactNode }) {
  const { isSharks, loading } = useAuth();
  useOverdueSweep(isSharks);

  if (loading) return null;
  if (!isSharks) return <Navigate to="/select-environment" replace />;

  return <AppLayout>{children}</AppLayout>;
}

// Layout for Client pages only
export function ClientLayout({ children }: { children: ReactNode }) {
  const { isClient, loading } = useAuth();

  if (loading) return null;
  if (!isClient) return <Navigate to="/select-environment" replace />;

  return <AppLayout>{children}</AppLayout>;
}

// Layout for Estrategos pages (staff do ambiente estrategos)
export function EstrategosLayout({ children }: { children: ReactNode }) {
  const { hasAccess, loading } = useAuth();
  const isEstrategos = hasAccess('estrategos', ['admin', 'team']);
  useOverdueSweep(isEstrategos);

  if (loading) return null;
  if (!isEstrategos) return <Navigate to="/select-environment" replace />;

  return <AppLayout>{children}</AppLayout>;
}

// Layout for Oracullo pages (admin global apenas)
export function OraculloLayout({ children }: { children: ReactNode }) {
  const { isOracullo, loading } = useAuth();

  if (loading) return null;
  if (!isOracullo) return <Navigate to="/select-environment" replace />;

  return <AppLayout>{children}</AppLayout>;
}
