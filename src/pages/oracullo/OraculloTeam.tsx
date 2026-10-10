import PageHeader from '@/components/ui/PageHeader';
import { useState, useEffect, useCallback } from 'react';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Avatar from '@/components/ui/Avatar';
import EmptyState from '@/components/ui/EmptyState';
import Badge from '@/components/ui/Badge';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  PERMISSION_META, ALL_PERMISSIONS, defaultPermissions, togglePerm, permCount,
  type Permission,
} from '@/lib/permissions';
import { ENVIRONMENT_META, type EnvironmentType } from '@/types';
import { toast } from 'sonner';
import {
  Plus, Users, Pencil, Trash2, Shield, Mail,
  ChevronDown, ChevronRight, Eye, EyeOff, Check,
  Settings, Building2, CheckCircle2, Link2, Unlink,
} from 'lucide-react';

/* ─── Types ─── */
interface EnvMembership {
  environment: EnvironmentType;
  role: 'admin' | 'team';
}

interface Workspace {
  id: string;
  name: string;
  segment?: string;
}

interface MemberWithAccess {
  id: string;
  email: string;
  full_name: string;
  global_role: string;
  avatar_url?: string;
  environments: EnvMembership[];
  permissions: Record<EnvironmentType, Permission[]>;
  workspaces: Record<EnvironmentType, Workspace[]>;
}

/* ─── Helpers ─── */
const ENV_ORDER: EnvironmentType[] = ['sharks_company', 'estrategos'];

const GLOBAL_ROLE_LABELS: Record<string, string> = {
  oracullo_admin: 'Guardião Oracullo',
  admin_sharks: 'Admin Sharks',
  sharks_team: 'Equipe Sharks',
  client: 'Cliente',
};

const ENV_ROLE_LABELS: Record<string, string> = {
  admin: 'Admin do ambiente',
  team: 'Time',
};

function envUnlinkLabel(env: EnvironmentType): string {
  return `Remover de ${ENVIRONMENT_META[env].short}`;
}

