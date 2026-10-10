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
import { toast } from 'sonner';
import {
  Plus, Users, Pencil, Trash2, Shield, UserCheck, Mail,
  ChevronDown, ChevronRight, Eye, EyeOff, Check, X,
  Briefcase, Settings, Building2, CheckCircle2,
} from 'lucide-react';

/* ─── Types ─── */
interface TeamUser {
  id: string;
  email: string;
  full_name: string;
  role: 'admin_sharks' | 'sharks_team' | 'client';
  avatar_url?: string;
  created_at: string;
}

interface Workspace {
  id: string;
  name: string;
  segment?: string;
}

interface MemberWithAccess extends TeamUser {
  permissions: Permission[];
  workspaces: Workspace[];
}

/* ─── Constants ─── */
const ROLE_LABELS: Record<string, string> = {
  admin_sharks: 'Administrador',
  sharks_team: 'Equipe de Produção',
  client: 'Cliente',
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  admin_sharks: 'Acesso total ao sistema. Pode gerenciar usuários, configurações e todos os clientes.',
  sharks_team: 'Membro da equipe de produção. Acesso conforme permissões definidas.',
};

const ROLE_COLORS: Record<string, 'primary' | 'info' | 'default'> = {
  admin_sharks: 'primary',
  sharks_team: 'info',
  client: 'default',
};

