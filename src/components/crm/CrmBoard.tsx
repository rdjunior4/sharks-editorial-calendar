import { useCallback, useMemo, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Tabs from '@/components/ui/Tabs';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import { toast } from 'sonner';
import { Plus, Search, Loader2 } from 'lucide-react';
import LeadKanban from './LeadKanban';
import LeadFormModal, { type LeadFormValues } from './LeadFormModal';
import LeadDrawer from './LeadDrawer';
import ConvertLeadModal from './ConvertLeadModal';
import ClientsTab from './ClientsTab';
import { formatBRL, type LeadStage } from '@/lib/crmStages';
import {
  useLeads, useEnvStaff, useLeadActivitySummaries, useCrmClients, type CrmEnvironment, type Lead,
} from '@/hooks/useLeads';
import { useBreakpoint } from '@/hooks/useBreakpoint';

type CrmTab = 'pipeline' | 'clients';

interface CrmBoardProps {
  environment: CrmEnvironment | null;
  canDelete?: boolean;
  showEnv?: boolean;
  title: string;
  subtitle: string;
}

export default function CrmBoard({ environment, canDelete = false, showEnv = false, title, subtitle }: CrmBoardProps) {
  const { isMobile } = useBreakpoint();
  const { leads, loading, createLead, updateLead, deleteLead, moveStage, convertLead } = useLeads(environment);
  const owners = useEnvStaff(environment);
  const activitySummaries = useLeadActivitySummaries(environment);
  const agendaClients = useCrmClients(environment);

  const [tab, setTab] = useState<CrmTab>('pipeline');
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [convertLeadState, setConvertLeadState] = useState<Lead | null>(null);
  const [lostLead, setLostLead] = useState<Lead | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [deletingLead, setDeletingLead] = useState<Lead | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /* Filtros aplicados ao board e à aba de clientes */
  const filteredLeads = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads.filter(l => {
      if (ownerFilter && l.owner_id !== ownerFilter) return false;
      if (!term) return true;
      return (
        l.name.toLowerCase().includes(term) ||
        (l.contact_name ?? '').toLowerCase().includes(term) ||
        (l.workspace?.name ?? '').toLowerCase().includes(term) ||
        (l.segment ?? '').toLowerCase().includes(term)
      );
    });
  }, [leads, search, ownerFilter]);

  const stats = useMemo(() => {
    const open = filteredLeads.filter(l => l.stage !== 'won' && l.stage !== 'lost');
    const won = filteredLeads.filter(l => l.stage === 'won');
    return {
      pipelineValue: open.reduce((acc, l) => acc + (Number(l.value) || 0), 0),
      openCount: open.length,
      wonValue: won.reduce((acc, l) => acc + (Number(l.value) || 0), 0),
      monthlyValue: won.reduce((acc, l) => acc + (Number(l.monthly_value) || 0), 0),
      wonCount: won.length,
    };
  }, [filteredLeads]);

  /* O drawer guarda referência viva do lead (realtime pode atualizá-lo) */
  const drawerLive: Lead | null = drawerLead
    ? leads.find(l => l.id === drawerLead.id) ?? drawerLead
    : null;

  const handleMoveStage = useCallback(async (lead: Lead, stage: LeadStage) => {
    if (lead.stage === stage) return;
    if (stage === 'won' && !lead.workspace_id) {
      setDrawerLead(null);
      setConvertLeadState(lead);
      return;
    }
    if (stage === 'lost') {
      setDrawerLead(null);
      setLostLead(lead);
      setLostReason('');
      return;
    }
    try {
      await moveStage(lead, stage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao mover lead');
    }
  }, [moveStage]);

  const handleCreateOrUpdate = async (values: LeadFormValues) => {
    setSubmitting(true);
    try {
      const payload = {
        name: values.name.trim(),
        contact_name: values.contact_name.trim() || null,
        contact_email: values.contact_email.trim() || null,
        contact_phone: values.contact_phone.trim() || null,
        source: values.source.trim() || null,
        segment: values.segment.trim() || null,
        value: values.value === '' ? null : Number(values.value),
        monthly_value: values.monthly_value === '' ? null : Number(values.monthly_value),
        expected_close_date: values.expected_close_date || null,
        owner_id: values.owner_id || null,
        notes: values.notes.trim() || null,
        product_ids: values.product_ids,
        team_ids: values.team_ids,
      };
      if (editingLead) {
        await updateLead(editingLead.id, payload);
        toast.success('Lead atualizado!');
      } else {
        if (!environment) {
          toast.error('Selecione um ambiente para criar o lead.');
          return;
        }
        await createLead({ ...payload, environment });
        toast.success('Lead criado!');
      }
      setFormOpen(false);
      setEditingLead(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar lead');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConvert = async (workspaceName: string, segment: string) => {
    if (!convertLeadState) return;
    setSubmitting(true);
    try {
      const res = await convertLead(convertLeadState.id, workspaceName, segment);
      toast.success(`Cliente "${res.workspace_name}" criado! O acesso dele segue pelo fluxo de solicitação de acesso.`);
      setConvertLeadState(null);
      setDrawerLead(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao converter lead');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLostConfirm = async () => {
    if (!lostLead) return;
    setSubmitting(true);
    try {
      await moveStage(lostLead, 'lost');
      await updateLead(lostLead.id, { lost_reason: lostReason.trim() || null });
      toast.success('Lead marcado como perdido');
      setLostLead(null);
      setLostReason('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar lead');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingLead) return;
    setSubmitting(true);
    try {
      await deleteLead(deletingLead.id);
      toast.success('Lead excluído');
      setDeletingLead(null);
      setDrawerLead(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir lead');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          environment ? (
            <Button onClick={() => { setEditingLead(null); setFormOpen(true); }}>
              <Plus className="w-4 h-4" />
              Novo lead
            </Button>
          ) : undefined
        }
      />

      {/* Abas Pipeline / Clientes */}
      <Tabs
        tabs={[{ id: 'pipeline' as const, label: 'Pipeline' }, { id: 'clients' as const, label: 'Clientes' }]}
        activeTab={tab}
        onChange={setTab}
        className="self-start"
      />

      {/* Barra de filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar lead, cliente ou segmento..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:border-primary-500 placeholder:text-gray-400"
          />
        </div>
        <div className="w-full sm:w-56">
          <Select
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            placeholder="Todos os responsáveis"
            options={owners}
          />
        </div>
      </div>

      {loading ? (
        <div className="py-10">
          <Loader2 className="w-6 h-6 text-primary-500 animate-spin" />
        </div>
      ) : tab === 'pipeline' ? (
        <>
          {/* Resumo do pipeline */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span className="text-gray-500">
              Pipeline aberto: <strong className="text-gray-900 tabular-nums">{formatBRL(stats.pipelineValue)}</strong>
              <span className="text-gray-400"> ({stats.openCount} leads)</span>
            </span>
            <span className="text-gray-500">
              Ganho: <strong className="text-emerald-600 tabular-nums">{formatBRL(stats.wonValue)}</strong>
              <span className="text-gray-400"> ({stats.wonCount})</span>
            </span>
            <span className="text-gray-500">
              Recorrência mensal: <strong className="text-gray-900 tabular-nums">{formatBRL(stats.monthlyValue)}</strong>
            </span>
          </div>

          <LeadKanban
            leads={filteredLeads}
            clients={agendaClients}
            activitySummaries={activitySummaries}
            showEnv={showEnv}
            isMobile={isMobile}
            onOpenLead={(lead) => setDrawerLead(lead)}
            onMoveStage={handleMoveStage}
          />
        </>
      ) : (
        <ClientsTab
          leads={filteredLeads}
          agendaClients={agendaClients}
          showEnv={showEnv}
          onOpenLead={(lead) => setDrawerLead(lead)}
        />
      )}

      {/* Form criar/editar */}
      <LeadFormModal
        isOpen={formOpen}
        onClose={() => { setFormOpen(false); setEditingLead(null); }}
        lead={editingLead}
        environment={editingLead?.environment ?? environment}
        owners={owners}
        submitting={submitting}
        onSubmit={handleCreateOrUpdate}
      />

      {/* Detalhe do lead */}
      <LeadDrawer
        lead={drawerLive}
        owners={owners}
        canDelete={canDelete}
        onClose={() => setDrawerLead(null)}
        onEdit={(lead) => { setEditingLead(lead); setFormOpen(true); }}
        onStageChange={handleMoveStage}
        onConvert={(lead) => { setDrawerLead(null); setConvertLeadState(lead); }}
        onDelete={(lead) => setDeletingLead(lead)}
      />

      {/* Conversão */}
      <ConvertLeadModal
        lead={convertLeadState}
        submitting={submitting}
        onClose={() => setConvertLeadState(null)}
        onConfirm={handleConvert}
      />

      {/* Marcar como perdido */}
      <Modal
        isOpen={!!lostLead}
        onClose={() => setLostLead(null)}
        title="Marcar como perdido"
        size="md"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {lostLead?.name} será movido para <strong>Perdido</strong>.
          </p>
          <Textarea
            label="Motivo (opcional)"
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            placeholder="Preço, concorrência, sem verba..."
            rows={3}
          />
        </div>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setLostLead(null)}>Cancelar</Button>
          <Button variant="danger" onClick={handleLostConfirm} loading={submitting}>
            Marcar como perdido
          </Button>
        </div>
      </Modal>

      {/* Confirmar exclusão */}
      <Modal
        isOpen={!!deletingLead}
        onClose={() => setDeletingLead(null)}
        title="Excluir lead"
        size="sm"
      >
        <p className="text-sm text-gray-600">
          Excluir <strong>{deletingLead?.name}</strong> e todo o histórico de atividades?
          Esta ação não pode ser desfeita.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setDeletingLead(null)}>Cancelar</Button>
          <Button variant="danger" onClick={handleDeleteConfirm} loading={submitting}>
            Excluir
          </Button>
        </div>
      </Modal>
    </div>
  );
}
