import { useState } from 'react';
import Drawer from '@/components/ui/Drawer';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import Button from '@/components/ui/Button';
import Avatar from '@/components/ui/Avatar';
import Badge from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import {
  Building2, Calendar, Mail, Phone, StickyNote, ArrowRight, Info,
  Trash2, Pencil, TrendingUp, Send, MessageSquare, Loader2, Bot, Reply, Users,
} from 'lucide-react';
import {
  LEAD_STAGES, STAGE_META, ACTIVITY_TYPE_META, formatBRL, type LeadStage,
} from '@/lib/crmStages';
import { useLeadActivities, type Lead, type LeadActivity } from '@/hooks/useLeads';
import { toast } from 'sonner';
import { useInstagramConnection } from '@/hooks/useProspecting';
import { IG_SEND_DM_EDGE } from '@/lib/prospecting/instagram';
import { ENVIRONMENT_META } from '@/types';
import { supabase } from '@/lib/supabase';
import ProvisionedAudio from '@/components/ui/ProvisionedAudio';
import Modal from '@/components/ui/Modal';

const ACTIVITY_ICONS: Record<LeadActivity['type'], typeof StickyNote> = {
  note: StickyNote,
  call: Phone,
  meeting: Calendar,
  email: Mail,
  stage_change: ArrowRight,
  system: Info,
  outreach_draft: Pencil,
  outreach_sent: Send,
  reply_received: Reply,
};

interface LeadDrawerProps {
  lead: Lead | null;
  owners: { value: string; label: string }[];
  canDelete: boolean;
  onClose: () => void;
  onEdit: (lead: Lead) => void;
  onStageChange: (lead: Lead, stage: LeadStage) => void;
  onConvert: (lead: Lead) => void;
  onDelete: (lead: Lead) => void;
}

