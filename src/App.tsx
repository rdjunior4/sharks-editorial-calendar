import { useEffect, lazy, Suspense, type ComponentType } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import ErrorBoundary from '@/components/ErrorBoundary';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { WorkspaceProvider, useWorkspace } from '@/contexts/WorkspaceContext';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { loadActions } from '@/lib/actionService';
import { loadCampaigns } from '@/hooks/useCampaigns';
import { loadEditorial } from '@/hooks/useEditorial';
import { useIntegration } from '@/hooks/useIntegration';
import { SharksLayout, ClientLayout, EstrategosLayout, OraculloLayout } from '@/components/layout/AppLayout';
import LoginPage from '@/pages/auth/LoginPage';
import RequestAccess from '@/pages/auth/RequestAccess';
import AuthGate from '@/pages/auth/AuthGate';
import EnvironmentSelector from '@/pages/auth/EnvironmentSelector';

// Code-splitting por rota: cada página vira um chunk carregado sob demanda,
// reduzindo o bundle inicial (auditoria 2026-08-29).
const CHUNK_RELOAD_KEY = 'chunk-reload-attempt';

/**
 * lazy com recuperação de chunk obsoleto: após um deploy, uma SPA já aberta
 * referencia hashes antigos que não existem mais ("Failed to fetch dynamically
 * imported module"). Recarrega a página uma única vez para buscar o index.html
 * novo; o flag em sessionStorage impede loop em caso de falha real.
 */
function lazyPage<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().then(
      (mod) => {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        return mod;
      },
      (err: unknown) => {
        if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
          window.location.reload();
        }
        throw err;
      },
    ),
  );
}

const PrivacyPolicy = lazyPage(() => import('@/pages/legal/PrivacyPolicy'));
const TermsOfService = lazyPage(() => import('@/pages/legal/TermsOfService'));

const OraculloDashboard = lazyPage(() => import('@/pages/oracullo/OraculloDashboard'));
const OraculloClients = lazyPage(() => import('@/pages/oracullo/OraculloClients'));
const OraculloAccess = lazyPage(() => import('@/pages/oracullo/OraculloAccess'));
const OraculloAccessRequests = lazyPage(() => import('@/pages/oracullo/OraculloAccessRequests'));
const OraculloUsers = lazyPage(() => import('@/pages/oracullo/OraculloUsers'));
const OraculloTeam = lazyPage(() => import('@/pages/oracullo/OraculloTeam'));
const OraculloCRM = lazyPage(() => import('@/pages/oracullo/OraculloCRM'));

const SharksDashboard = lazyPage(() => import('@/pages/sharks/SharksDashboard'));
const SharksCalendarPage = lazyPage(() => import('@/pages/sharks/SharksCalendar'));
const SharksClients = lazyPage(() => import('@/pages/sharks/SharksClients'));
const SharksCampaigns = lazyPage(() => import('@/pages/sharks/SharksCampaigns'));
const SharksEditorial = lazyPage(() => import('@/pages/sharks/SharksEditorial'));
const SharksHistory = lazyPage(() => import('@/pages/sharks/SharksHistory'));
const SharksChat = lazyPage(() => import('@/pages/sharks/SharksChat'));
const SharksIntegrations = lazyPage(() => import('@/pages/sharks/SharksIntegrations'));
const SharksSettings = lazyPage(() => import('@/pages/sharks/SharksSettings'));
const SharksTeam = lazyPage(() => import('@/pages/sharks/SharksTeam'));
const SharksProducts = lazyPage(() => import('@/pages/sharks/SharksProducts'));
const SharksAccessRequests = lazyPage(() => import('@/pages/sharks/SharksAccessRequests'));
const SharksCRM = lazyPage(() => import('@/pages/sharks/SharksCRM'));
const SharksProspecting = lazyPage(() => import('@/pages/sharks/SharksProspecting'));

const ClientDashboard = lazyPage(() => import('@/pages/client/ClientDashboard'));
const ClientCalendar = lazyPage(() => import('@/pages/client/ClientCalendar'));
const ClientHistory = lazyPage(() => import('@/pages/client/ClientHistory'));
const ClientChat = lazyPage(() => import('@/pages/client/ClientChat'));
const ClientIntegrations = lazyPage(() => import('@/pages/client/ClientIntegrations'));

