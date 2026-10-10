import PageHeader from '@/components/ui/PageHeader';
import { useEffect, useState } from 'react';
import Card, { CardHeader, CardTitle } from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useAuth } from '@/contexts/AuthContext';
import { useIntegration } from '@/hooks/useIntegration';
import { loadAllIntegrations, loadGlobalIntegration, getGlobalIntegration, subscribeIntegration } from '@/lib/integrationService';
import {
  startGoogleConnect,
  processQueue,
  listCalendars,
  setTargetCalendar,
  createClientCalendar,
  disconnectCalendar,
  setAutoSync,
  setEnvSync,
  changeSyncMode,
  type GoogleIntegration,
  type GoogleCalendarOption,
} from '@/lib/googleSync';
import SyncModeSelector, { EnvSyncToggles } from '@/components/integrations/SyncModeSelector';
import Switch from '@/components/ui/Switch';
import WorkspaceLogo from '@/components/ui/WorkspaceLogo';
import { toast } from 'sonner';
import type { SyncMode, EnvironmentType } from '@/types';
import {
  Calendar,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Link as LinkIcon,
  Clock,
  Zap,
  AlertTriangle,
  Loader2,
  Unlink,
  ChevronRight,
  Mail,
  CalendarPlus,
  Repeat,
} from 'lucide-react';

