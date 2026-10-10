import { useState } from 'react';
import { Action } from '@/types';
import Drawer from '@/components/ui/Drawer';
import Modal from '@/components/ui/Modal';
import StatusBadge from './StatusBadge';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import Avatar from '@/components/ui/Avatar';
import { CONTENT_FORMATS, OBJECTIVES, FUNNEL_STAGES, ACTION_TYPES, ACTION_STATUSES } from '@/lib/constants';
import { formatDate, formatTime, cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Pencil, Copy, Trash2, ExternalLink, MessageSquare, Calendar, Clock, Target, Megaphone, Send, CheckCircle2 } from 'lucide-react';

interface ActionDrawerProps {
  action: Action | null;
  isOpen: boolean;
  onClose: () => void;
  onEdit: (action: Action) => void;
  onDelete?: (id: string) => Promise<boolean | { ok: boolean; error?: string }> | boolean | { ok: boolean; error?: string };
  onDuplicate?: (action: Action) => void;
  onUpdate?: (id: string, patch: Partial<Action>) => Promise<{ ok: boolean; error?: string }>;
}

// Acoes de conteudo terminam em 'published'; tarefas em 'completed'
const CONTENT_ACTION_TYPES = ['content', 'publication', 'campaign', 'ad'];

export default function ActionDrawer({ action, isOpen, onClose, onEdit, onDelete, onDuplicate, onUpdate }: ActionDrawerProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updating, setUpdating] = useState(false);

  if (!action) return null;

  const pillar = action.editorial_pillar;
  const campaign = action.campaign;
  const responsible = action.responsible;

  const isContent = !!action.format || CONTENT_ACTION_TYPES.includes(action.action_type);
  const doneStatus: Action['status'] = isContent ? 'published' : 'completed';
  const canComplete = !['published', 'completed', 'cancelled'].includes(action.status);

  const applyStatus = async (newStatus: Action['status'], successMsg: string) => {
    if (!onUpdate || updating) return;
    const prev = action.status;
    setUpdating(true);
    const result = await onUpdate(action.id, { status: newStatus });
    setUpdating(false);
    if (result.ok) {
      toast.success(successMsg, {
        action: {
          label: 'Desfazer',
          onClick: () => { onUpdate(action.id, { status: prev }); },
        },
      });
    } else {
      toast.error(result.error || 'Erro ao alterar status');
    }
  };

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title="Detalhes da Ação" width="lg">
      <div className="space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-start justify-between mb-3">
            <h3 className="text-lg font-semibold text-gray-900">{action.title}</h3>
            <StatusBadge status={action.status} />
          </div>
          {action.description && (
            <p className="text-sm text-gray-500">{action.description}</p>
          )}
        </div>

        {/* Status — conclusao rapida + troca manual (somente quem tem permissao de edicao) */}
        {onUpdate && (
          <div className="space-y-2">
            {canComplete && (
              <Button
                variant="success"
                size="sm"
                className="w-full"
                loading={updating}
                onClick={() => applyStatus(doneStatus, isContent ? 'Ação publicada!' : 'Ação concluída!')}
              >
                <CheckCircle2 className="w-4 h-4" />
                {isContent ? 'Publicar' : 'Concluir'}
              </Button>
            )}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider shrink-0">Status</span>
              <Select
                value={action.status}
                disabled={updating}
                onChange={(e) => {
                  const newStatus = e.target.value as Action['status'];
                  if (newStatus !== action.status) applyStatus(newStatus, 'Status atualizado!');
                }}
                options={Object.entries(ACTION_STATUSES).map(([value, conf]) => ({ value, label: conf.label }))}
                className="flex-1"
              />
            </div>
          </div>
        )}

        {/* Sync Status */}
        {action.sync_status !== 'not_synced' && (
          <div className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm',
            action.sync_status === 'synced' && 'bg-emerald-50 text-emerald-700',
            action.sync_status === 'modified_after_sync' && 'bg-amber-50 text-amber-700',
            action.sync_status === 'sync_error' && 'bg-red-50 text-red-700',
          )}>
            <ExternalLink className="w-4 h-4" />
            {action.sync_status === 'synced' && 'Sincronizado com Google Calendar'}
            {action.sync_status === 'modified_after_sync' && 'Alterado após última sincronização'}
            {action.sync_status === 'sync_error' && 'Erro na sincronização'}
          </div>
        )}

        {/* Basic Info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Data</p>
            <p className="text-sm text-gray-900 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gray-400" />
              {formatDate(action.action_date)}
            </p>
          </div>
          {action.action_time && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Horário</p>
              <p className="text-sm text-gray-900 flex items-center gap-2">
                <Clock className="w-4 h-4 text-gray-400" />
                {formatTime(action.action_time)}
              </p>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Tipo</p>
            <p className="text-sm text-gray-900">{ACTION_TYPES[action.action_type]}</p>
          </div>
          {action.format && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Formato</p>
              <p className="text-sm text-gray-900">{CONTENT_FORMATS[action.format]}</p>
            </div>
          )}
          {(action.channels?.length || action.channel) && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Canais</p>
              <div className="flex flex-wrap gap-1.5">
                {(action.channels?.length ? action.channels : [action.channel]).filter(Boolean).map(c => (
                  <span key={c} className="px-2 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-xs text-gray-700">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
          {responsible && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Responsável</p>
              <p className="text-sm text-gray-900 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center text-xs font-bold">
                  {responsible.full_name?.charAt(0)?.toUpperCase() || '?'}
                </span>
                {responsible.full_name}
              </p>
            </div>
          )}
        </div>

        {/* Strategy */}
        {(action.objective || action.funnel_stage || pillar || campaign) && (
          <div className="border-t border-gray-100 pt-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Estratégia</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {action.objective && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Objetivo</p>
                  <p className="text-sm text-gray-900 flex items-center gap-2">
                    <Target className="w-4 h-4 text-gray-400" />
                    {OBJECTIVES[action.objective]}
                  </p>
                </div>
              )}
              {action.funnel_stage && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Etapa do Funil</p>
                  <p className="text-sm text-gray-900">{FUNNEL_STAGES[action.funnel_stage]}</p>
                </div>
              )}
              {pillar && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Pilar Editorial</p>
                  <Badge style={{ backgroundColor: pillar.color + '20', color: pillar.color }}>
                    {pillar.name}
                  </Badge>
                </div>
              )}
              {campaign && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Campanha</p>
                  <p className="text-sm text-gray-900 flex items-center gap-2">
                    <Megaphone className="w-4 h-4 text-gray-400" />
                    {campaign.name}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        {(action.hook || action.main_message || action.copy_text || action.cta) && (
          <div className="border-t border-gray-100 pt-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Conteúdo</h4>
            <div className="space-y-3">
              {action.hook && (
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Hook</p>
                  <p className="text-sm text-gray-900 bg-gray-50 rounded-lg p-3">{action.hook}</p>
                </div>
              )}
              {action.main_message && (
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Mensagem Principal</p>
                  <p className="text-sm text-gray-900 bg-gray-50 rounded-lg p-3">{action.main_message}</p>
                </div>
              )}
              {action.copy_text && (
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Copy</p>
                  <p className="text-sm text-gray-900 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap">{action.copy_text}</p>
                </div>
              )}
              {action.cta && (
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">CTA</p>
                  <p className="text-sm text-gray-900 bg-gray-50 rounded-lg p-3">{action.cta}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Production */}
        {(action.audience || action.product || (action.products?.length ?? 0) > 0 || action.theme || action.observations) && (
          <div className="border-t border-gray-100 pt-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Produção</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {action.audience && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Público</p>
                  <p className="text-sm text-gray-900">{action.audience}</p>
                </div>
              )}
              {(action.products?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Produtos</p>
                  <div className="flex flex-wrap gap-1.5">
                    {action.products!.map(p => (
                      <span key={p.id} className="text-xs font-medium text-gray-700 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded-full">
                        {p.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {!action.products?.length && action.product && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Produto</p>
                  <p className="text-sm text-gray-900">{action.product}</p>
                </div>
              )}
              {action.theme && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Tema</p>
                  <p className="text-sm text-gray-900">{action.theme}</p>
                </div>
              )}
              {action.observations && (
                <div className="col-span-2 space-y-1">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Observações</p>
                  <p className="text-sm text-gray-900">{action.observations}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Meta */}
        <div className="border-t border-gray-100 pt-4 text-xs text-gray-400 space-y-1">
          <p>Criado em: {formatDate(action.created_at)}</p>
          {action.updated_at !== action.created_at && (
            <p>Atualizado em: {formatDate(action.updated_at)}</p>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-gray-100 pt-4 flex flex-wrap gap-2">
          <Button onClick={() => onEdit(action)} size="sm">
            <Pencil className="w-4 h-4" />
            Editar
          </Button>
          {onDuplicate && (
            <Button variant="outline" size="sm" onClick={() => { onDuplicate(action); onClose(); }}>
              <Copy className="w-4 h-4" />
              Duplicar
            </Button>
          )}
          {onDelete && (
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="w-4 h-4" />
              Excluir
            </Button>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal isOpen={confirmDelete} onClose={() => setConfirmDelete(false)} title="Excluir Ação" size="sm">
        <p className="text-sm text-gray-600">
          Tem certeza que deseja excluir a ação <strong>"{action.title}"</strong>?
        </p>
        <p className="text-xs text-gray-400 mt-2">
          Esta ação não pode ser desfeita.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancelar</Button>
          <Button
            variant="danger"
            onClick={async () => {
              setDeleting(true);
              const result = await onDelete!(action.id);
              setDeleting(false);
              setConfirmDelete(false);
              if (typeof result === 'object') {
                if (result.ok) {
                  toast.success('Ação excluída com sucesso!');
                  onClose();
                } else {
                  toast.error(`Erro ao excluir: ${result.error || 'tente novamente'}`);
                }
              } else {
                toast.success('Ação excluída com sucesso!');
                onClose();
              }
            }}
            loading={deleting}
          >
            Excluir
          </Button>
        </div>
      </Modal>
    </Drawer>
  );
}