const EstrategosDashboard = lazyPage(() => import('@/pages/estrategos/EstrategosDashboard'));
const EstrategosCalendar = lazyPage(() => import('@/pages/estrategos/EstrategosCalendar'));
const EstrategosProjects = lazyPage(() => import('@/pages/estrategos/EstrategosProjects'));
const EstrategosChat = lazyPage(() => import('@/pages/estrategos/EstrategosChat'));
const EstrategosClients = lazyPage(() => import('@/pages/estrategos/EstrategosClients'));
const EstrategosAccessRequests = lazyPage(() => import('@/pages/estrategos/EstrategosAccessRequests'));
const EstrategosTeam = lazyPage(() => import('@/pages/estrategos/EstrategosTeam'));
const EstrategosIntegrations = lazyPage(() => import('@/pages/estrategos/EstrategosIntegrations'));
const EstrategosMeetings = lazyPage(() => import('@/pages/estrategos/EstrategosMeetings'));
const EstrategosImplementations = lazyPage(() => import('@/pages/estrategos/EstrategosImplementations'));
const EstrategosCRM = lazyPage(() => import('@/pages/estrategos/EstrategosCRM'));
const EstrategosProspecting = lazyPage(() => import('@/pages/estrategos/EstrategosProspecting'));
const EstrategosProducts = lazyPage(() => import('@/pages/estrategos/EstrategosProducts'));
const SharksPartners = lazyPage(() => import('@/pages/sharks/SharksPartners'));
const EstrategosPartners = lazyPage(() => import('@/pages/estrategos/EstrategosPartners'));
const InstagramCallback = lazyPage(() => import('@/pages/instagram/InstagramCallback'));

function PageFallback() {
  return (
    <div className="min-h-[50vh] flex items-center justify-center">
      <div className="w-10 h-10 border-4 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
    </div>
  );
}

function DataSync() {
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();

  // Keeps the Google connection flag fresh globally (realtime)
  useIntegration(currentWorkspace?.id);

  useEffect(() => {
    if (!user) return;
    const scope = currentWorkspace?.id || null;
    loadActions(scope);
    loadCampaigns(scope);
    loadEditorial(scope);
  }, [user?.id, currentWorkspace?.id]);

  return null;
}

/** Home inteligente multi-ambiente (migration 023). */
function useHomePath(): string {
  const { isOracullo, isSharks, hasAccess, environments, user } = useAuth();
  if (!user) return '/login';
  if (isOracullo) return '/oracullo';
  if (environments.length === 0) return '/select-environment';
  if (environments.length > 1) return '/select-environment';
  if (hasAccess('estrategos', ['admin', 'team'])) return '/estrategos';
  if (isSharks) return '/sharks';
  return '/client';
}

