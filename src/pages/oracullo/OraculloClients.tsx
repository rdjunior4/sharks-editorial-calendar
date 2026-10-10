import PageHeader from '@/components/ui/PageHeader';
import { useEffect, useState, useCallback } from 'react';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import EmptyState from '@/components/ui/EmptyState';
import WorkspaceLogo from '@/components/ui/WorkspaceLogo';
import Badge from '@/components/ui/Badge';
import ClientWizard from '@/components/clients/ClientWizard';
import ClientEditModal, { type ClientEditTarget } from '@/components/clients/ClientEditModal';
import { fetchAllClients, deactivateClient, createFullClients, updateClient, type ClientWithOrg } from '@/lib/clientFactory';
import { ENVIRONMENT_META, type EnvironmentType, type FormatFrequency } from '@/types';
import { supabase } from '@/lib/supabase';
import { defaultFormatFrequency } from '@/components/editorial/FormatFrequencyStepper';
import { toast } from 'sonner';
import { Plus, Building2, MapPin, Loader2, Pencil, Trash2, ArrowRightLeft, UserPlus, ShieldCheck, Layers, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/utils';

const ENVS: EnvironmentType[] = ['sharks_company', 'estrategos'];

interface ClientUserRef {
  id: string;
  full_name: string;
  email: string;
}

interface ClientGroup {
  key: string;
  name: string;
  logo: string | null;
  segment: string | null;
  city: string | null;
  state: string | null;
  country: string;
  since: string;
  envs: EnvironmentType[];
  wss: ClientWithOrg[];
  primary: ClientWithOrg;
  clientUser: ClientUserRef | null;
}

async function functionErrorMessage(error: unknown): Promise<string> {
  if (error && typeof error === 'object' && 'context' in error) {
    try {
      const body = await (error as { context: Response }).context.clone().json();
      if (body && typeof body.error === 'string') return body.error;
    } catch { /* */ }
  }
  return error instanceof Error ? error.message : 'Erro inesperado';
}

function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function OraculloClients() {
  const [groups, setGroups] = useState<ClientGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<ClientEditTarget | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ClientGroup | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Ambientes do cliente (seleção na edição)
  const [envsTarget, setEnvsTarget] = useState<ClientGroup | null>(null);
  const [pendingEnvs, setPendingEnvs] = useState<EnvironmentType[]>([]);
  const [applyingEnvs, setApplyingEnvs] = useState(false);

  // Criar acesso do cliente
  const [accessTarget, setAccessTarget] = useState<ClientGroup | null>(null);
  const [accessForm, setAccessForm] = useState({ full_name: '', email: '', password: '' });
  const [creatingAccess, setCreatingAccess] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, memsRes, cuRes] = await Promise.all([
        fetchAllClients(),
        supabase.from('memberships').select('workspace_id, user_id').eq('role', 'manager'),
        supabase.from('users').select('id, full_name, email').eq('role', 'client'),
      ]);
      const cuById = new Map(
        ((cuRes.data ?? []) as Array<{ id: string; full_name: string; email: string }>).map(u => [u.id, u]),
      );
      const wsUser = new Map<string, ClientUserRef>();
      for (const m of ((memsRes.data ?? []) as Array<{ workspace_id: string; user_id: string }>)) {
        const cu = cuById.get(m.user_id);
        if (cu && !wsUser.has(m.workspace_id)) {
          wsUser.set(m.workspace_id, { id: cu.id, full_name: cu.full_name, email: cu.email });
        }
      }

      // Agrupa por empresa (nome normalizado): 1 card, N workspaces (1 por ambiente)
      const groupMap = new Map<string, ClientGroup>();
      for (const c of list) {
        const key = normKey(c.name);
        let g = groupMap.get(key);
        if (!g) {
          g = {
            key,
            name: c.name,
            logo: c.logo_url,
            segment: c.segment,
            city: c.city,
            state: c.state,
            country: c.country ?? 'Brasil',
            since: c.created_at,
            envs: [],
            wss: [],
            primary: c,
            clientUser: null,
          };
          groupMap.set(key, g);
        }
        g.wss.push(c);
        const env = (c.organization?.environment ?? 'sharks_company') as EnvironmentType;
        if (!g.envs.includes(env)) g.envs.push(env);
        if (!g.logo && c.logo_url) g.logo = c.logo_url;
        if (c.created_at < g.since) g.since = c.created_at;
        const cu = wsUser.get(c.id);
        if (cu && !g.clientUser) g.clientUser = cu;
      }
      setGroups([...groupMap.values()].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Erro ao carregar clientes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('oracullo-clients')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workspaces' }, () => { load(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const handleDelete = async () => {
    if (!deleteConfirm || deleting) return;
    setDeleting(true);
    try {
      for (const w of deleteConfirm.wss) await deactivateClient(w.id);
      toast.success(`Cliente "${deleteConfirm.name}" removido de todos os ambientes.`);
      setDeleteConfirm(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover cliente');
    } finally {
      setDeleting(false);
    }
  };

  /* ─── Ambientes do cliente (seleção na edição) ─── */
  const openEnvs = (g: ClientGroup) => {
    setEnvsTarget(g);
    setPendingEnvs([...g.envs]);
  };

  const toggleEnv = (env: EnvironmentType) => {
    setPendingEnvs(prev => (prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env]));
  };

  const applyEnvChanges = async () => {
    if (!envsTarget || applyingEnvs) return;
    const g = envsTarget;
    const toAdd = pendingEnvs.filter(e => !g.envs.includes(e));
    const toRemove = g.envs.filter(e => !pendingEnvs.includes(e));
    if (toAdd.length === 0 && toRemove.length === 0) {
      setEnvsTarget(null);
      return;
    }
    setApplyingEnvs(true);
    try {
      // ─── INCLUIR ambiente ───
      for (const env of toAdd) {
        const { data: org } = await supabase
          .from('organizations')
          .select('id')
          .eq('environment', env)
          .maybeSingle();
        if (!org) throw new Error(`Organização ${env} não encontrada`);

        // 1. Reativa workspace inativo da mesma empresa (dados preservados)
        const { data: cands } = await supabase
          .from('workspaces')
          .select('id, name, is_active')
          .eq('organization_id', org.id);
        const match = (cands ?? []).find(w => normKey(w.name ?? '') === normKey(g.name));
        if (match) {
          if (!match.is_active) {
            const { error } = await supabase.from('workspaces').update({ is_active: true }).eq('id', match.id);
            if (error) throw new Error(error.message);
          }
          continue;
        }

        // 2. Cria o espelho (workspace + pilares + perfil + datas do cadastro principal)
        const { data: prof } = await supabase
          .from('editorial_profiles')
          .select('format_frequency')
          .eq('workspace_id', g.primary.id)
          .maybeSingle();
        const { data: dates } = await supabase
          .from('strategic_dates')
          .select('title, date, locality, category, relevance, description, is_recurring')
          .eq('workspace_id', g.primary.id);
        await createFullClients([env], {
          name: g.name,
          segment: g.segment,
          city: g.city,
          state: g.state,
          country: g.country || 'Brasil',
          logo_url: g.logo,
          format_frequency: ((prof as { format_frequency?: FormatFrequency } | null)?.format_frequency ?? defaultFormatFrequency()) as FormatFrequency,
          selectedDates: (dates ?? []) as unknown as import('@/data/brDates').StrategicDateDraft[],
        });
      }

      // ─── DESATIVAR ambiente (mantém dados, reversível) ───
      for (const env of toRemove) {
        for (const w of g.wss.filter(w => (w.organization?.environment ?? 'sharks_company') === env)) {
          await deactivateClient(w.id);
        }
      }

      const addedLabels = toAdd.map(e => ENVIRONMENT_META[e].short);
      const removedLabels = toRemove.map(e => ENVIRONMENT_META[e].short);
      const parts: string[] = [];
      if (toAdd.length > 0) parts.push(`incluído em ${addedLabels.join(' + ')}`);
      if (toRemove.length > 0) parts.push(`removido de ${removedLabels.join(' + ')}`);
      toast.success(`"${g.name}": ${parts.join('; ')}.`);
      setEnvsTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar ambientes');
    } finally {
      setApplyingEnvs(false);
    }
  };

  /* ─── Criar acesso do cliente ─── */
  const openCreateAccess = (g: ClientGroup) => {
    setAccessTarget(g);
    setAccessForm({ full_name: g.name, email: '', password: '' });
  };

  const handleCreateAccess = async () => {
    if (!accessTarget || creatingAccess) return;
    if (!accessForm.email.trim() || !accessForm.password || !accessForm.full_name.trim()) {
      toast.error('Preencha nome, e-mail e senha');
      return;
    }
    setCreatingAccess(true);
    try {
      let linked = false;
      let emailSent = false;
      for (const w of accessTarget.wss) {
        const env = (w.organization?.environment ?? 'sharks_company') as EnvironmentType;
        const { data, error } = await supabase.functions.invoke('admin-create-user', {
          body: {
            email: accessForm.email.trim(),
            password: accessForm.password,
            full_name: accessForm.full_name.trim(),
            role: 'client',
            environment: env,
            workspace_id: w.id,
          },
        });
        if (error) throw new Error(await functionErrorMessage(error));
        if (data?.error) throw new Error(data.error);
        linked = true;
        if (data?.email_sent) emailSent = true;
      }
      toast.success(
        `Acesso do cliente "${accessTarget.name}" criado nos ambientes da empresa!${emailSent ? ' E-mail de boas-vindas enviado.' : ''}`,
      );
      setAccessTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao criar acesso');
    } finally {
      setCreatingAccess(false);
    }
  };

  const envCount = (env: EnvironmentType) => groups.filter(g => g.envs.includes(env)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageHeader title="Clientes" subtitle="Visão consolidada de todos os ambientes" />
        <Button onClick={() => setWizardOpen(true)}>
          <Plus className="w-4 h-4" />
          Novo cliente
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3 sm:max-w-md">
        <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
          <p className="text-xl font-bold text-gray-900 tabular-nums">{groups.length}</p>
          <p className="text-[11px] font-medium text-gray-500">Empresas</p>
        </div>
        <div className="rounded-xl border border-primary-100 bg-primary-50 p-3 text-center">
          <p className="text-xl font-bold text-primary-700 tabular-nums">{envCount('sharks_company')}</p>
          <p className="text-[11px] font-medium text-primary-600">🦈 Sharks Company</p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-center">
          <p className="text-xl font-bold text-emerald-700 tabular-nums">{envCount('estrategos')}</p>
          <p className="text-[11px] font-medium text-emerald-600">📊 Estratégos</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 text-primary-500 animate-spin" /></div>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="Nenhum cliente cadastrado"
            description="Crie o primeiro workspace em qualquer ambiente para começar."
            action={<Button onClick={() => setWizardOpen(true)}>+ Novo cliente</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {groups.map(g => (
            <Card key={g.key} className="relative group flex flex-col">
              <div className="flex items-start gap-3">
                <WorkspaceLogo name={g.name} logoUrl={g.logo} size="lg" />
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">{g.name}</h3>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {g.envs.map(env => (
                      <Badge key={env} variant={env === 'sharks_company' ? 'info' : 'success'} size="sm">
                        {ENVIRONMENT_META[env].emoji} {ENVIRONMENT_META[env].short}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5 flex items-center gap-1 flex-wrap">
                    <Building2 className="w-3 h-3 shrink-0 text-gray-400" />
                    {g.segment ?? 'Gestão'}
                    <span className="text-gray-300">·</span>
                    <MapPin className="w-3 h-3 shrink-0 text-gray-400" />
                    {g.city || 'Sem cidade'}, {g.state || '--'}
                  </p>
                </div>
              </div>

              <div className="mt-auto pt-3 border-t border-gray-100 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0 text-[11px] text-gray-400">
                  <span className="truncate">Desde {formatDate(g.since) || '—'}</span>
                  {g.clientUser && (
                    <span
                      title={`Acesso do cliente: ${g.clientUser.email}`}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-[10px] font-medium shrink-0"
                    >
                      <ShieldCheck className="w-3 h-3" />
                      Acesso
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-1 shrink-0 opacity-70 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  {!g.clientUser && (
                    <button
                      onClick={() => openCreateAccess(g)}
                      className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-colors"
                      title="Criar acesso do cliente (usuário + vínculo às empresas)"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => openEnvs(g)}
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors"
                    title="Selecionar ambientes"
                  >
                    <Layers className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setEditing({
                      id: g.primary.id,
                      name: g.name,
                      segment: g.segment,
                      city: g.city,
                      state: g.state,
                      logo_url: g.logo,
                    })}
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors"
                    title="Editar"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(g)}
                    className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                    title="Excluir"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Wizard multi-ambiente (passo Ambiente no início) */}
      <ClientWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        environment={null}
        onCreated={() => { load(); }}
      />

      {/* Edit Client */}
      <ClientEditModal
        open={!!editing}
        onClose={() => setEditing(null)}
        client={editing}
        onSaved={() => { load(); }}
      />

      {/* Delete Confirmation */}
      <Modal isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Excluir Cliente" size="sm">
        <p className="text-sm text-gray-600">
          Tem certeza que deseja excluir <strong>{groups.find(c => c.primary.id === deleteConfirm?.primary.id)?.name}</strong>?
        </p>
        <p className="text-xs text-gray-400 mt-2">
          Esta ação irá desativar o cliente em todos os ambientes. Os dados não serão apagados permanentemente.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>Cancelar</Button>
          <Button variant="danger" onClick={handleDelete} loading={deleting}>
            Excluir
          </Button>
        </div>
      </Modal>

      {/* Selecionar ambientes do cliente */}
      <Modal isOpen={!!envsTarget} onClose={() => setEnvsTarget(null)} title="Ambientes do cliente" size="sm">
        {envsTarget && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 bg-gray-50 rounded-lg p-3">
              <WorkspaceLogo name={envsTarget.name} logoUrl={envsTarget.logo} size="md" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{envsTarget.name}</p>
                <p className="text-xs text-gray-500">Selecione em quais ambientes esta empresa atua</p>
              </div>
            </div>
            <div className="space-y-2">
              {ENVS.map(env => {
                const meta = ENVIRONMENT_META[env];
                const selected = pendingEnvs.includes(env);
                return (
                  <button
                    key={env}
                    type="button"
                    onClick={() => toggleEnv(env)}
                    className={cn(
                      'w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-colors',
                      selected ? 'border-primary-500 bg-primary-50' : 'border-gray-200 bg-white hover:border-gray-300'
                    )}
                  >
                    <div
                      className={cn(
                        'w-5 h-5 rounded flex items-center justify-center shrink-0 border-2',
                        selected ? 'bg-primary-500 border-primary-500 text-white' : 'border-gray-300'
                      )}
                    >
                      {selected && <Check className="w-3.5 h-3.5" />}
                    </div>
                    <span className="text-xl leading-none">{meta.emoji}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-gray-900">{meta.label}</span>
                      <span className="block text-[11px] text-gray-500">{meta.short}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-start gap-2 bg-primary-50 text-primary-700 text-xs px-3 py-2 rounded-lg">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                Incluir cria o cadastro no ambiente (com pilares, perfil e datas da empresa).
                Remover desativa a empresa naquele ambiente — os dados ficam preservados e a remoção é reversível.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEnvsTarget(null)}>Cancelar</Button>
              <Button onClick={applyEnvChanges} loading={applyingEnvs} disabled={pendingEnvs.length === 0}>
                Salvar ambientes
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Criar acesso do cliente */}
      <Modal isOpen={!!accessTarget} onClose={() => setAccessTarget(null)} title="Criar acesso do cliente" size="sm">
        {accessTarget && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 bg-gray-50 rounded-lg p-3">
              <Building2 className="w-4 h-4 text-gray-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{accessTarget.name}</p>
                <p className="text-xs text-gray-500">
                  {accessTarget.envs.map(e => ENVIRONMENT_META[e as EnvironmentType].emoji + ' ' + ENVIRONMENT_META[e as EnvironmentType].short).join(' · ')}
                  {' '}· usuário com papel Cliente vinculado a cada empresa
                </p>
              </div>
            </div>
            <Input
              label="Nome completo"
              value={accessForm.full_name}
              onChange={(e) => setAccessForm(f => ({ ...f, full_name: e.target.value }))}
              placeholder="Ex: Contato DILATI"
            />
            <Input
              label="E-mail do cliente"
              type="email"
              value={accessForm.email}
              onChange={(e) => setAccessForm(f => ({ ...f, email: e.target.value }))}
              placeholder="email@empresa.com"
            />
            <Input
              label="Senha"
              type="password"
              value={accessForm.password}
              onChange={(e) => setAccessForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Mínimo 6 caracteres"
            />
            <p className="text-[11px] text-gray-400">
              O cliente receberá e-mail de boas-vindas com as credenciais (se o envio estiver configurado).
              Se o e-mail já existir no sistema, o usuário é vinculado às empresas em vez de recriado.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAccessTarget(null)}>Cancelar</Button>
              <Button onClick={handleCreateAccess} loading={creatingAccess} disabled={!accessForm.full_name.trim() || !accessForm.email.trim() || !accessForm.password}>
                <UserPlus className="w-4 h-4" />
                Criar acesso
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