/* ─── Component ─── */
export default function SharksTeam() {
  const { user: currentUser, isAdmin } = useAuth();
  const [members, setMembers] = useState<MemberWithAccess[]>([]);
  const [allWorkspaces, setAllWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<MemberWithAccess | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  // Invite form
  const [inviteStep, setInviteStep] = useState(0);
  const [inviteForm, setInviteForm] = useState({
    full_name: '',
    email: '',
    password: '',
    role: 'sharks_team',
    permissions: [] as Permission[],
    workspace_ids: [] as string[],
  });

  // Edit form
  const [editForm, setEditForm] = useState({
    full_name: '',
    role: 'sharks_team',
    permissions: [] as Permission[],
    workspace_ids: [] as string[],
  });

  const [submitting, setSubmitting] = useState(false);

  /* ─── Load data ─── */
  const loadData = useCallback(async () => {
    setLoading(true);

    const [usersRes, wsRes] = await Promise.all([
      supabase.from('users').select('*').in('role', ['admin_sharks', 'sharks_team']).order('created_at', { ascending: false }),
      // Pool de clientes SOMENTE do ambiente Sharks (org via RLS + filtro por ambiente)
      supabase.from('workspaces').select('id, name, segment').eq('is_active', true).order('name'),
    ]);

    const users = (usersRes.data as unknown as TeamUser[]) || [];
    const allWs = (wsRes.data as unknown as Array<{ id: string; name: string; segment: string | null }>) || [];

    // Filtrar por ambiente Sharks via env map (RPC SECURITY DEFINER)
    const { data: envMap } = await supabase.rpc('ws_env_map');
    const sharksIds = new Set(
      ((envMap ?? []) as Array<{ id: string; environment: string }>)
        .filter(r => r.environment === 'sharks_company')
        .map(r => r.id),
    );
    setAllWorkspaces(allWs.filter(w => sharksIds.has(w.id)) as unknown as Workspace[]);

    // Load permissions and memberships for each user
    const enriched: MemberWithAccess[] = await Promise.all(
      users.map(async (u) => {
        const [permsRes, memRes] = await Promise.all([
          supabase.from('team_member_access').select('*').eq('user_id', u.id),
          supabase.from('memberships').select('workspace_id, workspace:workspaces(id, name)').eq('user_id', u.id).eq('role', 'manager'),
        ]);

        return {
          ...u,
          permissions: (permsRes.data as unknown as Permission[]) || [],
        // Vínculos do membro — somente workspaces do ambiente Sharks
        // (assignments cross-env quebravam o admin-update-user com 400)
        workspaces: ((memRes.data as unknown as { workspace: Workspace | null }[]) || [])
          .map(m => m.workspace)
          .filter((ws): ws is Workspace => !!ws && sharksIds.has(ws.id)),
        };
      })
    );

    setMembers(enriched);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  /* ─── Helpers ─── */

  // Extrai a mensagem real devolvida pela edge function (FunctionsHttpError.context)
  async function functionErrorMessage(error: unknown): Promise<string> {
    if (error && typeof error === 'object' && 'context' in error) {
      try {
        const body = await (error as { context: Response }).context.clone().json();
        if (body && typeof body.error === 'string') return body.error;
      } catch {
        // resposta não-JSON — usa a mensagem padrão abaixo
      }
    }
    return error instanceof Error ? error.message : 'Erro inesperado';
  }

  /* ─── Handlers ─── */
  const handleInvite = async () => {
    if (!inviteForm.full_name.trim() || !inviteForm.email.trim() || !inviteForm.password.trim() || submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-create-user', {
        body: {
          email: inviteForm.email.trim(),
          password: inviteForm.password,
          full_name: inviteForm.full_name.trim(),
          role: inviteForm.role,
          permissions: inviteForm.permissions.length > 0 ? inviteForm.permissions : defaultPermissions(),
          workspace_ids: inviteForm.workspace_ids,
        },
      });

      if (error) throw new Error(await functionErrorMessage(error));
      if (data?.error) throw new Error(data.error);

      toast.success(data?.linked
        ? `"${inviteForm.full_name}" já tinha conta e foi vinculado ao time Sharks!`
        : `"${inviteForm.full_name}" foi adicionado ao time!`);
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
      full_name: '', email: '', password: '', role: 'sharks_team',
      permissions: defaultPermissions(), workspace_ids: [],
    });
    setInviteStep(0);
  };

  const openInvite = () => {
    resetInviteForm();
    setInviteOpen(true);
  };

  const openEdit = (member: MemberWithAccess) => {
    setEditingMember(member);
    setEditForm({
      full_name: member.full_name,
      role: member.role,
      permissions: member.permissions.length > 0 ? member.permissions : defaultPermissions(),
      workspace_ids: member.workspaces.map(w => w.id),
    });
    setEditOpen(true);
  };

  const handleUpdate = async () => {
    if (!editingMember || !editForm.full_name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-update-user', {
        body: {
          user_id: editingMember.id,
          full_name: editForm.full_name.trim(),
          role: editForm.role,
          permissions: editForm.permissions,
          workspace_ids: editForm.workspace_ids,
        },
      });

      if (error) throw new Error(await functionErrorMessage(error));
      if (data?.error) throw new Error(data.error);

      toast.success('Membro atualizado!');
      setEditOpen(false);
      setEditingMember(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (userId: string, name: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke('admin-delete-user', {
        body: { user_id: userId },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      toast.success(`"${name}" removido do time.`);
      setDeleteConfirm(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover');
    } finally {
      setSubmitting(false);
    }
  };

  /* ─── Render ─── */
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <PageHeader title="Time de Produção" subtitle="Gerencie membros, permissões e acesso aos clientes" />
        {isAdmin && (
          <Button onClick={openInvite}>
            <Plus className="w-4 h-4" />
            Novo membro
          </Button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="w-8 h-8 border-4 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      ) : members.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="Nenhum membro no time"
            description="Adicione membros da equipe para começar a trabalhar juntos."
            action={isAdmin ? <Button onClick={openInvite}>+ Novo membro</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {members.map(member => {
            const isExpanded = expandedCard === member.id;
            const clientCount = member.workspaces.length;
            const permSummary = member.permissions.filter(p => permCount(p) > 1).length;

            return (
              <Card key={member.id} className="overflow-hidden">
                {/* Main row */}
                <div
                  className="flex items-center gap-4 p-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                  onClick={() => setExpandedCard(isExpanded ? null : member.id)}
                >
                  <Avatar name={member.full_name} src={member.avatar_url} size="lg" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{member.full_name}</h3>
                      <Badge variant={ROLE_COLORS[member.role] || 'default'}>
                        {member.role === 'admin_sharks' && <Shield className="w-3 h-3 mr-1" />}
                        {member.role === 'sharks_team' && <UserCheck className="w-3 h-3 mr-1" />}
                        {ROLE_LABELS[member.role]}
                      </Badge>
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
                    {member.role === 'sharks_team' && permSummary > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-emerald-50 text-emerald-700">
                        <Settings className="w-3 h-3" />
                        {permSummary} módulo{permSummary > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  {isAdmin && (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => openEdit(member)}
                        className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition-colors"
                        title="Editar"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {member.id !== currentUser?.id && (
                        <button
                          onClick={() => setDeleteConfirm(member.id)}
                          className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Remover"
                        >
                          <Trash2 className="w-4 h-4" />
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
                    {/* Permissions grid */}
                    {member.role === 'sharks_team' && member.permissions.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Permissões</h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {member.permissions.map(perm => {
                            const meta = PERMISSION_META[perm.permission];
                            if (!meta) return null;
                            const Icon = meta.icon;
                            const count = permCount(perm);
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

                    {/* Assigned clients */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                        {member.role === 'admin_sharks' ? 'Todos os clientes (acesso total)' : 'Clientes atribuídos'}
                      </h4>
                      {member.role === 'admin_sharks' ? (
                        <div className="flex flex-wrap gap-2">
                          {allWorkspaces.map(ws => (
                            <span key={ws.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-primary-50 text-primary-700 font-medium">
                              <CheckCircle2 className="w-3 h-3" />
                              {ws.name}
                            </span>
                          ))}
                        </div>
                      ) : member.workspaces.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {member.workspaces.map(ws => (
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
          {['Dados pessoais', 'Permissões', 'Clientes'].map((step, i) => (
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
            <Input
              label="Senha"
              type="password"
              value={inviteForm.password}
              onChange={(e) => setInviteForm(p => ({ ...p, password: e.target.value }))}
              placeholder="Mínimo 6 caracteres"
            />
            <Select
              label="Função"
              value={inviteForm.role}
              onChange={(e) => setInviteForm(p => ({ ...p, role: e.target.value }))}
              options={[
                { value: 'sharks_team', label: 'Equipe de Produção' },
                { value: 'admin_sharks', label: 'Administrador' },
              ]}
            />
            {ROLE_DESCRIPTIONS[inviteForm.role] && (
              <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                {ROLE_DESCRIPTIONS[inviteForm.role]}
              </p>
            )}
          </div>
        )}

        {/* Step 1: Permissions */}
        {inviteStep === 1 && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Defina o que este membro pode fazer em cada módulo:</p>
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

        {/* Step 2: Client assignment */}
        {inviteStep === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Selecione os clientes que este membro poderá gerenciar:</p>
            {allWorkspaces.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">Nenhum cliente cadastrado</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {allWorkspaces.map(ws => {
                  const selected = inviteForm.workspace_ids.includes(ws.id);
                  return (
                    <button
                      key={ws.id}
                      onClick={() => setInviteForm(f => ({
                        ...f,
                        workspace_ids: selected
                          ? f.workspace_ids.filter(id => id !== ws.id)
                          : [...f.workspace_ids, ws.id],
                      }))}
                      className={`flex items-center gap-3 px-3 py-3 rounded-lg border text-left transition-all ${
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
            {inviteForm.workspace_ids.length > 0 && (
              <p className="text-xs text-primary-600 font-medium">
                {inviteForm.workspace_ids.length} cliente{inviteForm.workspace_ids.length > 1 ? 's' : ''} selecionado{inviteForm.workspace_ids.length > 1 ? 's' : ''}
              </p>
            )}
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
              <Button onClick={() => setInviteStep(s => s + 1)}>
                Próximo
              </Button>
            ) : (
              <Button
                onClick={handleInvite}
                loading={submitting}
                disabled={!inviteForm.full_name.trim() || !inviteForm.email.trim() || !inviteForm.password.trim()}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Nome completo"
              value={editForm.full_name}
              onChange={(e) => setEditForm(p => ({ ...p, full_name: e.target.value }))}
            />
            <Select
              label="Função"
              value={editForm.role}
              onChange={(e) => setEditForm(p => ({ ...p, role: e.target.value }))}
              options={[
                { value: 'sharks_team', label: 'Equipe de Produção' },
                { value: 'admin_sharks', label: 'Administrador' },
              ]}
            />
          </div>

          {editingMember && (
            <p className="text-xs text-gray-400">
              E-mail: {editingMember.email} (não pode ser alterado)
            </p>
          )}

          {/* Permissions */}
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Permissões por módulo</h4>
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

          {/* Client assignment */}
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Clientes atribuídos</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {allWorkspaces.map(ws => {
                const selected = editForm.workspace_ids.includes(ws.id);
                return (
                  <button
                    key={ws.id}
                    onClick={() => setEditForm(f => ({
                      ...f,
                      workspace_ids: selected
                        ? f.workspace_ids.filter(id => id !== ws.id)
                        : [...f.workspace_ids, ws.id],
                    }))}
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
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancelar</Button>
          <Button onClick={handleUpdate} loading={submitting} disabled={!editForm.full_name.trim()}>
            Salvar alterações
          </Button>
        </div>
      </Modal>

      {/* ═══════ DELETE CONFIRMATION ═══════ */}
      <Modal isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Remover Membro" size="sm">
        <p className="text-sm text-gray-600">
          Tem certeza que deseja remover <strong>{members.find(u => u.id === deleteConfirm)?.full_name}</strong> do time?
        </p>
        <p className="text-xs text-gray-400 mt-2">
          O acesso do usuário ao sistema será removido permanentemente.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>Cancelar</Button>
          <Button
            variant="danger"
            onClick={() => {
              const m = members.find(u => u.id === deleteConfirm);
              if (m) handleDelete(m.id, m.full_name);
            }}
            loading={submitting}
          >
            Remover
          </Button>
        </div>
      </Modal>
    </div>
  );
}
