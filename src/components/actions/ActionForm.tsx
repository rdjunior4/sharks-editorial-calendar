import { localDate } from '@/lib/localDate';
import { useState, useEffect } from 'react';
import { Action, ContentFormat, Objective, ActionType, ActionStatus, FunnelStage, EnvironmentType } from '@/types';
import Drawer from '@/components/ui/Drawer';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import Textarea from '@/components/ui/Textarea';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Tabs from '@/components/ui/Tabs';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useActions } from '@/hooks/useActions';
import { useEditorial } from '@/hooks/useEditorial';
import { useActiveCampaigns } from '@/hooks/useCampaigns';
import { bulkCreateActions } from '@/lib/actionService';
import { supabase } from '@/lib/supabase';
import { formatCalendarDate, addDays, startOfWeek, parseISO, format } from '@/lib/dateUtils';
import { ACTION_TYPES, CONTENT_FORMATS, OBJECTIVES, FUNNEL_STAGES, ACTION_STATUSES, ACTION_TYPES_BY_ENV, FORM_SECTIONS_BY_ENV, DEFAULT_CHANNELS } from '@/lib/constants';
import { toast } from 'sonner';
import ChipMultiSelect from '@/components/ui/ChipMultiSelect';
import { CalendarDays } from 'lucide-react';

interface ActionFormProps {
  action: Action | null;
  isOpen: boolean;
  onClose: () => void;
  defaultDate?: string;
  environment?: EnvironmentType;
}

