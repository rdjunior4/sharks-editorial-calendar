import { useState } from 'react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import EmptyState from '@/components/ui/EmptyState';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { callDispatch } from '@/lib/prospecting/dispatch';
import {
  Plus, Radar, Loader2, Pencil, Trash2, Play, Pause, RotateCcw,
  Building2, Target, TrendingUp, Users, MessageSquare, CalendarCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import {
  useProspectingCampaigns, useProspectingMetrics,
} from '@/hooks/useProspecting';
import { useEnvStaff } from '@/hooks/useLeads';
import {
  CAMPAIGN_STATUS_META, AUTOMATION_META, type CampaignStatus,
  type ProspectingCampaign, type ProspectingEnvironment,
} from '@/lib/prospecting/types';
import CampaignFormModal, { payloadFromValues, type CampaignFormValues } from './CampaignFormModal';

interface ProspectingPageProps {
  environment: ProspectingEnvironment;
  canDelete?: boolean;
}

export default function CampaignsSection({ environment }: ProspectingPageProps) {
  const { user } = useAuth();
  const { campaigns, loading, createCampaign, updateCampaign, deleteCampaign, setStatus } =
    useProspectingCampaigns(environment);
  const metrics = useProspectingMetrics(environment);
  const owners = useEnvStaff(environment);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProspectingCampaign | null>(null);
  const [deleting, setDeleting] = useState<ProspectingCampaign | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const metricCards = [
    { label: 'Campanhas ativas', value: campaigns.filter(c => c.status === 'running').length, icon: Radar },
    { label: 'Empresas encontradas', value: metrics.found, icon: Building2 },
    { label: 'Leads qualificados', value: metrics.qualified, icon: Target },
    { label: 'Em abordagem', value: metrics.approach, icon: MessageSquare },
    { label: 'Interessados', value: metrics.interested, icon: TrendingUp },
    { label: 'Reuniões', value: metrics.meetings, icon: CalendarCheck },
  ];

  const handleSubmit = async (values: CampaignFormValues) => {
    setSubmitting(true);
    try {
      const payload = payloadFromValues(values, environment);
      if (editing) {
        await updateCampaign(editing.id, payload);
        toast.success('Campanha atualizada!');
      } else {
        await createCampaign(environment, payload, user?.id ?? null);
        toast.success('Campanha criada! Inicie-a para começar a prospecção.');
      }
      setFormOpen(false);
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar campanha');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatus = async (campaign: ProspectingCampaign, status: CampaignStatus) => {
    try {
      await setStatus(campaign.id, status);
      toast.success(status === 'running' ? 'Campanha em execução' : `Campanha ${CAMPAIGN_STATUS_META[status].label.toLowerCase()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar status');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleting) return;
    setSubmitting(true);
    try {
      await deleteCampaign(deleting.id);
      toast.success('Campanha excluída');
      setDeleting(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir campanha');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus className="w-4 h-4" />
          Nova campanha
        </Button>
      </div>
      {/* Métricas */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {metricCards.map(({ label, value, icon: Icon }) => (
          <Card key={label} padding="sm" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5 text-primary-600" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-bold text-gray-900 tabular-nums leading-none">{value}</p>
              <p className="text-[11px] text-gray-500 truncate mt-0.5">{label}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Lista de campanhas */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-primary-500 animate-spin" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <Card padding="md">
            <EmptyState
              icon={Radar}
              title="Nenhuma campanha de prospecção"
              description="Crie uma campanha definindo o ICP, os produtos do ambiente e os canais de abordagem."
            />
            <div className="flex justify-center pb-2 -mt-2">
              <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Plus className="w-4 h-4" />
                Nova campanha
              </Button>
            </div>
          </Card>
        </div>
      ) : (
        <div className="space-y-2">
          {campaigns.map(c => {
            const status = CAMPAIGN_STATUS_META[c.status];
            const cCount = metrics.byCampaign[c.id] ?? { found: 0, qualified: 0 };
            return (
              <Card key={c.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-900 truncate">{c.name}</p>
                      <span className={cn('px-2 py-0.5 rounded-full text-[11px] font-medium', status.badgeClass)}>
                        {status.label}
                      </span>
                      <Badge variant="info" size="sm">{AUTOMATION_META[c.automation_level].label}</Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
                      {(c.segment || c.location) && (
                        <span className="inline-flex items-center gap-1">
                          <Building2 className="w-3 h-3" />
                          {[c.segment, c.location].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      {c.company_size && <span>Porte: {c.company_size}</span>}
                      <span className="inline-flex items-center gap-1">
                        <Target className="w-3 h-3" />
                        Meta: {c.target_count}
                      </span>
                      <span>Encontrados: <strong className="text-gray-700 tabular-nums">{cCount.found}</strong></span>
                      <span>Qualificados: <strong className="text-gray-700 tabular-nums">{cCount.qualified}</strong></span>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400 flex-wrap">
                      {c.channels.length > 0 && <span>Canais: {c.channels.map(ch => ch).join(', ')}</span>}
                      {(c.products?.length ?? 0) > 0 && (
                        <span>Produtos: {c.products!.map(x => x.product?.name).filter(Boolean).join(', ')}</span>
                      )}
                      {c.icp_description && (
                        <span className="max-w-[320px] truncate" title={c.icp_description}>
                          ICP: {c.icp_description}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 max-w-xs">
                      <div className="flex items-center justify-between text-[11px] text-gray-500 mb-0.5">
                        <span>Progresso da meta</span>
                        <span className="tabular-nums">{cCount.found}/{c.target_count} · {Math.round(Math.min(1, cCount.found / Math.max(1, c.target_count)) * 100)}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={cn('h-full rounded-full transition-all', cCount.found >= c.target_count ? 'bg-emerald-500' : 'bg-primary-500')}
                          style={{ width: `${Math.min(100, Math.round((cCount.found / Math.max(1, c.target_count)) * 100))}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 mt-2">
                      {c.assigned_to_user ? (
                        <>
                          <Avatar name={c.assigned_to_user.full_name} src={c.assigned_to_user.avatar_url} size="xs" />
                          <span className="text-xs text-gray-500">{c.assigned_to_user.full_name}</span>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                          <Users className="w-3 h-3" /> Sem responsável
                        </span>
                      )}
                      <span className="text-xs text-gray-300">·</span>
                      <span className="text-xs text-gray-400">
                        criada em {new Date(c.created_at).toLocaleDateString('pt-BR')}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {c.status === 'running' && (
                      <button
                        onClick={async () => {
                          const res = await callDispatch({ action: 'mass', campaign_id: c.id });
                          if (res.ok) toast.success('Disparo em massa na fila! O agente envia em ritmo controlado (até 5min para começar).');
                          else toast.error(res.error ?? 'Não disparavel');
                        }}
                        className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-sky-600 hover:border-sky-200 hover:bg-sky-50 transition-colors"
                        title="Disparar em massa (inicia a abordagem nos qualificados)"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {c.status === 'draft' && (
                      <button onClick={() => handleStatus(c, 'running')} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-colors" title="Iniciar execução">
                        <Play className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {c.status === 'running' && (
                      <button onClick={() => handleStatus(c, 'paused')} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-amber-600 hover:border-amber-200 hover:bg-amber-50 transition-colors" title="Pausar">
                        <Pause className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {c.status === 'paused' && (
                      <button onClick={() => handleStatus(c, 'running')} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-colors" title="Retomar">
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => { setEditing(c); setFormOpen(true); }} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors" title="Editar">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setDeleting(c)} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors" title="Excluir">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Form criar/editar */}
      <CampaignFormModal
        isOpen={formOpen}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        campaign={editing}
        environment={environment}
        owners={owners}
        submitting={submitting}
        onSubmit={handleSubmit}
      />

      {/* Confirmar exclusão */}
      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} title="Excluir campanha" size="sm">
        <p className="text-sm text-gray-600">
          Excluir <strong>{deleting?.name}</strong> e todo o histórico de jobs?
          Leads já criados no CRM não são afetados.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancelar</Button>
          <Button variant="danger" onClick={handleDeleteConfirm} loading={submitting}>
            Excluir
          </Button>
        </div>
      </Modal>
    </div>
  );
}
