import PageHeader from '@/components/ui/PageHeader';
import { useState } from 'react';
import { useCampaigns } from '@/hooks/useCampaigns';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import Textarea from '@/components/ui/Textarea';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Badge from '@/components/ui/Badge';
import { toast } from 'sonner';
import { formatDate } from '@/lib/utils';
import { PRIORITIES } from '@/lib/constants';
import { Plus, Megaphone, Calendar, Users, Pencil, Trash2, Pause, Play, CheckCircle2 } from 'lucide-react';
import { Campaign, CampaignStatus } from '@/types';

const PRESET_COLORS = [
  '#0066FF', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#06B6D4', '#F97316', '#6366F1', '#14B8A6',
];

const STATUS_OPTIONS: { value: CampaignStatus; label: string; color: string }[] = [
  { value: 'draft', label: 'Rascunho', color: 'bg-gray-400' },
  { value: 'active', label: 'Ativa', color: 'bg-emerald-500' },
  { value: 'paused', label: 'Pausada', color: 'bg-amber-500' },
  { value: 'completed', label: 'Concluída', color: 'bg-primary-500' },
];

const emptyForm = {
  name: '',
  objective: '',
  start_date: '',
  end_date: '',
  description: '',
  audience: '',
  product: '',
  priority: 'medium',
  color: '#0066FF',
};

function statusBadge(status: CampaignStatus) {
  const opt = STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0];
  return <Badge variant={status === 'active' ? 'success' : status === 'paused' ? 'warning' : status === 'completed' ? 'info' : 'default'}>{opt.label}</Badge>;
}