export default function LeadDrawer({
  lead, owners, canDelete, onClose, onEdit, onStageChange, onConvert, onDelete,
}: LeadDrawerProps) {
  const { activities, loading: activitiesLoading, addActivity } = useLeadActivities(lead?.id ?? null);
  const [activityType, setActivityType] = useState<LeadActivity['type']>('note');
  const [activityText, setActivityText] = useState('');
  const [sendingActivity, setSendingActivity] = useState(false);

  const ig = useInstagramConnection(lead?.environment ?? null);
  const [dmOpen, setDmOpen] = useState(false);
  const [dmText, setDmText] = useState('');
  const [sendingDm, setSendingDm] = useState(false);

  const handleSendDm = async () => {
    if (!lead || !dmText.trim()) return;
    setSendingDm(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sessão expirada — faça login novamente');
      const res = await fetch(IG_SEND_DM_EDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lead_id: lead.id, message: dmText.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; profile_url?: string | null; sent_to?: string };
      if (res.ok && (body as { ok?: boolean }).ok) {
        toast.success(`DM enviada ${body.sent_to ?? ''}`);
        setDmOpen(false);
        setDmText('');
      } else if (res.status === 409) {
        toast.error(body.message ?? body.error ?? 'Sem janela de conversa', {
          description: 'O prospect precisa ter interagido nas últimas 24h (regra do Instagram).',
          action: body.profile_url ? { label: 'Abrir no Instagram', onClick: () => window.open(body.profile_url as string, '_blank') } : undefined,
          duration: 10000,
        });
      } else {
        throw new Error(body.error ?? `Falha (${res.status})`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao enviar DM');
    } finally {
      setSendingDm(false);
    }
  };

  if (!lead) return null;

  const stageMeta = STAGE_META[lead.stage];
  const ownerName = lead.owner?.full_name ?? owners.find(o => o.value === lead.owner_id)?.label ?? null;

  const handleAddActivity = async () => {
    if (!activityText.trim()) return;
    setSendingActivity(true);
    try {
      await addActivity(activityType, activityText);
      setActivityText('');
    } finally {
      setSendingActivity(false);
    }
  };

  return (
    <Drawer isOpen={!!lead} onClose={onClose} title={lead.name} width="lg">
      <div className="space-y-4">
        {/* Banner do agente */}
      {lead.origin === 'prospecting_agent' && (
        <div className={cn(
          'border rounded-lg p-3 space-y-1.5',
          lead.conversation_mode === 'human' ? 'bg-rose-50 border-rose-200' : 'bg-amber-50 border-amber-200',
        )}>
          <div className="flex items-center gap-2">
            <Bot className={cn('w-4 h-4 shrink-0', lead.conversation_mode === 'human' ? 'text-rose-600' : 'text-amber-600')} />
            <p className={cn('text-xs font-semibold', lead.conversation_mode === 'human' ? 'text-rose-700' : 'text-amber-700')}>
              Lead captado pelo Agente de Prospecção IA
              {lead.prospecting_status ? ` — ${lead.prospecting_status.replace(/_/g, ' ')}` : ''}
            </p>
          </div>
          {(lead.lead_temperature || lead.conversation_mode) && (
            <div className="flex items-center gap-1.5 flex-wrap pl-6">
              {lead.lead_temperature && (
                <span className={cn(
                  'px-2 py-0.5 rounded-full text-[10px] font-semibold',
                  lead.lead_temperature === 'hot' ? 'bg-red-100 text-red-700'
                  : lead.lead_temperature === 'warm' ? 'bg-orange-100 text-orange-700'
                  : 'bg-gray-100 text-gray-600',
                )}>
                  {lead.lead_temperature === 'hot' ? '🔥 Quente' : lead.lead_temperature === 'warm' ? '🌤️ Morno' : '❄️ Frio'}
                </span>
              )}
              {lead.conversation_mode && (
                <span className={cn(
                  'px-2 py-0.5 rounded-full text-[10px] font-semibold',
                  lead.conversation_mode === 'human' ? 'bg-rose-100 text-rose-700' : 'bg-sky-100 text-sky-700',
                )}>
                  {lead.conversation_mode === 'human' ? '👤 Humano respondendo' : '🤖 IA respondendo'}
                </span>
              )}
              {(lead.jev_memory?.message_count ?? 0) > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600">
                  💬 {lead.jev_memory!.message_count} msgs
                </span>
              )}
            </div>
          )}
          {lead.conversation_mode === 'human' && lead.escalation_reason && (
            <p className="text-[11px] text-rose-600 pl-6">🔔 Escalonado: {lead.escalation_reason}</p>
          )}
          {lead.conversation_summary && (
            <p className="text-[11px] text-gray-500 pl-6 line-clamp-3">📝 {lead.conversation_summary}</p>
          )}
        </div>
      )}

        {/* Etapa */}
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium', stageMeta.badgeClass)}>
            <span className={cn('w-1.5 h-1.5 rounded-full', stageMeta.dotClass)} />
            {stageMeta.label}
          </span>
          {showEnvBadge(lead)}
        </div>
        <Select
          label="Mover etapa"
          value={lead.stage}
          onChange={(e) => onStageChange(lead, e.target.value as LeadStage)}
          options={LEAD_STAGES.map(s => ({ value: s, label: STAGE_META[s].label }))}
        />

        {/* DM do Instagram — exige conexão do ambiente */}
        {lead.social_instagram && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-gray-700">📷 Instagram do lead: @{lead.social_instagram}</p>
              <p className="text-[11px] text-gray-400 truncate">
                {ig.connection ? `Conectado via @${ig.connection.username ?? ig.connection.ig_user_id}` : 'Ambiente sem Instagram conectado'}
              </p>
            </div>
            {ig.connection && (
              <Button size="sm" onClick={() => setDmOpen(true)}>
                <Send className="w-3.5 h-3.5" />
                Enviar DM
              </Button>
            )}
          </div>
        )}

        {/* Cliente convertido */}
        {lead.workspace && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-emerald-700">Cliente na agenda</p>
              <p className="text-sm text-emerald-900 truncate">{lead.workspace.name}</p>
            </div>
          </div>
        )}

        {/* Motivo da perda */}
        {lead.stage === 'lost' && lead.lost_reason && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-xs font-semibold text-red-700 mb-0.5">Motivo da perda</p>
            <p className="text-sm text-red-700">{lead.lost_reason}</p>
          </div>
        )}

        {/* Análise do agente */}
        {lead.ai_analyzed_at && (
          <div className="bg-primary-50 border border-primary-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-primary-700 flex items-center gap-1.5">
                <Bot className="w-3.5 h-3.5" />
                Análise do Agente IA
              </p>
              <span className="text-[11px] text-primary-500">
                {new Date(lead.ai_analyzed_at).toLocaleDateString('pt-BR')}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs mt-1">
              <span className="font-semibold text-primary-900 tabular-nums">
                Fit: {Math.round((Number(lead.ai_fit) || 0) * 100)}%
              </span>
              {lead.ai_priority && (
                <span className="px-1.5 py-0.5 rounded-full bg-white text-primary-700 border border-primary-100">
                  Prioridade: {lead.ai_priority}
                </span>
              )}
              {lead.ai_next_step && (
                <span className="text-gray-600">
                  Próximo passo: {lead.ai_next_step.replace(/_/g, ' ')}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Produtos de interesse */}
        {(lead.products?.length ?? 0) > 0 && (
          <div>
            <p className="text-xs text-gray-400 mb-1.5">Produtos de interesse</p>
            <div className="flex flex-wrap gap-1.5">
              {lead.products!.map(x => (
                x.product && (
                  <span key={x.product.id} className="text-xs font-medium text-gray-700 bg-gray-100 border border-gray-200 px-2 py-1 rounded-full">
                    {x.product.name}
                  </span>
                )
              ))}
            </div>
          </div>
        )}

        {/* Vendedores vinculados */}
        {(lead.team?.length ?? 0) > 0 && (
          <div>
            <p className="text-xs text-gray-400 mb-1.5 flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> Vendedores vinculados
            </p>
            <div className="flex flex-wrap gap-2">
              {lead.team!.map(x => (
                x.user && (
                  <span key={x.user.id} className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-full pl-0.5 pr-2.5 py-0.5">
                    <Avatar name={x.user.full_name} src={x.user.avatar_url} size="xs" />
                    <span className="text-xs text-gray-700">{x.user.full_name}</span>
                  </span>
                )
              ))}
            </div>
          </div>
        )}

        {/* Dados */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <InfoRow label="Contato" value={lead.contact_name} />
          <InfoRow
            label="E-mail"
            value={lead.contact_email}
            icon={<Mail className="w-3.5 h-3.5 text-gray-400" />}
          />
          <InfoRow
            label="Telefone"
            value={lead.contact_phone}
            icon={<Phone className="w-3.5 h-3.5 text-gray-400" />}
          />
          <InfoRow label="Origem" value={lead.source} />
          <InfoRow label="Segmento" value={lead.segment} />
          <InfoRow label="Valor estimado" value={lead.value != null ? formatBRL(lead.value) : null} />
          <InfoRow
            label="Recorrência mensal"
            value={lead.monthly_value != null ? formatBRL(lead.monthly_value) : null}
            icon={<TrendingUp className="w-3.5 h-3.5 text-gray-400" />}
          />
          <InfoRow
            label="Previsão de fechamento"
            value={lead.expected_close_date ? new Date(lead.expected_close_date + 'T00:00:00').toLocaleDateString('pt-BR') : null}
            icon={<Calendar className="w-3.5 h-3.5 text-gray-400" />}
          />
          <InfoRow label="Responsável" value={ownerName} />
        </div>

        {lead.notes && (
          <div>
            <p className="text-xs text-gray-400 mb-1">Observações</p>
            <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-lg p-3">{lead.notes}</p>
          </div>
        )}

        {/* Ações */}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => onEdit(lead)}>
            <Pencil className="w-3.5 h-3.5" />
            Editar
          </Button>
          {!lead.workspace && lead.stage !== 'won' && (
            <Button variant="success" size="sm" onClick={() => onConvert(lead)}>
              <Building2 className="w-3.5 h-3.5" />
              Converter em cliente
            </Button>
          )}
          {canDelete && (
            <Button variant="ghost" size="sm" className="text-red-500 hover:bg-red-50" onClick={() => onDelete(lead)}>
              <Trash2 className="w-3.5 h-3.5" />
              Excluir
            </Button>
          )}
        </div>

        {/* Timeline de atividades */}
        <div className="border-t border-gray-100 pt-4">
          <h4 className="text-sm font-semibold text-gray-900 mb-3">Atividades</h4>

          {activitiesLoading && activities.length === 0 ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 text-primary-500 animate-spin" />
            </div>
          ) : activities.length === 0 ? (
            <p className="text-xs text-gray-400 italic mb-3">Nenhuma atividade registrada.</p>
          ) : (
            <div className="space-y-3 mb-4 max-h-72 overflow-y-auto pr-1">
              {activities.map(a => {
                const Icon = ACTIVITY_ICONS[a.type] ?? Info;
                return (
                  <div key={a.id} className="flex gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                      <Icon className="w-3.5 h-3.5 text-gray-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-semibold text-gray-700">{ACTIVITY_TYPE_META[a.type]?.label ?? a.type}</span>
                        <span className="text-[11px] text-gray-400">
                          {a.author?.full_name ?? '—'} · {new Date(a.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{a.content}</p>
                      {a.metadata?.audio_path && <ProvisionedAudio path={a.metadata.audio_path} className="w-full h-8" />}
                      {!a.metadata?.audio_path && a.metadata?.audio_url && <ProvisionedAudio url={a.metadata.audio_url} className="w-full h-8" />}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Registrar atividade */}
          <div className="bg-gray-50 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-gray-400 shrink-0" />
              <Select
                value={activityType}
                onChange={(e) => setActivityType(e.target.value as LeadActivity['type'])}
                options={['note', 'call', 'meeting', 'email'].map(t => ({
                  value: t,
                  label: ACTIVITY_TYPE_META[t].label,
                }))}
                className="max-w-[160px]"
              />
            </div>
            <Textarea
              value={activityText}
              onChange={(e) => setActivityText(e.target.value)}
              placeholder="Registrar interação com o lead..."
              rows={2}
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={handleAddActivity} loading={sendingActivity} disabled={!activityText.trim()}>
                <Send className="w-3.5 h-3.5" />
                Registrar
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Modal: DM do Instagram */}
      <Modal isOpen={dmOpen} onClose={() => setDmOpen(false)} title={`DM para @${lead.social_instagram ?? ''}`} size="md">
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Mensagem enviada pelo Instagram do ambiente (regra do Instagram: só dentro da janela de 24h após interação do prospect).
          </p>
          <Textarea
            label="Mensagem"
            value={dmText}
            onChange={(e) => setDmText(e.target.value)}
            placeholder="Olá! Vi o interesse de vocês em..."
            rows={5}
          />
        </div>
        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setDmOpen(false)}>Cancelar</Button>
          <Button onClick={handleSendDm} loading={sendingDm} disabled={!dmText.trim()}>
            <Send className="w-3.5 h-3.5" />
            Enviar
          </Button>
        </div>
      </Modal>
    </Drawer>
  );
}

function showEnvBadge(lead: Lead) {
  const meta = ENVIRONMENT_META[lead.environment];
  return <Badge variant="default" size="sm">{meta.emoji} {meta.short}</Badge>;
}

function InfoRow({ label, value, icon }: { label: string; value: string | null; icon?: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <p className="text-xs text-gray-400 flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className="text-sm text-gray-900 break-words">{value}</p>
    </div>
  );
}