function AppRoutes() {
  const { user, authUser, loading, isSharks, isClient } = useAuth();
  const homePath = useHomePath();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-12 h-12 border-4 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  // Not signed in at all — show login/request-access only
  if (!authUser) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/request-access" element={<RequestAccess />} />
        <Route path="/privacy" element={<Suspense fallback={<PageFallback />}><PrivacyPolicy /></Suspense>} />
        <Route path="/terms" element={<Suspense fallback={<PageFallback />}><TermsOfService /></Suspense>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Signed in via Google (or password) but no profile row yet —
  // the admin hasn't approved the access request. AuthGate
  // handles the pending/rejected realtime flow or shows the form.
  if (!user) {
    return (
      <Routes>
        {/* Allow direct access to the request page if a specific
            workspace was requested by the admin before approval */}
        <Route path="/request-access" element={<RequestAccess authUser={authUser} onSubmitted={() => {}} />} />
        <Route path="/privacy" element={<Suspense fallback={<PageFallback />}><PrivacyPolicy /></Suspense>} />
        <Route path="/terms" element={<Suspense fallback={<PageFallback />}><TermsOfService /></Suspense>} />
        <Route path="*" element={<AuthGate />} />
      </Routes>
    );
  }

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<Navigate to={homePath} replace />} />
        <Route path="/select-environment" element={<EnvironmentSelector />} />
        <Route path="/instagram/callback" element={<InstagramCallback />} />

        {/* Oracullo (governança multi-ambiente) */}
        <Route path="/oracullo" element={<OraculloLayout><OraculloDashboard /></OraculloLayout>} />
        <Route path="/oracullo/access" element={<OraculloLayout><OraculloAccess /></OraculloLayout>} />
        <Route path="/oracullo/crm" element={<OraculloLayout><OraculloCRM /></OraculloLayout>} />
        <Route path="/oracullo/access-requests" element={<OraculloLayout><OraculloAccessRequests /></OraculloLayout>} />
        <Route path="/oracullo/users" element={<OraculloLayout><OraculloUsers /></OraculloLayout>} />
        <Route path="/oracullo/clients" element={<OraculloLayout><OraculloClients /></OraculloLayout>} />
        <Route path="/oracullo/team" element={<OraculloLayout><OraculloTeam /></OraculloLayout>} />

        {/* Sharks routes */}
        <Route path="/sharks" element={<SharksLayout><SharksDashboard /></SharksLayout>} />
        <Route path="/sharks/calendar" element={<SharksLayout><SharksCalendarPage /></SharksLayout>} />
        <Route path="/sharks/clients" element={<SharksLayout><SharksClients /></SharksLayout>} />
        <Route path="/sharks/campaigns" element={<SharksLayout><SharksCampaigns /></SharksLayout>} />
        <Route path="/sharks/editorial" element={<SharksLayout><SharksEditorial /></SharksLayout>} />
        <Route path="/sharks/history" element={<SharksLayout><SharksHistory /></SharksLayout>} />
        <Route path="/sharks/crm" element={<SharksLayout><SharksCRM /></SharksLayout>} />
        <Route path="/sharks/prospeccao" element={<SharksLayout><SharksProspecting /></SharksLayout>} />
        <Route path="/sharks/prospeccao/agente" element={<Navigate to="/sharks/prospeccao" replace />} />
        <Route path="/sharks/abordagens" element={<Navigate to="/sharks/prospeccao" replace />} />
        <Route path="/sharks/chat" element={<SharksLayout><SharksChat /></SharksLayout>} />
        <Route path="/sharks/integrations" element={<SharksLayout><SharksIntegrations /></SharksLayout>} />
        <Route path="/sharks/team" element={<SharksLayout><SharksTeam /></SharksLayout>} />
        <Route path="/sharks/products" element={<SharksLayout><SharksProducts /></SharksLayout>} />
        <Route path="/sharks/parceiros" element={<SharksLayout><SharksPartners /></SharksLayout>} />
        <Route path="/sharks/access-requests" element={<SharksLayout><SharksAccessRequests /></SharksLayout>} />
        <Route path="/sharks/settings" element={<SharksLayout><SharksSettings /></SharksLayout>} />

        {/* Client routes */}
        <Route path="/client" element={<ClientLayout><ClientDashboard /></ClientLayout>} />
        <Route path="/client/calendar" element={<ClientLayout><ClientCalendar /></ClientLayout>} />
        <Route path="/client/history" element={<ClientLayout><ClientHistory /></ClientLayout>} />
        <Route path="/client/chat" element={<ClientLayout><ClientChat /></ClientLayout>} />
        <Route path="/client/integrations" element={<ClientLayout><ClientIntegrations /></ClientLayout>} />

        {/* Estrategos routes */}
        <Route path="/estrategos" element={<EstrategosLayout><EstrategosDashboard /></EstrategosLayout>} />
        <Route path="/estrategos/calendar" element={<EstrategosLayout><EstrategosCalendar /></EstrategosLayout>} />
        <Route path="/estrategos/projects" element={<EstrategosLayout><EstrategosProjects /></EstrategosLayout>} />
        <Route path="/estrategos/chat" element={<EstrategosLayout><EstrategosChat /></EstrategosLayout>} />
        <Route path="/estrategos/clients" element={<EstrategosLayout><EstrategosClients /></EstrategosLayout>} />
        <Route path="/estrategos/integrations" element={<EstrategosLayout><EstrategosIntegrations /></EstrategosLayout>} />
        <Route path="/estrategos/meetings" element={<EstrategosLayout><EstrategosMeetings /></EstrategosLayout>} />
        <Route path="/estrategos/implementations" element={<EstrategosLayout><EstrategosImplementations /></EstrategosLayout>} />
        <Route path="/estrategos/access-requests" element={<EstrategosLayout><EstrategosAccessRequests /></EstrategosLayout>} />
        <Route path="/estrategos/team" element={<EstrategosLayout><EstrategosTeam /></EstrategosLayout>} />
        <Route path="/estrategos/crm" element={<EstrategosLayout><EstrategosCRM /></EstrategosLayout>} />
        <Route path="/estrategos/prospeccao" element={<EstrategosLayout><EstrategosProspecting /></EstrategosLayout>} />
        <Route path="/estrategos/prospeccao/agente" element={<Navigate to="/estrategos/prospeccao" replace />} />
        <Route path="/estrategos/abordagens" element={<Navigate to="/estrategos/prospeccao" replace />} />
        <Route path="/estrategos/products" element={<EstrategosLayout><EstrategosProducts /></EstrategosLayout>} />
        <Route path="/estrategos/parceiros" element={<EstrategosLayout><EstrategosPartners /></EstrategosLayout>} />

        {/* Legal (público, exigência OAuth Google) */}
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/terms" element={<TermsOfService />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to={homePath} replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <WorkspaceProvider>
            <NotificationProvider>
              <DataSync />
              <AppRoutes />
              <Toaster
                position="bottom-right"
                richColors
                closeButton
                offset="calc(3.5rem + env(safe-area-inset-bottom))"
                toastOptions={{
                  style: {
                    borderRadius: '0.75rem',
                    border: '1px solid #e5e7eb',
                    fontSize: '14px',
                    fontFamily: 'inherit',
                  },
                }}
              />
            </NotificationProvider>
          </WorkspaceProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