export default function SharksCampaigns() {
  const { currentWorkspace } = useWorkspace();
  const { campaigns, createCampaign, updateCampaign, deleteCampaign } = useCampaigns(currentWorkspace?.id);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [deleting, setDeleting] = useState<Campaign | null>(null);
  const [formData, setFormData] = useState(emptyForm);

  const openCreate = () => { setEditing(null); setFormData(emptyForm); setModalOpen(true); };

  const openEdit = (c: Campaign) => {
    setEditing(c);
    setFormData({
      name: c.name,
      objective: c.objective || '',
      start_date: c.start_date || '',
      end_date: c.end_date || '',
      description: c.description || '',
      audience: c.audience || '',
      product: c.product || '',
      priority: c.priority || 'medium',
      color: c.color || '#0066FF',
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!currentWorkspace || !formData.name.trim()) return;
    const payload = {
      ...formData,
      workspace_id: currentWorkspace.id,
      status: (editing?.status || 'draft') as CampaignStatus,
    };
    const result = editing
      ? await updateCampaign(editing.id, payload)
      : await createCampaign(payload);
    if (result.ok) {
      toast.success(editing ? 'Campanha atualizada!' : 'Campanha criada!');
      setModalOpen(false);
    } else {
      toast.error(result.error || 'Erro ao salvar campanha');
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const ok = await deleteCampaign(deleting.id);
    if (ok) { toast.success('Campanha excluída!'); setDeleting(null); }
    else toast.error('Erro ao excluir campanha');
  };

  const handleToggleStatus = async (c: Campaign) => {
    const next: CampaignStatus = c.status === 'active' ? 'paused' : 'active';
    const result = await updateCampaign(c.id, { status: next });
    if (result.ok) toast.success(`Campanha ${next === 'active' ? 'reativada' : 'pausada'}`);
  };

  const handleComplete = async (c: Campaign) => {
    const result = await updateCampaign(c.id, { status: 'completed' });
    if (result.ok) toast.success('Campanha concluída!');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageHeader title="Campanhas" subtitle={<>{currentWorkspace ? `Campanhas de ${currentWorkspace.name}` : 'Selecione um cliente para ver as campanhas'}</>} />
        {currentWorkspace && (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" />
            Nova campanha
          </Button>
        )}
      </div>

      {!currentWorkspace ? (
        <Card>
          <EmptyState icon={Megaphone} title="Selecione um cliente" description="Use o seletor no topo para escolher um workspace." />
        </Card>
      ) : campaigns.length === 0 ? (
        <Card>
          <EmptyState
            icon={Megaphone}
            title="Nenhuma campanha"
            description="Crie campanhas para agrupar ações do calendário."
            action={<Button onClick={openCreate}>+ Nova campanha</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {campaigns.map(c => {
            const isActive = c.status === 'active';
            return (
              <Card key={c.id} className="relative overflow-hidden">
                {/* Barra de cor no topo */}
                <div className="h-1.5 w-full rounded-t-lg -mt-px" style={{ backgroundColor: c.color || '#0066FF' }} />

                <div className="flex items-start justify-between mb-2 mt-1">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${c.color || '#0066FF'}20` }}>
                      <Megaphone className="w-5 h-5" style={{ color: c.color || '#0066FF' }} />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{c.name}</h3>
                      {c.objective && <p className="text-sm text-gray-500 mt-0.5">{c.objective}</p>}
                    </div>
                  </div>
                  {statusBadge(c.status)}
                </div>

                {/* Metadados */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400 mb-2">
                  {c.start_date && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {formatDate(c.start_date)} — {c.end_date ? formatDate(c.end_date) : '?'}
                    </span>
                  )}
                  {c.audience && (
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {c.audience}
                    </span>
                  )}
                  {c.product && (
                    <span className="text-gray-400">{c.product}</span>
                  )}
                </div>

                {/* Ações */}
                <div className="flex items-center gap-2 pt-2.5 border-t border-gray-100">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(c)} className="text-gray-600">
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Editar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleToggleStatus(c)} className={isActive ? 'text-amber-600' : 'text-emerald-600'}>
                    {isActive ? <><Pause className="w-3.5 h-3.5 mr-1" /> Pausar</> : <><Play className="w-3.5 h-3.5 mr-1" /> Ativar</>}
                  </Button>
                  {isActive && (
                    <Button variant="ghost" size="sm" onClick={() => handleComplete(c)} className="text-primary-600">
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Concluir
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(c)} className="text-red-500 ml-auto">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create / Edit Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar Campanha' : 'Nova Campanha'} size="lg">
        <div className="space-y-4">
          <Input label="Nome *" value={formData.name} onChange={e => setFormData(p => ({ ...p, name: e.target.value }))} placeholder="Ex: Campanha Dia dos Pais" />
          <Input label="Objetivo" value={formData.objective} onChange={e => setFormData(p => ({ ...p, objective: e.target.value }))} placeholder="Ex: Aumentar vendas" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Início" type="date" value={formData.start_date} onChange={e => setFormData(p => ({ ...p, start_date: e.target.value }))} />
            <Input label="Fim" type="date" value={formData.end_date} onChange={e => setFormData(p => ({ ...p, end_date: e.target.value }))} />
          </div>
          <Textarea label="Descrição" value={formData.description} onChange={e => setFormData(p => ({ ...p, description: e.target.value }))} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Público" value={formData.audience} onChange={e => setFormData(p => ({ ...p, audience: e.target.value }))} />
            <Input label="Produto" value={formData.product} onChange={e => setFormData(p => ({ ...p, product: e.target.value }))} />
          </div>
          <Select
            label="Prioridade"
            value={formData.priority}
            onChange={e => setFormData(p => ({ ...p, priority: e.target.value }))}
            options={PRIORITIES.map(p => ({ value: p.value, label: p.label }))}
          />
          {/* Cor */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Cor da campanha</label>
            <div className="flex items-center gap-2 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setFormData(p => ({ ...p, color: c }))}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${formData.color === c ? 'border-gray-900 scale-110' : 'border-transparent hover:scale-105'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                value={formData.color}
                onChange={e => setFormData(p => ({ ...p, color: e.target.value }))}
                className="w-7 h-7 rounded-full cursor-pointer border border-gray-200"
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancelar</Button>
          <Button onClick={handleSave} disabled={!formData.name.trim()}>{editing ? 'Salvar' : 'Criar campanha'}</Button>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} title="Excluir campanha" size="sm">
        <p className="text-sm text-gray-600">
          Tem certeza que deseja excluir <strong>{deleting?.name}</strong>? Esta ação não pode ser desfeita.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancelar</Button>
          <Button variant="danger" onClick={handleDelete}>Excluir</Button>
        </div>
      </Modal>
    </div>
  );
}