function formatDateTime(iso: string | null): string {  if (!iso) return 'Nunca';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function SharksIntegrations() {
  const { currentWorkspace, workspacesByEnv, setCurrentWorkspace } = useWorkspace();
  const workspaces = workspacesByEnv('sharks_company');
  const { user, isSharks, isAdmin } = useAuth();

  // Guarda de ambiente: currentWorkspace persiste entre trocas de ambiente
  // (guardiao/admin dual) — so e valido aqui se for do ambiente Sharks.
  const sharksWs = currentWorkspace?.environment === 'sharks_company' ? currentWorkspace : null;

  const [syncing, setSyncing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [showCalendars, setShowCalendars] = useState(false);
  const [calendars, setCalendars] = useState<GoogleCalendarOption[] | null>(null);
  const [loadingCalendars, setLoadingCalendars] = useState(false);
  const [creatingCalendar, setCreatingCalendar] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>('split');
  const [switchingMode, setSwitchingMode] = useState(false);

  // Modo "Todos os clientes": status de integracao de cada workspace
  const [allIntegrations, setAllIntegrations] = useState<Record<string, GoogleIntegration>>({});
  // Global integration (admin)
  const [globalInteg, setGlobalInteg] = useState<GoogleIntegration | null>(null);

  const { integration: wsIntegration, loading } = useIntegration(sharksWs?.id);
  // Use global integration when no workspace selected
  const integration = sharksWs ? wsIntegration : globalInteg;

  useEffect(() => {
    if (sharksWs) return;
    let active = true;
    const refresh = () => {
      loadAllIntegrations()
        .then(map => { if (active) setAllIntegrations(map); })
        .catch(() => {});
      loadGlobalIntegration()
        .then(g => { if (active) setGlobalInteg(g); })
        .catch(() => {});
    };
    refresh();
    const unsubscribe = subscribeIntegration(() => {
      loadGlobalIntegration().then(g => { if (active) setGlobalInteg(g); }).catch(() => {});
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sharksWs?.id]);

  // Resultado do redirect do OAuth
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const g = sp.get('google');
    if (!g) return;
    if (g === 'connected') toast.success('Google Calendar conectado com sucesso!');
    else if (g === 'denied') toast.error('Permissão negada na conta Google.');
    else {
      const reason = sp.get('reason');
      const msg =
        reason === 'credenciais_nao_configuradas'
          ? 'Credenciais OAuth ainda não configuradas no servidor.'
          : reason === 'sem_permissao_calendario'
          ? 'A permissão do Google Calendar não foi marcada. Tente de novo e marque TODAS as caixinhas na tela do Google (principalmente "Ver e editar eventos em todas as suas agendas").'
          : reason === 'sem_acesso'
          ? 'Sua conta não tem acesso a este workspace.'
          : `Falha na conexão: ${reason ? decodeURIComponent(reason) : g}`;
      toast.error(msg, { duration: 8000 });
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const isConnected = !!integration?.is_connected;
  const isAgencyAccount = !!integration?.google_account_email && integration.google_account_email === user?.email;
  const calDisplayName =
    integration?.google_calendar_name && integration.google_calendar_name !== integration.google_account_email
      ? integration.google_calendar_name
      : 'Primária';

  const handleConnect = async () => {
    if (!user) return;
    // Global mode when no workspace selected
    try {
      await startGoogleConnect(sharksWs?.id ?? null, '/sharks/integrations', syncMode);
    } catch (e) {
      toast.error(`Erro ao iniciar conexão: ${(e as Error).message}`);
    }
  };

  const handleToggleEnv = async (env: EnvironmentType, enabled: boolean) => {
    try {
      await setEnvSync(sharksWs?.id ?? null, env, enabled);
      toast.success(enabled ? 'Sincronização ativada.' : 'Sincronização pausada.');
    } catch (e) {
      toast.error(`Erro: ${(e as Error).message}`);
    }
  };

  const handleSwitchMode = async () => {
    if (switchingMode) return;
    setSwitchingMode(true);
    const next = integration?.sync_mode === 'split' ? 'unified' : 'split';
    try {
      await changeSyncMode(sharksWs?.id ?? null, next);
      toast.success(next === 'split'
        ? 'Modo separado: agendas "Sharks" e "Estrategos" criadas no Google.'
        : 'Modo única agenda: novos eventos usam a agenda principal.');
    } catch (e) {
      toast.error(`Erro: ${(e as Error).message}`);
    } finally {
      setSwitchingMode(false);
    }
  };

  const handleSyncNow = async () => {
    const wsParam = sharksWs?.id ?? null;
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await processQueue(wsParam);
      if (res.failed) {
        toast.warning(`${res.ok ?? 0} sincronizado(s), ${res.failed} falharam. Tentaremos novamente automaticamente.`);
      } else if (res.processed) {
        toast.success(`${res.processed} item(ns) sincronizado(s) com o Google Calendar.`);
      } else {
        toast.success('Tudo sincronizado.');
      }
    } catch (e) {
      toast.error(`Erro ao sincronizar: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleAuto = async () => {
    if (!integration) return;
    try {
      await setAutoSync(sharksWs?.id ?? null, !integration.auto_sync);
      toast.success(integration.auto_sync ? 'Sincronização automática pausada.' : 'Sincronização automática ativada.');
    } catch (e) {
      toast.error(`Erro: ${(e as Error).message}`);
    }
  };

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    try {
      await disconnectCalendar(sharksWs?.id ?? null);
      toast.success('Google Calendar desconectado.');
    } catch (e) {
      toast.error(`Erro: ${(e as Error).message}`);
    }
  };

  const handleLoadCalendars = async () => {
    setLoadingCalendars(true);
    try {
      const res = await listCalendars(sharksWs?.id ?? null);
      setCalendars(res.calendars);
    } catch (e) {
      toast.error(`Erro ao listar agendas: ${(e as Error).message}`);
    } finally {
      setLoadingCalendars(false);
    }
  };

  const handlePickCalendar = async (cal: GoogleCalendarOption) => {
    try {
      await setTargetCalendar(sharksWs?.id ?? null, cal.id, cal.name);
      toast.success(`Agenda destino: ${cal.name}`);
    } catch (e) {
      toast.error(`Erro: ${(e as Error).message}`);
    }
  };

  const handleCreateClientCalendar = async () => {
    if (creatingCalendar) return;
    setCreatingCalendar(true);
    try {
      const res = await createClientCalendar(sharksWs?.id ?? null);
      toast.success(`Agenda "${res.calendar_name}" criada! Re-sincronizando...`);
      processQueue(sharksWs?.id ?? null).catch(() => {});
    } catch (e) {
      toast.error(`Erro ao criar agenda: ${(e as Error).message}`);
    } finally {
      setCreatingCalendar(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Integrações" subtitle="Conecte ferramentas externas ao seu fluxo" />

      {/* SINALIZADOR: integracao ATIVA */}
      {!loading && isConnected && (
        <div className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-white p-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-emerald-900">Integração Google Calendar ativa</p>
            </div>
            <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
              <span className="text-xs font-medium text-emerald-700 bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                <Zap className="w-3 h-3" />
                {integration?.auto_sync ? 'Sincronizando em tempo real' : 'Sync automático pausado'}
              </span>
              {confirmDisconnect ? (
                <span className="flex items-center gap-1">
                  <button
                    onClick={handleDisconnect}
                    className="text-xs font-medium text-white bg-red-500 hover:bg-red-600 px-2.5 py-1 rounded-full transition-colors"
                  >
                    Confirmar
                  </button>
                  <button
                    onClick={() => setConfirmDisconnect(false)}
                    className="text-xs font-medium text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-2.5 py-1 rounded-full transition-colors"
                  >
                    Cancelar
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDisconnect(true)}
                  className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 px-2.5 py-1 rounded-full flex items-center gap-1 transition-colors"
                >
                  <Unlink className="w-3 h-3" />
                  Desconectar
                </button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 mt-3 pt-3 border-t border-emerald-100 text-sm">
            <p className="text-emerald-800 truncate">
              <span className="text-emerald-600 text-xs uppercase tracking-wide font-medium block">Cliente</span>
              {sharksWs?.name ?? '—'}
            </p>
            <p className="text-emerald-800 truncate">
              <span className="text-emerald-600 text-xs uppercase tracking-wide font-medium block">Conta Google</span>
              <span className="flex items-center gap-1.5">
                {integration?.google_account_email ?? '—'}
                {isAgencyAccount && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide bg-emerald-600 text-white px-1.5 py-0.5 rounded shrink-0">
                    conta da agência
                  </span>
                )}
              </span>
            </p>
            <p className="text-emerald-800 truncate">
              <span className="text-emerald-600 text-xs uppercase tracking-wide font-medium block">Agenda destino</span>
              {calDisplayName}
            </p>
            <p className="text-emerald-800 truncate">
              <span className="text-emerald-600 text-xs uppercase tracking-wide font-medium block">Última sincronização</span>
              {formatDateTime(integration?.last_synced_at ?? null)}
            </p>
          </div>
        </div>
      )}

      {/* Status da integração */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary-500" />
            Google Calendar
            {sharksWs && (
              <span className="text-xs font-normal text-gray-400">— {sharksWs.name}</span>
            )}
          </CardTitle>
          {loading ? (
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Loader2 className="w-3 h-3 animate-spin" /> Carregando
            </span>
          ) : (
            <span
              className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                isConnected ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'
              }`}
            >
              {isConnected ? (
                <>
                  <CheckCircle2 className="w-3 h-3" /> Conectado
                </>
              ) : (
                <>
                  <XCircle className="w-3 h-3" /> Não conectado
                </>
              )}
            </span>
          )}
        </CardHeader>

        {!sharksWs ? (
          <>
            {/* Card pessoal — cada usuario conecta a PROPRIA conta Google */}
            {isSharks && (
            <div className="mb-4">
              {globalInteg?.is_connected ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-emerald-900">Minha agenda Google</p>
                      <p className="text-xs text-emerald-700">
                        {globalInteg.google_account_email} · Sincroniza TODOS os clientes para a sua agenda
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSyncNow}
                        disabled={syncing}
                        className="bg-white border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                      >
                        {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                        Sincronizar agora
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSwitchMode}
                        disabled={switchingMode}
                        className="bg-white border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                      >
                        {switchingMode ? <Loader2 className="w-4 h-4 animate-spin" /> : <Repeat className="w-4 h-4" />}
                        {globalInteg?.sync_mode === 'split' ? 'Usar uma agenda só' : 'Separar por ambiente'}
                      </Button>
                      <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-1 rounded-full">
                        <Zap className="w-3 h-3" /> Ativa
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <p className="text-sm font-medium text-gray-900 mb-1">Minha agenda Google</p>
                  <p className="text-xs text-gray-500 mb-3">
                    Conecte a <strong>sua</strong> conta Google — o cronograma de todos os clientes é
                    importado automaticamente para a sua agenda. Cada membro do time conecta a própria conta.
                  </p>
                  <div className="mb-3">
                    <SyncModeSelector value={syncMode} onChange={setSyncMode} />
                  </div>
                  <Button onClick={handleConnect} size="sm">
                    <LinkIcon className="w-4 h-4" /> Conectar minha conta Google
                  </Button>
                </div>
              )}
            </div>
            )}

            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Integrações por cliente</p>
              <div className="space-y-2">
                {workspaces.map(ws => {
                  const integ = allIntegrations[ws.id];
                  const connected = !!integ?.is_connected;
                  return (
                    <div key={ws.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-3 min-w-0">
                      <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{ws.name}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {connected
                            ? `${integ.google_account_email ?? '—'} · ${integ.auto_sync ? 'sync em tempo real' : 'sync pausado'}`
                            : 'Google Calendar não conectado'}
                        </p>
                      </div>
                    </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {connected && (
                          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-full">
                            <CheckCircle2 className="w-3 h-3" /> Ativa
                          </span>
                        )}
                        <Button variant="outline" size="sm" onClick={() => setCurrentWorkspace(ws)}>
                          Gerenciar
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
        <>
        {!loading && integration?.sync_error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-xs text-red-700">{integration.sync_error}</p>
          </div>
        )}

        {!isConnected ? (
          <>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
              <p className="text-sm font-medium text-gray-900 mb-1">Conecte a agenda do cliente</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                Ao conectar, cada ação criada ou editada neste workspace é enviada automaticamente para o
                Google Calendar escolhido — criação, atualização e remoção em tempo quase real, com fila de
                reprocessamento e mapeamento por ID de evento.
              </p>
            </div>
            <div className="mb-4">
              <SyncModeSelector value={syncMode} onChange={setSyncMode} />
            </div>
            <Button onClick={handleConnect} disabled={!sharksWs}>
              <LinkIcon className="w-4 h-4" />
              Conectar Google Calendar
            </Button>
          </>
        ) : (
          <div className="space-y-4">
            {integration?.sync_mode === 'split' && (
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 font-medium mb-2">Sync por ambiente</p>
                <EnvSyncToggles envAutoSync={integration?.env_auto_sync} onToggle={handleToggleEnv} />
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <Mail className="w-4 h-4 text-gray-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">Conta Google</p>
                  <p className="text-sm text-gray-900 truncate">{integration?.google_account_email ?? '—'}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <Clock className="w-4 h-4 text-gray-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">Última sincronização</p>
                  <p className="text-sm text-gray-900 truncate">{formatDateTime(integration?.last_synced_at ?? null)}</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowCalendars(v => {
                    if (!v && !calendars) handleLoadCalendars();
                    return !v;
                  });
                }}
                className="flex items-center justify-between gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Calendar className="w-4 h-4 text-gray-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">Agenda destino</p>
                    <p className="text-sm text-gray-900 truncate">{calDisplayName}</p>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
              </button>
              <Switch
                checked={!!integration?.auto_sync}
                onChange={handleToggleAuto}
                label="Sync automático"
                description={integration?.auto_sync ? 'Ativado' : 'Pausado'}
              />
            </div>

            {/* Seletor de agenda */}
            {showCalendars && (
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-56 overflow-y-auto">
                {loadingCalendars && (
                  <div className="flex items-center gap-2 p-3 text-xs text-gray-400">
                    <Loader2 className="w-3 h-3 animate-spin" /> Carregando agendas...
                  </div>
                )}
                {calendars?.map(cal => {
                  const active = cal.id === integration?.google_calendar_id;
                  return (
                    <button
                      key={cal.id}
                      onClick={() => handlePickCalendar(cal)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-gray-50 transition-colors ${
                        active ? 'font-medium text-primary-600' : 'text-gray-700'
                      }`}
                    >
                      <span className="truncate">{cal.name}</span>
                      <span className="flex items-center gap-2 shrink-0 ml-2">
                        {!active && cal.primary && (
                          <span className="text-[10px] uppercase tracking-wide bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded">
                            primária
                          </span>
                        )}
                        {active && <CheckCircle2 className="w-4 h-4" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={handleSyncNow} disabled={syncing}>
                {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Sincronizar agora
              </Button>
              <Button variant="outline" size="sm" onClick={handleSwitchMode} disabled={switchingMode}>
                {switchingMode ? <Loader2 className="w-4 h-4 animate-spin" /> : <Repeat className="w-4 h-4" />}
                {integration?.sync_mode === 'split' ? 'Usar uma agenda só' : 'Separar por ambiente'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCreateClientCalendar}
                disabled={creatingCalendar}
                title={`Cria a agenda "Sharks | ${sharksWs.name}" na conta Google conectada e move os eventos para lá`}
              >
                {creatingCalendar ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />}
                Criar agenda dedicada do cliente
              </Button>
              {confirmDisconnect ? (
                <span className="flex items-center gap-2">
                  <Button variant="danger" size="sm" onClick={handleDisconnect}>
                    Confirmar desconexão
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>
                    Cancelar
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>
                  <Unlink className="w-4 h-4" />
                  Desconectar
                </Button>
              )}
            </div>
          </div>
        )}
        </>
        )}
      </Card>

      {/* Como funciona */}
      <Card>
        <CardHeader>
          <CardTitle>Como funciona a sincronização</CardTitle>
        </CardHeader>
        <ul className="space-y-2.5 text-sm text-gray-600">
          <li className="flex items-start gap-2.5">
            <Zap className="w-4 h-4 text-primary-500 mt-0.5 shrink-0" />
            <span>Toda ação criada, editada ou cancelada entra numa fila e vai para o Google Calendar em segundos — sem travar a interface.</span>
          </li>
          <li className="flex items-start gap-2.5">
            <RefreshCw className="w-4 h-4 text-primary-500 mt-0.5 shrink-0" />
            <span>Um worker roda a cada minuto como rede de segurança, garantindo que nada fique para trás mesmo se o app estiver fechado.</span>
          </li>
          <li className="flex items-start gap-2.5">
            <LinkIcon className="w-4 h-4 text-primary-500 mt-0.5 shrink-0" />
            <span>Cada evento guarda o ID do Google Calendar: edições nunca duplicam eventos e remoções são exatas.</span>
          </li>
          <li className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-primary-500 mt-0.5 shrink-0" />
            <span>Ações marcadas como "Cancelada" removem o evento da agenda; falhas são retentadas até 5 vezes com aviso aqui.</span>
          </li>
        </ul>
      </Card>

    </div>
  );
}