export default function ActionForm({ action, isOpen, onClose, defaultDate, environment = 'sharks_company' }: ActionFormProps) {
  const { currentWorkspace, workspacesByEnv } = useWorkspace();
  // Apenas workspaces do ambiente do formulário (evita cross-env)
  const workspaces = workspacesByEnv(environment);
  const isEditing = !!action;
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeSection, setActiveSection] = useState('basic');

  const workspaceId = action?.workspace_id || currentWorkspace?.id || workspaces[0]?.id || '';
  const { pillars } = useEditorial(workspaceId);
  const campaigns = useActiveCampaigns(workspaceId);
  const { create, update, remove } = useActions({});
  // Form state
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    workspace_id: workspaceId,
    action_date: localDate(),
    action_time: '09:00',
    action_type: 'content' as ActionType,
    format: '' as string,
    channel: '',
    campaign_id: '' as string,
    editorial_pillar_id: '' as string,
    objective: '' as string,
    funnel_stage: '' as string,
    audience: '',
    product: '',
    product_id: '' as string | null,
    product_ids: [] as string[],
    theme: '',
    hook: '',
    main_message: '',
    copy_text: '',
    cta: '',
    status: 'draft' as ActionStatus,
    observations: '',
    responsible_ids: [] as string[],
    internal_deadline: '' as string,
  });

  // Estender ação (pop-up pós-salvar): replicar na semana/mês
  // — precisa vir DEPOIS de formData (usa formData.action_date)
  const [extendOpen, setExtendOpen] = useState(false);
  const [extending, setExtending] = useState(false);
  const [extendStatus, setExtendStatus] = useState<ActionStatus>('draft');
  const [skipWeekends, setSkipWeekends] = useState(false);

  /** Datas: do dia escolhido ADIANTE até o fim da semana/mês */
  const datesFor = (mode: 'week' | 'month'): string[] => {
    if (!formData.action_date) return [];
    const base = parseISO(formData.action_date + 'T00:00:00');
    let end: Date;
    if (mode === 'week') {
      // domingo da semana que contém a data
      end = addDays(startOfWeek(base, { weekStartsOn: 1 }), 6);
    } else {
      // último dia do mês da data escolhida
      end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    }
    const out: string[] = [];
    let cur = base;
    while (cur <= end) {
      const day = cur.getDay();
      if (!skipWeekends || (day !== 0 && day !== 6)) out.push(formatCalendarDate(cur));
      cur = addDays(cur, 1);
    }
    return out;
  };

  /** Preview do pop-up: contagem e intervalo SEM o dia-base (já salvo) */
  const extendPreview = (mode: 'week' | 'month') => {
    const dates = datesFor(mode).filter(d => d !== formData.action_date);
    const fmt = (d: string) => format(parseISO(d + 'T00:00:00'), 'dd/MM');
    return {
      count: dates.length,
      range: dates.length > 0 ? `${fmt(dates[0])} → ${fmt(dates[dates.length - 1])}` : '',
    };
  };

  /** Cria as ações da extensão (mesmo status da ação salva) */
  const handleExtend = async (mode: 'week' | 'month') => {
    if (extending) return;
    const dates = datesFor(mode).filter(d => d !== formData.action_date);
    if (dates.length === 0) {
      setExtendOpen(false);
      onClose();
      return;
    }
    setExtending(true);
    try {
      const rows = dates.map(d => ({
        workspace_id: formData.workspace_id,
        environment: environment || 'sharks_company',
        title: formData.title,
        description: formData.description || null,
        action_date: d,
        action_time: formData.action_time || null,
        action_type: formData.action_type,
        format: (formData.format || null) as ContentFormat | null,
        channel: formData.channel || null,
        campaign_id: formData.campaign_id || null,
        editorial_pillar_id: formData.editorial_pillar_id || null,
        objective: (formData.objective || null) as Objective | null,
        funnel_stage: (formData.funnel_stage || null) as FunnelStage | null,
          audience: formData.audience || null,
    product_id: formData.product_id || null,
    product_ids: formData.product_ids,
        product: formData.product || null,
        theme: formData.theme || null,
        hook: formData.hook || null,
        main_message: formData.main_message || null,
        copy_text: formData.copy_text || null,
        cta: formData.cta || null,
        internal_deadline: formData.internal_deadline || null,
        status: extendStatus,
        observations: formData.observations || null,
        responsible_id: formData.responsible_ids[0] || null,
        responsible_ids: formData.responsible_ids,
        is_auto_generated: false,
      }));
      const result = await bulkCreateActions(rows);
      if (!result.ok) {
        toast.error(result.error || 'Erro ao estender a ação');
        return;
      }
      if (result.warning) toast.warning(result.warning);
      else toast.success(`+${result.count} ações criadas (${mode === 'week' ? 'semana' : 'mês'})!`);
      setExtendOpen(false);
      onClose();
    } finally {
      setExtending(false);
    }
  };

  // Time de Produção para o seletor de responsáveis — admins + equipe,
  // independente do cliente selecionado (mesma lista da página Time)
  const [teamMembers, setTeamMembers] = useState<Array<{ id: string; full_name: string }>>([]);

  // Catálogo do ambiente (065): produtos ativos do environment da agenda
  const [productOptions, setProductOptions] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!isOpen || !environment) return;
    let active = true;
    (async () => {
      const pRes = await supabase
        .from('environment_products')
        .select('id, name')
        .eq('environment', environment)
        .eq('status', 'active')
        .order('name');
      if (!active) return;
      setProductOptions((pRes.data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => { active = false; };
  }, [isOpen, environment]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    // Responsáveis = staff do ambiente da agenda (user_environments, 023) —
    // antes filtrava role hardcoded e ignorava o multiambiente
    (async () => {
      const { data: envIds } = await supabase
        .from('user_environments')
        .select('user_id')
        .eq('environment', environment)
        .in('role', ['admin', 'team']);
      const ids = (envIds ?? []).map(r => r.user_id).filter(Boolean);
      if (ids.length === 0) { if (active) setTeamMembers([]); return; }
      const { data: users, error } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', ids)
        .order('full_name');
      if (!active) return;
      if (error) { console.error('responsáveis:', error.message); setTeamMembers([]); return; }
      const list = (users ?? []).map(u => ({ id: u.id, full_name: u.full_name }));
      // Preserva os responsáveis atuais (edição) mesmo se não estiverem na lista
      const current = action?.responsibles ?? [];
      if (current.length > 0) {
        for (const r of current) {
          if (!list.some(m => m.id === r.id)) {
            list.push({ id: r.id, full_name: r.full_name });
          }
        }
      } else if (action?.responsible_id && action?.responsible && !list.some(m => m.id === action.responsible_id)) {
        list.push({ id: action.responsible.id, full_name: action.responsible.full_name });
      }
      setTeamMembers(list);
    })();
    return () => { active = false; };
  }, [isOpen, environment, action?.responsibles, action?.responsible_id]);

  useEffect(() => {
    if (isOpen) {
      setSkipWeekends(false);
      if (action) {
        setFormData({
          title: action.title ?? '',
          description: action.description || '',
          workspace_id: action.workspace_id ?? workspaceId,
          action_date: action.action_date || defaultDate || localDate(),
          action_time: action.action_time?.slice(0, 5) || '09:00',
          action_type: action.action_type || (environment === 'estrategos' ? 'meeting' : 'content') as ActionType,
          format: action.format || '',
          channel: action.channel || '',
          campaign_id: action.campaign_id || '',
          editorial_pillar_id: action.editorial_pillar_id || '',
          objective: action.objective || '',
          funnel_stage: action.funnel_stage || '',
          audience: action.audience || '',
          product: action.product || '',
          theme: action.theme || '',
          hook: action.hook || '',
          main_message: action.main_message || '',
          copy_text: action.copy_text || '',
          cta: action.cta || '',
          status: action.status || 'draft',
          observations: action.observations || '',
          product_id: action.product_id ?? '',
          product_ids: action.products?.length
            ? action.products.map(p => p.id)
            : (action.product_id ? [action.product_id] : []),
          responsible_ids: action.responsibles?.length
            ? action.responsibles.map(r => r.id)
            : (action.responsible_id ? [action.responsible_id] : []),
          internal_deadline: action.internal_deadline || '',
        });
      } else {
        setFormData({
          title: '',
          description: '',
          workspace_id: workspaceId,
          action_date: defaultDate || localDate(),
          action_time: '09:00',
          action_type: environment === 'estrategos' ? 'meeting' : 'content',
          format: '',
          channel: '',
          campaign_id: '',
          editorial_pillar_id: '',
          objective: '',
          funnel_stage: '',
          audience: '',
          product: '',
          theme: '',
          hook: '',
          main_message: '',
          copy_text: '',
          cta: '',
          status: 'draft',
          observations: '',
          product_id: '' as string | null,
          product_ids: [] as string[],
          responsible_ids: [] as string[],
          internal_deadline: '',
        });
      }
    }
  }, [action, isOpen, defaultDate, workspaceId]);

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async (asDraft = false) => {
    if (!(formData.title ?? '').trim()) return;

    setSaving(true);
    try {
      // ─── Aviso de conflito: mesmo responsável, mesmo dia e mesma hora ───
      if (formData.action_time && formData.responsible_ids[0]) {
        const { data: conflicts } = await supabase
          .from('actions')
          .select('id, title')
          .eq('action_date', formData.action_date)
          .eq('action_time', formData.action_time)
          .eq('responsible_id', formData.responsible_ids[0])
          .neq('status', 'cancelled')
          .neq('id', action?.id ?? '00000000-0000-0000-0000-000000000000')
          .limit(3);
        if (conflicts && conflicts.length > 0) {
          const names = conflicts.map(c => c.title).join(' · ');
          toast.warning(`Conflito de horário: o responsável já tem "${names.slice(0, 80)}" nesse dia/hora.`, { duration: 8000 });
        }
      }

      // ─── Ação única (o pop-up de extensão aparece depois) ───
      const payload = {
        ...formData,
        workspace_id: formData.workspace_id,
        environment: environment || 'sharks_company',
        format: (formData.format || null) as ContentFormat | null,
        objective: (formData.objective || null) as Objective | null,
        funnel_stage: (formData.funnel_stage || null) as FunnelStage | null,
        status: (asDraft ? 'draft' : formData.status) as ActionStatus,
        campaign_id: formData.campaign_id || null,
        editorial_pillar_id: formData.editorial_pillar_id || null,
        // Compatibilidade: responsável principal = 1º da lista
        responsible_id: formData.responsible_ids[0] || null,
        responsible_ids: formData.responsible_ids,
        internal_deadline: formData.internal_deadline || null,
      };

      const result = isEditing
        ? await update(action.id, payload)
        : await create(payload);

      if (!result.ok) {
        toast.error(result.error || 'Erro ao salvar ação');
        return;
      }

      if (result.ok && result.data) {
        if (result.warning) {
          toast.warning(result.warning);
          onClose();
          return;
        }
        toast.success(isEditing ? 'Ação atualizada!' : 'Ação salva!');
      }

      // Pop-up pós-salvar: deseja estender? (não fechamos o form ainda)
      setExtendStatus(asDraft ? 'draft' : (formData.status as ActionStatus));
      setExtendOpen(true);
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!action) return;
    setSaving(true);
    try {
      const { id: _id, created_at: _ca, updated_at: _ua, ...payload } = action as Record<string, any>;
      const result = await create({
        ...payload,
        title: `${action.title} (cópia)`,
        responsible_ids: action.responsibles?.map(r => r.id) ?? (action.responsible_id ? [action.responsible_id] : []),
        status: 'draft' as ActionStatus,
      });
      if (!result.ok) {
        toast.error(result.error || 'Erro ao duplicar');
        return;
      }
      if (result.warning) toast.warning(result.warning);
      else toast.success('Ação duplicada como rascunho');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const sections = FORM_SECTIONS_BY_ENV[environment] || FORM_SECTIONS_BY_ENV.sharks_company;
  const actionTypesForEnv = ACTION_TYPES_BY_ENV[environment] || ACTION_TYPES_BY_ENV.sharks_company;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={isEditing ? 'Editar Ação' : 'Nova Ação'} width="xl">
      <div className="space-y-6">
        {/* Section tabs */}
        <Tabs
          tabs={sections}
          activeTab={activeSection}
          onChange={setActiveSection}
          buttonClassName="flex-1 justify-center px-2 py-2 text-xs"
        />

        {/* Basic Section */}
        {activeSection === 'basic' && (
          <div className="space-y-4">
            <Select
              label="Cliente"
              value={formData.workspace_id}
              onChange={(e) => handleChange('workspace_id', e.target.value)}
              options={[
                ...(currentWorkspace ? [{ value: currentWorkspace.id, label: currentWorkspace.name }] : []),
                ...workspaces.filter(w => w.id !== currentWorkspace?.id).map(w => ({ value: w.id, label: w.name })),
              ]}
            />
            <Input
              label="Título *"
              value={formData.title}
              onChange={(e) => handleChange('title', e.target.value)}
              placeholder="Ex: Reels sobre novo produto"
            />
            <Textarea
              label="Descrição"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Descreva a ação..."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Data"
                type="date"
                value={formData.action_date}
                onChange={(e) => handleChange('action_date', e.target.value)}
              />
              <Input
                label="Horário"
                type="time"
                value={formData.action_time}
                onChange={(e) => handleChange('action_time', e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                label="Tipo de Ação"
                value={formData.action_type}
                onChange={(e) => handleChange('action_type', e.target.value)}
                options={actionTypesForEnv.map(v => ({ value: v, label: ACTION_TYPES[v] }))}
              />
              <Select
                label="Status"
                value={formData.status}
                onChange={(e) => handleChange('status', e.target.value)}
                options={Object.entries(ACTION_STATUSES).map(([v, s]) => ({ value: v, label: s.label }))}
              />
            </div>
          </div>
        )}

        {/* Strategy Section (Sharks only) */}
        {activeSection === 'strategy' && environment === 'sharks_company' && (
          <div className="space-y-4">
            <Select
              label="Campanha"
              value={formData.campaign_id}
              onChange={(e) => handleChange('campaign_id', e.target.value)}
              placeholder="Nenhuma campanha"
              options={[
                { value: '', label: 'Nenhuma campanha' },
                ...campaigns.map(c => ({ value: c.id, label: c.name })),
              ]}
            />
            <Select
              label="Pilar Editorial"
              value={formData.editorial_pillar_id}
              onChange={(e) => handleChange('editorial_pillar_id', e.target.value)}
              placeholder="Selecione um pilar"
              options={pillars.map(p => ({ value: p.id, label: p.name }))}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                label="Objetivo"
                value={formData.objective}
                onChange={(e) => handleChange('objective', e.target.value)}
                placeholder="Selecione"
                options={Object.entries(OBJECTIVES).map(([v, l]) => ({ value: v, label: l }))}
              />
              <Select
                label="Etapa do Funil"
                value={formData.funnel_stage}
                onChange={(e) => handleChange('funnel_stage', e.target.value)}
                placeholder="Selecione"
                options={Object.entries(FUNNEL_STAGES).map(([v, l]) => ({ value: v, label: l }))}
              />
            </div>
            <ChipMultiSelect
              label="Produtos ou Serviços"
              options={productOptions}
              values={formData.product_ids}
              onChange={(ids) => setFormData(p => ({
                ...p,
                product_ids: ids,
                // Compatibilidade: product text/product_id ficam com o 1º
                product_id: ids[0] ?? null,
                product: productOptions.find(o => o.id === ids[0])?.name ?? '',
              }))}
              placeholder="Selecionar produtos..."
              emptyMessage="Nenhum produto cadastrado — cadastre em Produtos"
            />
            <Input
              label="Público"
              value={formData.audience}
              onChange={(e) => handleChange('audience', e.target.value)}
              placeholder="Ex: Mulheres 25-40 anos"
            />
          </div>
        )}

        {/* Content Section (Sharks only) */}
        {activeSection === 'content' && environment === 'sharks_company' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                label="Formato"
                value={formData.format}
                onChange={(e) => handleChange('format', e.target.value)}
                placeholder="Selecione"
                options={Object.entries(CONTENT_FORMATS).map(([v, l]) => ({ value: v, label: l }))}
              />
              <Select
                label="Canal"
                value={formData.channel}
                onChange={(e) => handleChange('channel', e.target.value)}
                placeholder="Selecione"
                options={[
                  { value: '', label: 'Sem canal' },
                  ...DEFAULT_CHANNELS.map(c => ({ value: c.name, label: c.name })),
                  // Preserva canal legado não listado ao editar
                  ...(formData.channel && !DEFAULT_CHANNELS.some(c => c.name === formData.channel)
                    ? [{ value: formData.channel, label: `${formData.channel} (atual)` }]
                    : []),
                ]}
              />
            </div>
            <Input
              label="Tema"
              value={formData.theme}
              onChange={(e) => handleChange('theme', e.target.value)}
              placeholder="Ex: Dia dos Pais"
            />
            <Input
              label="Hook"
              value={formData.hook}
              onChange={(e) => handleChange('hook', e.target.value)}
              placeholder="Primeira frase que prende atenção"
            />
            <Textarea
              label="Mensagem Principal"
              value={formData.main_message}
              onChange={(e) => handleChange('main_message', e.target.value)}
              placeholder="Mensagem central do conteúdo"
            />
            <Textarea
              label="Copy"
              value={formData.copy_text}
              onChange={(e) => handleChange('copy_text', e.target.value)}
              placeholder="Texto completo da publicação"
              rows={5}
            />
            <Input
              label="CTA"
              value={formData.cta}
              onChange={(e) => handleChange('cta', e.target.value)}
              placeholder="Chamada para ação"
            />
          </div>
        )}

        {/* Planning Section (Estrategos only) */}
        {activeSection === 'planning' && environment === 'estrategos' && (
          <div className="space-y-4">
            <Input
              label="Projeto"
              value={formData.product}
              onChange={(e) => handleChange('product', e.target.value)}
              placeholder="Ex: Implantação ERP, Onboarding cliente"
            />
            <Input
              label="Participantes"
              value={formData.audience}
              onChange={(e) => handleChange('audience', e.target.value)}
              placeholder="Ex: João, Maria, Diretor Comercial"
            />
            <Input
              label="Tema / Assunto"
              value={formData.theme}
              onChange={(e) => handleChange('theme', e.target.value)}
              placeholder="Ex: Revisão trimestral, Apresentação de resultados"
            />
            <Textarea
              label="Pauta / Objetivo"
              value={formData.main_message}
              onChange={(e) => handleChange('main_message', e.target.value)}
              placeholder="O que precisa ser discutido ou decidido..."
            />
            <Textarea
              label="Notas"
              value={formData.copy_text}
              onChange={(e) => handleChange('copy_text', e.target.value)}
              placeholder="Anotações, decisões tomadas, próximos passos..."
              rows={5}
            />
          </div>
        )}

        {/* Production Section */}
        {activeSection === 'production' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Responsáveis <span className="text-gray-400 font-normal">(1 ou mais)</span>
              </label>
              {teamMembers.length === 0 ? (
                <p className="text-xs text-gray-400 italic px-1">Nenhum membro do time disponível</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {teamMembers.map(m => {
                    const selected = formData.responsible_ids.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setFormData(f => ({
                          ...f,
                          responsible_ids: selected
                            ? f.responsible_ids.filter(id => id !== m.id)
                            : [...f.responsible_ids, m.id],
                        }))}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-sm transition-all ${
                          selected
                            ? 'border-primary-300 bg-primary-50 ring-1 ring-primary-200 text-primary-700 font-medium'
                            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                        }`}
                      >
                        <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${
                          selected ? 'bg-primary-500 text-white' : 'border-2 border-gray-300'
                        }`}>
                          {selected && <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 fill-none stroke-current stroke-2"><path d="M2 6l3 3 5-5" /></svg>}
                        </div>
                        <span className="truncate">{m.full_name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {formData.responsible_ids.length === 0 && (
                <p className="text-[11px] text-gray-400 mt-1.5">Sem responsável — a ação fica não atribuída</p>
              )}
            </div>
            <Input
              label="Prazo Interno"
              type="date"
              value={formData.internal_deadline}
              onChange={(e) => handleChange('internal_deadline', e.target.value)}
            />
            <Select
              label="Status"
              value={formData.status}
              onChange={(e) => handleChange('status', e.target.value)}
              options={Object.entries(ACTION_STATUSES).map(([v, s]) => ({ value: v, label: s.label }))}
            />
            <Textarea
              label="Observações"
              value={formData.observations}
              onChange={(e) => handleChange('observations', e.target.value)}
              placeholder="Observações internas..."
            />
          </div>
        )}

        {/* Actions */}
        <div className="border-t border-gray-100 pt-4 flex flex-wrap gap-2 sticky bottom-0 bg-white">
          <Button onClick={() => handleSave(false)} loading={saving} disabled={!(formData.title ?? '').trim()}>
            Salvar ação
          </Button>
          {!isEditing && (
            <Button variant="secondary" onClick={() => handleSave(true)} disabled={!(formData.title ?? '').trim()}>
              Salvar como rascunho
            </Button>
          )}
          {isEditing && (
            <>
              <Button variant="outline" onClick={handleDuplicate} disabled={saving}>
                Duplicar
              </Button>
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Excluir
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose} className="ml-auto">
            Cancelar
          </Button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal isOpen={confirmDelete} onClose={() => setConfirmDelete(false)} title="Excluir Ação" size="sm">
        <p className="text-sm text-gray-600">
          Tem certeza que deseja excluir a ação <strong>"{action?.title}"</strong>?
        </p>
        <p className="text-xs text-gray-400 mt-2">
          Esta ação não pode ser desfeita.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancelar</Button>
          <Button
            variant="danger"
            loading={deleting}
            onClick={async () => {
              if (!action) return;
              setDeleting(true);
              const result = await remove(action.id);
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
          >
            Excluir
          </Button>
        </div>
      </Modal>
      {/* Pop-up pós-salvar: Deseja estender a ação? */}
      <Modal
        isOpen={extendOpen}
        onClose={() => { setExtendOpen(false); onClose(); }}
        title="Deseja estender esta ação?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Ação <strong className="text-gray-900">{formData.title || 'salva'}</strong> com status{' '}
            <strong className="text-gray-900">{ACTION_STATUSES[extendStatus]?.label ?? extendStatus}</strong>.
            Deseja replicá-la a partir do dia escolhido?
          </p>

          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={skipWeekends}
              onChange={(e) => setSkipWeekends(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-400"
            />
            Pular fins de semana (só dias úteis)
          </label>

          <div className="grid grid-cols-2 gap-2">
            {(['week', 'month'] as const).map(mode => {
              const p = extendPreview(mode);
              const isWeek = mode === 'week';
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleExtend(mode)}
                  disabled={p.count === 0 || extending}
                  className={`flex flex-col items-center gap-1 p-4 rounded-xl border-2 transition-all ${
                    p.count > 0
                      ? 'border-primary-300 bg-primary-50 hover:border-primary-500 hover:shadow-sm'
                      : 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                  } ${extending ? 'opacity-60 cursor-wait' : ''}`}
                >
                  <CalendarDays className="w-5 h-5 text-primary-600" />
                  <span className="text-sm font-semibold text-gray-900">{isWeek ? 'Semana' : 'Mês'}</span>
                  <span className="text-[11px] text-gray-500 text-center">
                    {p.count > 0 ? `+${p.count} ações · ${p.range}` : 'nada a estender'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex justify-end pt-2">
            <Button variant="ghost" onClick={() => { setExtendOpen(false); onClose(); }} disabled={extending}>
              Não, finalizar
            </Button>
          </div>
        </div>
      </Modal>
    </Drawer>
  );
}