/* ─── Component ─── */
export default function OraculloTeam() {
  const { user: currentUser, isOracullo } = useAuth();
  const [members, setMembers] = useState<MemberWithAccess[]>([]);
  const [allWorkspaces, setAllWorkspaces] = useState<Workspace[]>([]);
  const [wsEnvById, setWsEnvById] = useState<Map<string, EnvironmentType>>(new Map());
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<EnvironmentType>('sharks_company');

  // Modals
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<MemberWithAccess | null>(null);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  // Invite form
  const [inviteStep, setInviteStep] = useState(0);
  const [inviteForm, setInviteForm] = useState({
    full_name: '',
    email: '',
    password: '',
    showPassword: false,
    environments: ['sharks_company'] as EnvironmentType[],
    envRoles: {
      sharks_company: 'team',
      estrategos: 'team',
    } as Record<EnvironmentType, 'admin' | 'team'>,
    permissions: [] as Permission[],
    workspace_ids: [] as string[],
  });

  // Role escolhida ao vincular um membro existente a um ambiente ausente
  const [linkRoles, setLinkRoles] = useState<Record<EnvironmentType, 'admin' | 'team'>>({
    sharks_company: 'team',
    estrategos: 'team',
  });

  // Edit form
  const [editForm, setEditForm] = useState({
    full_name: '',
    permissions: [] as Permission[],
    workspaces: {} as Partial<Record<EnvironmentType, string[]>>,
    environments: [] as EnvironmentType[],
    envRoles: {
      sharks_company: 'team',
      estrategos: 'team',
    } as Record<EnvironmentType, 'admin' | 'team'>,
  });

  const [submitting, setSubmitting] = useState(false);

  /* ─── Load data ─── */
  const loadData = useCallback(async () => {
    setLoading(true);

    const [ueRes, wsRes, envMapRes] = await Promise.all([
      supabase
        .from('user_environments')
        .select('environment, role, user_id')
        .in('role', ['admin', 'team']),
      supabase.from('workspaces').select('id, name, segment').eq('is_active', true).order('name'),
      supabase.rpc('ws_env_map'),
    ]);

    if (ueRes.error) console.error('[oracullo-team] user_environments load error:', ueRes.error.message);

    const wsList = (wsRes.data as unknown as Workspace[]) || [];
    setAllWorkspaces(wsList);

    // ws_env_map: workspace_id → environment (join workspaces × organizations)
    const wsEnv = new Map<string, EnvironmentType>();
    for (const r of ((envMapRes.data ?? []) as Array<{ id: string; environment: string }>)) {
      wsEnv.set(r.id, r.environment as EnvironmentType);
    }
    setWsEnvById(wsEnv);

    // Cada linha de user_environments já traz o ambiente — agrupar por usuário
    const ueRows = (ueRes.data as unknown as Array<{
      user_id: string;
      environment: string;
      role: 'admin' | 'team';
    }>) ?? [];

    // user_environments nao tem FK exposta para public.users — o embed
    // PostgREST falhava (PGRST200); busca os usuarios em segunda chamada.
    const userIds = [...new Set(ueRows.map(r => r.user_id))];
    const usersRes = userIds.length > 0
      ? await supabase.from('users').select('id, email, full_name, role, avatar_url').in('id', userIds)
      : null;
    if (usersRes?.error) console.error('[oracullo-team] users load error:', usersRes.error.message);
    const usersById = new Map<string, { id: string; email: string; full_name: string; role: string; avatar_url: string | null }>(
      ((usersRes?.data ?? []) as Array<{ id: string; email: string; full_name: string; role: string; avatar_url: string | null }>)
        .map(u => [u.id, u]),
    );

    const enrichedMap = new Map<string, MemberWithAccess>();

    for (const row of ueRows) {
      const uid = row.user_id;
      const user = usersById.get(uid);
      if (!user) continue;
      if (!enrichedMap.has(uid)) {
        enrichedMap.set(uid, {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          global_role: user.role,
          avatar_url: user.avatar_url ?? undefined,
          environments: [],
          permissions: {} as Record<EnvironmentType, Permission[]>,
          workspaces: {} as Record<EnvironmentType, Workspace[]>,
        });
      }
      const member = enrichedMap.get(uid)!;
      const env = row.environment as EnvironmentType;
      if (!member.environments.some(e => e.environment === env)) {
        member.environments.push({ environment: env, role: row.role });
      }
    }

    // Permissões (globais por usuário) + clientes atribuídos por ambiente
    const enriched: MemberWithAccess[] = await Promise.all(
      Array.from(enrichedMap.values()).map(async m => {
        const [permsRes, memRes] = await Promise.all([
          supabase.from('team_member_access').select('*').eq('user_id', m.id),
          supabase
            .from('memberships')
            .select('workspace_id, workspace:workspaces(id, name)')
            .eq('user_id', m.id)
            .eq('role', 'manager'),
        ]);

        const perms = (permsRes.data as unknown as Permission[]) || [];
        const allMemWs = ((memRes.data as unknown as { workspace: Workspace | null }[]) || [])
          .map(r => r.workspace)
          .filter((ws): ws is Workspace => !!ws);

        const perEnvPerms: Record<string, Permission[]> = {};
        const perEnvWs: Record<string, Workspace[]> = {};
        for (const env of m.environments) {
          perEnvPerms[env.environment] = perms;
          perEnvWs[env.environment] = allMemWs.filter(ws => wsEnv.get(ws.id) === env.environment);
        }

        return {
          ...m,
          permissions: perEnvPerms as Record<EnvironmentType, Permission[]>,
          workspaces: perEnvWs as Record<EnvironmentType, Workspace[]>,
        };
      }),
    );

    setMembers(enriched);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  /* ─── Helpers ─── */
  async function functionErrorMessage(error: unknown): Promise<string> {
    if (error && typeof error === 'object' && 'context' in error) {
      try {
        const body = await (error as { context: Response }).context.clone().json();
        if (body && typeof body.error === 'string') return body.error;
      } catch { /* */ }
    }
    return error instanceof Error ? error.message : 'Erro inesperado';
  }

  /* ─── Handlers ─── */
  const handleInvite = async () => {
    const envs = inviteForm.environments;
    if (!inviteForm.full_name.trim() || !inviteForm.email.trim() || !inviteForm.password.trim() || submitting) return;
    if (envs.length === 0) {
      toast.error('Selecione pelo menos um ambiente');
      setInviteStep(1);
      return;
    }
    setSubmitting(true);
    try {
      const primaryEnv = envs[0];
      const { data, error } = await supabase.functions.invoke('admin-create-user', {
        body: {
          email: inviteForm.email.trim(),
          password: inviteForm.password,
          full_name: inviteForm.full_name.trim(),
          role: 'sharks_team',
          environment: primaryEnv,
          env_role: inviteForm.envRoles[primaryEnv],
          permissions: inviteForm.permissions.length > 0 ? inviteForm.permissions : defaultPermissions(),
          workspace_ids: inviteForm.workspace_ids,
        },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      if (data?.error) throw new Error(data.error);

      // Ambientes adicionais: vincular o usuário recém-criado
      for (const env of envs.slice(1)) {
        const linkRes = await supabase.functions.invoke('admin-link-user-env', {
          body: {
            op: 'link',
            user_id: data?.user_id,
            environment: env,
            env_role: inviteForm.envRoles[env],
          },
        });
        if (linkRes.error) throw new Error(await functionErrorMessage(linkRes.error));
        if (linkRes.data?.error) throw new Error(linkRes.data.error);
      }

      const envLabels = envs.map(e => ENVIRONMENT_META[e].short).join(' + ');
      toast.success(data?.linked
        ? `"${inviteForm.full_name}" já tinha conta e foi vinculado a ${envLabels}!`
        : `"${inviteForm.full_name}" criado e vinculado a ${envLabels}!`);
      setInviteOpen(false);
      resetInviteForm();
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao criar usuário');
    } finally {
      setSubmitting(false);
    }
  };

  const resetInviteForm = () => {
    setInviteForm({
      full_name: '', email: '', password: '', showPassword: false,
      environments: ['sharks_company'],
      envRoles: { sharks_company: 'team', estrategos: 'team' },
      permissions: defaultPermissions(), workspace_ids: [],
    });
    setInviteStep(0);
  };

  const openInvite = () => { resetInviteForm(); setInviteOpen(true); };

  const openEdit = (member: MemberWithAccess) => {
    setEditingMember(member);
    setEditForm({
      full_name: member.full_name,
      permissions: member.permissions[activeTab]?.length > 0 ? member.permissions[activeTab] : defaultPermissions(),
      workspaces: Object.fromEntries(
        ENV_ORDER.map(env => [env, member.workspaces[env]?.map(w => w.id) ?? []]),
      ) as Partial<Record<EnvironmentType, string[]>>,
      environments: member.environments.map(e => e.environment),
      envRoles: {
        sharks_company: member.environments.find(e => e.environment === 'sharks_company')?.role ?? 'team',
        estrategos: member.environments.find(e => e.environment === 'estrategos')?.role ?? 'team',
      },
    });
    setEditOpen(true);
  };

  const handleUpdate = async () => {
    if (!editingMember || !editForm.full_name.trim() || submitting) return;
    if (editForm.environments.length === 0) {
      toast.error('Selecione pelo menos um ambiente.');
      return;
    }
    const currentEnvs = editingMember.environments.map(e => e.environment);
    const toUnlink = currentEnvs.filter(env => !editForm.environments.includes(env));
    if (editingMember.id === currentUser?.id && toUnlink.length > 0) {
      toast.error('Você não pode remover seus próprios ambientes.');
      return;
    }
    const toLink = editForm.environments.filter(env =>
      !currentEnvs.includes(env) ||
      editForm.envRoles[env] !== editingMember.environments.find(e => e.environment === env)?.role
    );
    setSubmitting(true);
    try {
      // 1) Novos ambientes / troca de função — antes do update, pois
      //    workspace_ids é validado contra a org de cada ambiente.
      for (const env of toLink) {
        const { data, error } = await supabase.functions.invoke('admin-link-user-env', {
          body: { op: 'link', user_id: editingMember.id, environment: env, env_role: editForm.envRoles[env] },
        });
        if (error) throw new Error(await functionErrorMessage(error));
        if (data?.error) throw new Error(data.error);
      }

      // 2) Nome, permissões e clientes — uma chamada por ambiente marcado.
      //    permissions é global (team_member_access nao tem ambiente);
      //    workspace_ids substitui apenas as memberships da org do ambiente.
      for (const env of editForm.environments) {
        const { data, error } = await supabase.functions.invoke('admin-update-user', {
          body: {
            user_id: editingMember.id,
            full_name: editForm.full_name.trim(),
            environment: env,
            permissions: editForm.permissions,
            workspace_ids: editForm.workspaces[env] ?? [],
          },
        });
        if (error) throw new Error(await functionErrorMessage(error));
        if (data?.error) throw new Error(data.error);
      }

      // 3) Ambientes desmarcados — unlink remove o vínculo e as memberships
      for (const env of toUnlink) {
        const { data: ud, error: ue } = await supabase.functions.invoke('admin-link-user-env', {
          body: { op: 'unlink', user_id: editingMember.id, environment: env },
        });
        if (ue) throw new Error(await functionErrorMessage(ue));
        if (ud?.error) throw new Error(ud.error);
      }

      const changes = [
        ...toLink.map(env => `+ ${ENVIRONMENT_META[env].short}`),
        ...toUnlink.map(env => `− ${ENVIRONMENT_META[env].short}`),
      ];
      toast.success(changes.length > 0 ? `Membro atualizado (${changes.join(', ')})` : 'Membro atualizado!');
      setEditOpen(false);
      setEditingMember(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLink = async (member: MemberWithAccess, env: EnvironmentType) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-link-user-env', {
        body: { op: 'link', user_id: member.id, environment: env, env_role: linkRoles[env] },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      if (data?.error) throw new Error(data.error);
      toast.success(`"${member.full_name}" vinculado a ${ENVIRONMENT_META[env].short}.`);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao vincular');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnlink = async (member: MemberWithAccess, env: EnvironmentType) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-link-user-env', {
        body: { op: 'unlink', user_id: member.id, environment: env },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      if (data?.error) throw new Error(data.error);
      toast.success(`"${member.full_name}" removido de ${ENVIRONMENT_META[env].short}.`);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (member: MemberWithAccess) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke('admin-delete-user', {
        body: { user_id: member.id },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      toast.success(`"${member.full_name}" removido permanentemente.`);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover');
    } finally {
      setSubmitting(false);
    }
  };

  /* ─── Derived ─── */
  const filteredMembers = members.filter(m => m.environments.some(e => e.environment === activeTab));

  /* ─── Render ─── */
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <PageHeader title="Time" subtitle="Gerencie membros e permissões em todos os ambientes" />
        {isOracullo && (
          <Button onClick={openInvite}>
            <Plus className="w-4 h-4" />
            Novo membro
          </Button>
        )}
      </div>

      {/* Environment tabs */}
      <div className="flex gap-2">
        {ENV_ORDER.map(env => {
          const meta = ENVIRONMENT_META[env];
          const count = members.filter(m => m.environments.some(e => e.environment === env)).length;
          return (
            <button
              key={env}
              onClick={() => setActiveTab(env)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === env
                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <span>{meta.emoji}</span>
              <span>{meta.short}</span>
              <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[11px] ${
                activeTab === env ? 'bg-primary-100 text-primary-600' : 'bg-gray-100 text-gray-500'
              }`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="w-8 h-8 border-4 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      ) : filteredMembers.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={`Nenhum membro em ${ENVIRONMENT_META[activeTab].short}`}
            description={`Adicione membros ao ambiente ${ENVIRONMENT_META[activeTab].short} para começar.`}
            action={isOracullo ? <Button onClick={openInvite}>+ Novo membro</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredMembers.map(member => {
            const isExpanded = expandedCard === member.id;
            const envMembership = member.environments.find(e => e.environment === activeTab);
            const clientCount = member.workspaces[activeTab]?.length ?? 0;
            const perms = member.permissions[activeTab] ?? [];
            const permSummary = perms.filter(p => permCount(p) > 1).length;
            const missingEnvs = ENV_ORDER.filter(env => !member.environments.some(e => e.environment === env));

            return (
              <Card key={member.id} className="overflow-hidden">
                {/* Main row */}
                <div
                  className="flex items-center gap-4 p-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                  onClick={() => setExpandedCard(isExpanded ? null : member.id)}
                >
                  <Avatar name={member.full_name} src={member.avatar_url} size="lg" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-gray-900">{member.full_name}</h3>
                      <Badge variant={member.global_role === 'oracullo_admin' ? 'purple' : member.global_role === 'admin_sharks' ? 'primary' : 'info'} size="sm">
                        {GLOBAL_ROLE_LABELS[member.global_role] || member.global_role}
                      </Badge>
                      {envMembership && (
                        <Badge variant={envMembership.role === 'admin' ? 'primary' : 'default'} size="sm">
                          {ENVIRONMENT_META[activeTab].emoji} {ENV_ROLE_LABELS[envMembership.role]}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                      <Mail className="w-3 h-3" />
                      {member.email}
                    </p>
                  </div>

                  {/* Summary badges */}
                  <div className="hidden sm:flex items-center gap-2">
                    {clientCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-primary-50 text-primary-700">
                        <Building2 className="w-3 h-3" />
                        {clientCount} cliente{clientCount > 1 ? 's' : ''}
                      </span>
                    )}
                    {permSummary > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-emerald-50 text-emerald-700">
                        <Settings className="w-3 h-3" />
                        {permSummary} módulo{permSummary > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  {isOracullo && (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => openEdit(member)}
                        className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition-colors"
                        title="Editar"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {envMembership && member.id !== currentUser?.id && (
                        <button
                          onClick={() => handleUnlink(member, activeTab)}
                          className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title={envUnlinkLabel(activeTab)}
                        >
                          <Unlink className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  )}

                  <div className="text-gray-400">
                    {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-gray-100 p-4 bg-gray-50/30 space-y-4">
                    {/* All environments */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Ambientes</h4>
                      <div className="flex flex-wrap gap-2">
                        {member.environments.map(env => (
                          <span key={env.environment} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-primary-50 text-primary-700 font-medium">
                            <CheckCircle2 className="w-3 h-3" />
                            {ENVIRONMENT_META[env.environment].emoji} {ENVIRONMENT_META[env.environment].short}
                            <span className="text-primary-400">·</span>
                            {ENV_ROLE_LABELS[env.role]}
                          </span>
                        ))}
                      </div>

                      {/* Vincular a ambientes ausentes */}
                      {isOracullo && missingEnvs.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <p className="text-xs text-gray-400">Vincular a outro ambiente:</p>
                          {missingEnvs.map(env => (
                            <div key={env} className="flex items-center gap-2">
                              <select
                                value={linkRoles[env]}
                                onChange={(e) => setLinkRoles(p => ({ ...p, [env]: e.target.value as 'admin' | 'team' }))}
                                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600"
                              >
                                <option value="team">Time</option>
                                <option value="admin">Admin do ambiente</option>
                              </select>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleLink(member, env)}
                                loading={submitting}
                                disabled={submitting}
                              >
                                <Link2 className="w-3.5 h-3.5" />
                                {ENVIRONMENT_META[env].emoji} Vincular a {ENVIRONMENT_META[env].short}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Permissions for active environment */}
                    {perms.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                          Permissões — {ENVIRONMENT_META[activeTab].short}
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {perms.map(perm => {
                            const meta = PERMISSION_META[perm.permission];
                            if (!meta) return null;
                            const Icon = meta.icon;
                            return (
                              <div key={perm.permission} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-gray-200">
                                <Icon className="w-4 h-4 text-gray-400 shrink-0" />
                                <span className="text-sm font-medium text-gray-700 flex-1">{meta.label}</span>
                                <div className="flex items-center gap-0.5">
                                  {perm.can_create && <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">C</span>}
                                  {perm.can_read && <span className="text-[10px] px-1 py-0.5 rounded bg-primary-100 text-primary-700">L</span>}
                                  {perm.can_update && <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">U</span>}
                                  {perm.can_delete && <span className="text-[10px] px-1 py-0.5 rounded bg-red-100 text-red-700">D</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Assigned clients for active environment */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                        {envMembership?.role === 'admin' ? `Clientes — acesso total (${ENVIRONMENT_META[activeTab].short})` : `Clientes atribuídos (${ENVIRONMENT_META[activeTab].short})`}
                      </h4>
                      {envMembership?.role === 'admin' ? (
                        <div className="flex flex-wrap gap-2">
                          {(member.workspaces[activeTab] ?? []).map(ws => (
                            <span key={ws.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-primary-50 text-primary-700 font-medium">
                              <CheckCircle2 className="w-3 h-3" />
                              {ws.name}
                            </span>
                          ))}
                        </div>
                      ) : (member.workspaces[activeTab]?.length ?? 0) > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {member.workspaces[activeTab]!.map(ws => (
                            <span key={ws.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-primary-50 text-primary-700 font-medium">
                              <Building2 className="w-3 h-3" />
                              {ws.name}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400 italic">Nenhum cliente atribuído</p>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ═══════ INVITE MODAL ═══════ */}
      <Modal isOpen={inviteOpen} onClose={() => setInviteOpen(false)} title="Novo Membro do Time" size="lg">
        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6">
          {['Dados pessoais', 'Ambientes e funções', 'Permissões'].map((step, i) => (
            <button
              key={step}
              onClick={() => setInviteStep(i)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                inviteStep === i
                  ? 'bg-primary-500 text-white'
                  : inviteStep > i
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-gray-100 text-gray-500'
              }`}
            >
              {inviteStep > i ? <Check className="w-3 h-3" /> : <span>{i + 1}</span>}
              {step}
            </button>
          ))}
        </div>

        {/* Step 0: Basic info */}
        {inviteStep === 0 && (
          <div className="space-y-4">
            <Input
              label="Nome completo"
              value={inviteForm.full_name}
              onChange={(e) => setInviteForm(p => ({ ...p, full_name: e.target.value }))}
              placeholder="Ex: João Silva"
            />
            <Input
              label="E-mail"
              type="email"
              value={inviteForm.email}
              onChange={(e) => setInviteForm(p => ({ ...p, email: e.target.value }))}
              placeholder="email@exemplo.com"
            />
            <div className="relative">
              <Input
                label="Senha"
                type={inviteForm.showPassword ? 'text' : 'password'}
                value={inviteForm.password}
                onChange={(e) => setInviteForm(p => ({ ...p, password: e.target.value }))}
                placeholder="Mínimo 6 caracteres"
              />
              <button
                type="button"
                onClick={() => setInviteForm(p => ({ ...p, showPassword: !p.showPassword }))}
                className="absolute right-3 top-9 text-gray-400 hover:text-gray-600"
                tabIndex={-1}
              >
                {inviteForm.showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Environments (1 ou ambos) + roles */}
        {inviteStep === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Ambientes <span className="text-gray-400 font-normal">(1 ou ambos)</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {ENV_ORDER.map(env => {
                  const selected = inviteForm.environments.includes(env);
                  const meta = ENVIRONMENT_META[env];
                  return (
                    <button
                      key={env}
                      type="button"
                      onClick={() => setInviteForm(f => ({
                        ...f,
                        environments: selected
                          ? f.environments.filter(e => e !== env)
                          : [...f.environments, env],
                      }))}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm font-medium text-left transition-all ${
                        selected
                          ? 'border-primary-300 bg-primary-50 ring-1 ring-primary-200 text-primary-700'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                        selected ? 'bg-primary-500 text-white' : 'border-2 border-gray-300'
                      }`}>
                        {selected && <Check className="w-3 h-3" />}
                      </div>
                      <span>{meta.emoji} {meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {inviteForm.environments.map(env => (
              <Select
                key={env}
                label={`Função no ambiente ${ENVIRONMENT_META[env].emoji} ${ENVIRONMENT_META[env].short}`}
                value={inviteForm.envRoles[env]}
                onChange={(e) => setInviteForm(f => ({
                  ...f,
                  envRoles: { ...f.envRoles, [env]: e.target.value as 'admin' | 'team' },
                }))}
                options={[
                  { value: 'team', label: 'Time — acesso conforme permissões' },
                  { value: 'admin', label: 'Admin do ambiente — acesso total' },
                ]}
              />
            ))}

            {inviteForm.environments.length === 0 ? (
              <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">
                Selecione pelo menos um ambiente.
              </p>
            ) : (
              <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                {inviteForm.environments.length === 2
                  ? 'O membro será criado nos dois ambientes com as funções definidas acima.'
                  : `O membro será criado apenas no ambiente ${ENVIRONMENT_META[inviteForm.environments[0]].short}.`}
              </p>
            )}
          </div>
        )}

        {/* Step 2: Permissions */}
        {inviteStep === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Defina o que este membro pode fazer em cada módulo
              {inviteForm.environments.length === 2
                ? ' (aplicado aos dois ambientes)'
                : ` (${ENVIRONMENT_META[inviteForm.environments[0]]?.short ?? ''})`}:
            </p>
            {ALL_PERMISSIONS.map(perm => {
              const meta = PERMISSION_META[perm];
              const Icon = meta.icon;
              const p = inviteForm.permissions.find(x => x.permission === perm) || { permission: perm, can_create: false, can_read: true, can_update: false, can_delete: false };
              return (
                <div key={perm} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white border border-gray-200 hover:border-gray-300 transition-colors">
                  <Icon className="w-4 h-4 text-gray-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-gray-700">{meta.label}</span>
                    <p className="text-[11px] text-gray-400">{meta.description}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {(['can_create', 'can_read', 'can_update', 'can_delete'] as const).map(action => {
                      const label = action === 'can_create' ? 'Criar' : action === 'can_read' ? 'Ver' : action === 'can_update' ? 'Editar' : 'Excluir';
                      return (
                        <button
                          key={action}
                          onClick={() => setInviteForm(f => ({
                            ...f,
                            permissions: togglePerm(f.permissions, perm, action),
                          }))}
                          className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                            p[action]
                              ? action === 'can_delete' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                              : 'bg-gray-100 text-gray-400'
                          }`}
                          title={label}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-between mt-6 pt-4 border-t border-gray-100">
          <div>
            {inviteStep > 0 && (
              <Button variant="ghost" onClick={() => setInviteStep(s => s - 1)}>
                Voltar
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>Cancelar</Button>
            {inviteStep < 2 ? (
              <Button
                onClick={() => setInviteStep(s => s + 1)}
                disabled={inviteStep === 1 && inviteForm.environments.length === 0}
              >
                Próximo
              </Button>
            ) : (
              <Button
                onClick={handleInvite}
                loading={submitting}
                disabled={!inviteForm.full_name.trim() || !inviteForm.email.trim() || !inviteForm.password.trim() || inviteForm.environments.length === 0}
              >
                Criar membro
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {/* ═══════ EDIT MODAL ═══════ */}
      <Modal isOpen={editOpen} onClose={() => setEditOpen(false)} title={`Editar: ${editingMember?.full_name}`} size="lg">
        <div className="space-y-4">
          {/* Basic info */}
          <Input
            label="Nome completo"
            value={editForm.full_name}
            onChange={(e) => setEditForm(p => ({ ...p, full_name: e.target.value }))}
          />

          {editingMember && (
            <p className="text-xs text-gray-400">
              E-mail: {editingMember.email} (não pode ser alterado)
            </p>
          )}

          {/* Environments */}
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-1">Ambientes de acesso</h4>
            <p className="text-xs text-gray-400 mb-3">
              Marque para liberar o acesso a um ambiente; desmarque para remover.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ENV_ORDER.map(env => {
                const meta = ENVIRONMENT_META[env];
                const checked = editForm.environments.includes(env);
                const existing = editingMember?.environments.find(e => e.environment === env);
                return (
                  <div
                    key={env}
                    className={`rounded-lg border p-3 transition-all ${
                      checked ? 'border-primary-300 bg-primary-50 ring-1 ring-primary-200' : 'border-gray-200 bg-white'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setEditForm(f => ({
                        ...f,
                        environments: checked
                          ? f.environments.filter(e => e !== env)
                          : [...f.environments, env],
                      }))}
                      className="flex items-center gap-3 w-full text-left"
                    >
                      <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                        checked ? 'bg-primary-500 text-white' : 'border-2 border-gray-300'
                      }`}>
                        {checked && <Check className="w-3 h-3" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">{meta.emoji} {meta.label}</p>
                        <p className="text-[11px] text-gray-400">
                          {checked
                            ? existing ? 'vínculo atual' : 'novo acesso'
                            : existing ? 'será removido' : 'sem acesso'}
                        </p>
                      </div>
                    </button>
                    {checked && (
                      <div className="mt-3">
                        <Select
                          label={`Função em ${meta.short}`}
                          value={editForm.envRoles[env]}
                          onChange={(e) => setEditForm(f => ({
                            ...f,
                            envRoles: { ...f.envRoles, [env]: e.target.value as 'admin' | 'team' },
                          }))}
                          options={[
                            { value: 'team', label: 'Time — acesso conforme permissões' },
                            { value: 'admin', label: 'Admin do ambiente — acesso total' },
                          ]}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {editForm.environments.length === 0 && (
              <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-2">
                Selecione pelo menos um ambiente.
              </p>
            )}
          </div>

          {/* Permissions */}
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-1">Permissões</h4>
            <p className="text-xs text-gray-400 mb-3">
              Valem para todos os ambientes de acesso do membro.
            </p>
            <div className="space-y-2">
              {ALL_PERMISSIONS.map(perm => {
                const meta = PERMISSION_META[perm];
                const Icon = meta.icon;
                const p = editForm.permissions.find(x => x.permission === perm) || { permission: perm, can_create: false, can_read: true, can_update: false, can_delete: false };
                return (
                  <div key={perm} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 hover:bg-gray-100/80 transition-colors">
                    <Icon className="w-4 h-4 text-gray-400 shrink-0" />
                    <span className="text-sm font-medium text-gray-700 flex-1">{meta.label}</span>
                    <div className="flex items-center gap-1">
                      {(['can_create', 'can_read', 'can_update', 'can_delete'] as const).map(action => {
                        const label = action === 'can_create' ? 'C' : action === 'can_read' ? 'L' : action === 'can_update' ? 'U' : 'D';
                        const fullLabel = action === 'can_create' ? 'Criar' : action === 'can_read' ? 'Ver' : action === 'can_update' ? 'Editar' : 'Excluir';
                        return (
                          <button
                            key={action}
                            onClick={() => setEditForm(f => ({
                              ...f,
                              permissions: togglePerm(f.permissions, perm, action),
                            }))}
                            className={`w-7 h-7 rounded text-[11px] font-bold transition-colors ${
                              p[action]
                                ? action === 'can_delete' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                                : 'bg-gray-200 text-gray-400'
                            }`}
                            title={fullLabel}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Client assignment — uma seção por ambiente marcado */}
          {editForm.environments.map(env => {
            const meta = ENVIRONMENT_META[env];
            const envWs = allWorkspaces.filter(w => wsEnvById.get(w.id) === env);
            const selectedIds = editForm.workspaces[env] ?? [];
            const isAdminEnv = editForm.envRoles[env] === 'admin';
            return (
              <div key={env}>
                <h4 className="text-sm font-semibold text-gray-900 mb-1">
                  Clientes atribuídos — {meta.short}
                </h4>
                <p className="text-xs text-gray-400 mb-3">
                  {meta.emoji} {meta.label}
                  {isAdminEnv && ' · Admin do ambiente — acesso total aos clientes'}
                </p>
                {envWs.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">
                    Nenhum cliente cadastrado neste ambiente.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {envWs.map(ws => {
                      const selected = selectedIds.includes(ws.id);
                      return (
                        <button
                          key={ws.id}
                          onClick={() => setEditForm(f => {
                            const cur = f.workspaces[env] ?? [];
                            return {
                              ...f,
                              workspaces: {
                                ...f.workspaces,
                                [env]: selected
                                  ? cur.filter(id => id !== ws.id)
                                  : [...cur, ws.id],
                              },
                            };
                          })}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${
                            selected
                              ? 'border-primary-300 bg-primary-50 ring-1 ring-primary-200'
                              : 'border-gray-200 bg-white hover:border-gray-300'
                          }`}
                        >
                          <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                            selected ? 'bg-primary-500 text-white' : 'border-2 border-gray-300'
                          }`}>
                            {selected && <Check className="w-3 h-3" />}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{ws.name}</p>
                            {ws.segment && <p className="text-[11px] text-gray-400 truncate">{ws.segment}</p>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-between mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancelar</Button>
          <div className="flex gap-2">
            {editingMember && editingMember.id !== currentUser?.id && (
              <Button
                variant="danger"
                onClick={() => { handleDelete(editingMember); setEditOpen(false); }}
                loading={submitting}
              >
                Remover permanentemente
              </Button>
            )}
            <Button onClick={handleUpdate} loading={submitting} disabled={!editForm.full_name.trim()}>
              Salvar alterações
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
