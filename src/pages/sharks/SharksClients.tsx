import PageHeader from '@/components/ui/PageHeader';
import { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import WorkspaceLogo from '@/components/ui/WorkspaceLogo';
import ClientWizard from '@/components/clients/ClientWizard';
import ClientEditModal, { type ClientEditTarget } from '@/components/clients/ClientEditModal';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Plus, Building2, MapPin, ChevronRight, Pencil, Power } from 'lucide-react';
import type { Workspace } from '@/types';

/* ─── Interruptor (switch) ─── */
function Switch({ on, onToggle, title, busy }: { on: boolean; onToggle: () => void; title: string; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      title={title}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1',
        on ? 'bg-emerald-500' : 'bg-gray-300',
        busy && 'opacity-50 cursor-wait',
      )}
    >
      <span className={cn(
        'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
        on ? 'translate-x-[19px]' : 'translate-x-[3px]',
      )} />
    </button>
  );
}

export default function SharksClients() {
  const { workspacesByEnv, setCurrentWorkspace, refreshWorkspaces } = useWorkspace();
  const workspaces = workspacesByEnv('sharks_company');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<ClientEditTarget | null>(null);

  const [inactive, setInactive] = useState<Workspace[]>([]);
  const [deactivating, setDeactivating] = useState<{ ws: Workspace; actionCount: number } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadInactive = useCallback(async () => {
    const { data } = await supabase
      .from('workspaces')
      .select('*')
      .eq('is_active', false)
      .order('name');
    setInactive(((data ?? []) as Workspace[]).filter(w => w.environment === 'sharks_company'));
  }, []);

  useEffect(() => { loadInactive(); }, [loadInactive]);

  const openClient = (ws: Workspace) => {
    setCurrentWorkspace(ws);
    window.location.hash = '#/sharks/calendar';
  };

  const openEdit = (ws: Workspace) => setEditing({
    id: ws.id, name: ws.name, segment: ws.segment, city: ws.city, state: ws.state, logo_url: ws.logo_url,
  });

  /* ── Desativar: abre o modal com contagem de ações ── */
  const askDeactivate = async (ws: Workspace) => {
    setBusyId(ws.id);
    const { count } = await supabase
      .from('actions')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.id);
    setBusyId(null);
    setDeactivating({ ws, actionCount: count ?? 0 });
  };

  /* ── Reativar ── */
  const reactivate = async (ws: Workspace) => {
    setBusyId(ws.id);
    try {
      const { error } = await supabase.from('workspaces').update({ is_active: true }).eq('id', ws.id);
      if (error) throw new Error(error.message);
      toast.success(`"${ws.name}" reativado.`);
      await Promise.all([refreshWorkspaces(), loadInactive()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao reativar');
    } finally {
      setBusyId(null);
    }
  };

  /* ── Confirma desativação (com ou sem remoção de ações) ── */
  const confirmDeactivate = async (removeActions: boolean) => {
    if (!deactivating || busyId) return;
    const { ws, actionCount } = deactivating;
    setBusyId(ws.id);
    try {
      if (removeActions && actionCount > 0) {
        // O trigger BEFORE DELETE enfileira a remoção dos eventos no Google
        const { error } = await supabase.from('actions').delete().eq('workspace_id', ws.id);
        if (error) throw new Error(`Remover ações: ${error.message}`);
      }
      const { error } = await supabase.from('workspaces').update({ is_active: false }).eq('id', ws.id);
      if (error) throw new Error(error.message);
      toast.success(
        removeActions && actionCount > 0
          ? `"${ws.name}" desativado e ${actionCount} ação(ões) removida(s) — os eventos saem do Google em até 1 min.`
          : `"${ws.name}" desativado (dados preservados).`,
      );
      setDeactivating(null);
      await Promise.all([refreshWorkspaces(), loadInactive()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao desativar');
    } finally {
      setBusyId(null);
    }
  };

  const ClientCard = ({ ws, active }: { ws: Workspace; active: boolean }) => {
    const location = [ws.city, ws.state].filter(Boolean).join(', ');
    return (
      <Card className={cn(
        'group transition-all duration-200',
        active ? 'hover:shadow-lg hover:shadow-gray-200/70 hover:border-primary-200' : 'opacity-80',
      )}>
        <div className="flex items-start gap-3.5">
          <div className={cn('rounded-xl ring-1 ring-black/5 shadow-sm overflow-hidden shrink-0', !active && 'grayscale')}>
            <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size="lg" />
          </div>
          <div
            className={cn('flex-1 min-w-0', active && 'cursor-pointer')}
            onClick={() => { if (active) openClient(ws); }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={cn('font-semibold leading-tight truncate', active ? 'text-gray-900 group-hover:text-primary-700' : 'text-gray-500')}>
                {ws.name}
              </h3>
              <span className={cn(
                'px-2 py-0.5 rounded-full text-[10px] font-semibold',
                active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500',
              )}>
                {active ? 'Ativo' : 'Inativo'}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-1.5">
              {(ws.segment ?? '').trim() ? (
                <span className="px-2 py-0.5 rounded-full bg-gray-50 border border-gray-100 text-[11px] font-medium text-gray-600">
                  {ws.segment}
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-gray-50 border border-dashed border-gray-200 text-[11px] text-gray-400">
                  Sem segmento
                </span>
              )}
              <span className="text-xs text-gray-400 flex items-center gap-1">
                <MapPin className="w-3 h-3 text-gray-300" />
                {location || 'Localização não informada'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
            <Switch
              on={active}
              busy={busyId === ws.id}
              title={active ? 'Desativar cliente' : 'Reativar cliente'}
              onToggle={() => { if (active) askDeactivate(ws); else reactivate(ws); }}
            />
            {active && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); openEdit(ws); }}
                  className="p-1.5 rounded-lg bg-white/90 backdrop-blur border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors shadow-sm"
                  title="Editar"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => openClient(ws)}
                  className="w-6 h-6 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center transition-all duration-200 group-hover:bg-primary-50 group-hover:border-primary-200"
                  title="Abrir agenda do cliente"
                >
                  <ChevronRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-primary-500 transition-colors" />
                </button>
              </>
            )}
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <PageHeader title="Clientes" subtitle="Gerencie os workspaces de cada cliente" />
        <Button onClick={() => setWizardOpen(true)}>
          <Plus className="w-4 h-4" />
          Novo cliente
        </Button>
      </div>

      {workspaces.length === 0 && inactive.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="Nenhum cliente cadastrado"
            description="Crie seu primeiro workspace para começar a planejar."
            action={<Button onClick={() => setWizardOpen(true)}>+ Novo cliente</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500">
              {workspaces.length} ativo{workspaces.length !== 1 ? 's' : ''}
              {inactive.length > 0 && ` · ${inactive.length} inativo${inactive.length !== 1 ? 's' : ''}`}
            </span>
            <span className="flex-1 h-px bg-gray-100" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {workspaces.map(ws => <ClientCard key={ws.id} ws={ws} active />)}
          </div>

          {inactive.length > 0 && (
            <>
              <div className="flex items-center gap-2 pt-2">
                <Power className="w-3.5 h-3.5 text-gray-400" />
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Desativados</span>
                <span className="flex-1 h-px bg-gray-100" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {inactive.map(ws => <ClientCard key={ws.id} ws={ws} active={false} />)}
              </div>
            </>
          )}
        </>
      )}

      {/* Onboarding Wizard completo */}
      <ClientWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        environment="sharks_company"
        onCreated={() => { refreshWorkspaces(); loadInactive(); }}
      />

      {/* Edit Client */}
      <ClientEditModal
        open={!!editing}
        onClose={() => setEditing(null)}
        client={editing}
        onSaved={() => { refreshWorkspaces(); loadInactive(); }}
      />

      {/* Modal de desativação */}
      <Modal isOpen={!!deactivating} onClose={() => setDeactivating(null)} title="Desativar cliente" size="sm">
        {deactivating && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Desativar <strong>{deactivating.ws.name}</strong>? Ele sai dos seletores e da agenda,
              mas <strong>todos os dados são preservados</strong> (reativável a qualquer momento).
            </p>
            {deactivating.actionCount > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                <p className="text-sm font-semibold text-amber-800">
                  {deactivating.actionCount} ação(ões) cadastrada(s) neste cliente
                </p>
                <p className="text-xs text-amber-700">
                  Remover as ações também apaga os eventos vinculados no Google Agenda
                  (processado pelo worker de sincronização em até 1 minuto).
                </p>
              </div>
            )}
            <div className="flex flex-col gap-2 pt-1">
              {deactivating.actionCount > 0 && (
                <Button variant="danger" loading={busyId === deactivating.ws.id} onClick={() => confirmDeactivate(true)}>
                  Desativar e remover ações
                </Button>
              )}
              <Button variant="ghost" loading={busyId === deactivating.ws.id} onClick={() => confirmDeactivate(false)}>
                Desativar somente (preservar tudo)
              </Button>
              <Button variant="ghost" onClick={() => setDeactivating(null)}>Cancelar</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
