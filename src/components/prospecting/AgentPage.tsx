import { useState, useEffect } from 'react';
import Card, { CardHeader, CardTitle } from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import EmptyState from '@/components/ui/EmptyState';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { IG_CONNECT_EDGE } from '@/lib/prospecting/instagram';
import {
  Search, FileSearch, Target, Send, MessageSquare, CalendarCheck,
  Radar, Loader2, Bot, ShieldCheck, Cpu, Clock, Settings, Save,
} from 'lucide-react';
import {
  useProspectingJobs, useAgentSettings, useChannelStatus, useInstagramConnection, type AgentSettings,
} from '@/hooks/useProspecting';
import { buildInstagramOAuthUrl } from '@/lib/prospecting/instagram';
import { JOB_TYPE_META, JOB_STATUS_META, type JobStatus, type ProspectingEnvironment } from '@/lib/prospecting/types';
import type { LucideIcon } from 'lucide-react';

interface AgentPageProps {
  environment: ProspectingEnvironment;
  editable?: boolean;
}

/* Pipeline do agente — a ordem do fluxo §39 do plano */
const FLOW_STEPS: Array<{ icon: LucideIcon; label: string; phase: string }> = [
  { icon: Search, label: 'Discovery', phase: 'F2' },
  { icon: FileSearch, label: 'Pesquisa', phase: 'F2' },
  { icon: Target, label: 'Qualificação', phase: 'F3' },
  { icon: Send, label: 'Abordagem', phase: 'F4' },
  { icon: MessageSquare, label: 'Resposta', phase: 'F4' },
  { icon: CalendarCheck, label: 'Agendamento', phase: 'F5' },
];

const AGENTS: Array<{ icon: LucideIcon; name: string; description: string; phase: string }> = [
  { icon: Search,       name: 'Discovery Agent',      description: 'Encontra empresas que casam com o ICP da campanha.', phase: 'F2' },
  { icon: FileSearch,   name: 'Research Agent',       description: 'Pesquisa e enriquece dados das empresas descobertas.', phase: 'F2' },
  { icon: Target,       name: 'Qualification Agent',  description: 'Score de oportunidade e recomendação de produtos.', phase: 'F3' },
  { icon: Send,         name: 'Outreach Agent',       description: 'Gera mensagens personalizadas para revisão.', phase: 'F4' },
  { icon: MessageSquare, name: 'Conversation Agent',  description: 'Interpreta respostas e atualiza o CRM.', phase: 'F4' },
  { icon: CalendarCheck, name: 'Scheduling Agent',    description: 'Agenda reuniões usando a agenda existente.', phase: 'F5' },
];

const JOB_STATUS_ICON: Record<JobStatus, LucideIcon> = {
  pending: Clock,
  processing: Cpu,
  completed: ShieldCheck,
  failed: Bot,
  retry: Clock,
};

export default function AgentSection({ environment, editable = false }: AgentPageProps) {
  const jobs = useProspectingJobs(environment);
  const ig = useInstagramConnection(environment);
  const { user } = useAuth();
  const channels = useChannelStatus(true);
  const channelItems = [
    { key: 'meta' as const, label: 'Meta (Lead Ads/Interações)' },
    { key: 'google_places' as const, label: 'Google Places (Discovery)' },
    { key: 'firecrawl' as const, label: 'Firecrawl (busca web)' },
    { key: 'n8n' as const, label: 'n8n (Orquestração)' },
    { key: 'resend' as const, label: 'Resend (e-mail)' },
    { key: 'decision_ai' as const, label: 'JEV — decisão' },
    { key: 'generative_ai' as const, label: 'GLM — geração' },
    { key: 'speech' as const, label: 'Voz (ElevenLabs — áudio)' },
  ];
  const activeChannels = channelItems.filter(c => channels[c.key]).length;
  const { settings, loading: settingsLoading, saveSettings } = useAgentSettings(environment);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<AgentSettings | null>(null);

  useEffect(() => {
    if (!settingsLoading) setSettingsForm(settings);
  }, [settings, settingsLoading]);

  const setP = (key: keyof AgentSettings['params'], value: string | number) =>
    setSettingsForm(f => (f ? { ...f, params: { ...f.params, [key]: typeof value === 'number' ? value : Number(value) } } : f));
  const setPer = (key: keyof AgentSettings['personality'], value: string) =>
    setSettingsForm(f => (f ? { ...f, personality: { ...f.personality, [key]: value } } : f));
  const setVoice = (key: keyof AgentSettings['personality']['voice'], value: string) =>
    setSettingsForm(f => (f ? {
      ...f,
      personality: { ...f.personality, voice: { ...f.personality.voice, [key]: value } as AgentSettings['personality']['voice'] },
    } : f));

  const [igDisconnecting, setIgDisconnecting] = useState(false);

  /* ── WhatsApp Cloud (oficial) ── */
  const WA_CONNECT_EDGE = 'https://cyumczehpiiarwqrpgnu.supabase.co/functions/v1/whatsapp-connect';
  interface WAConnMeta { phone_number_id: string; display_phone: string | null; cold_template: string | null; waba_id?: string | null }
  const [wa, setWa] = useState<{ connection: WAConnMeta | null }>({ connection: null });
  const [waModalOpen, setWaModalOpen] = useState(false);
  const [waDisconnecting, setWaDisconnecting] = useState(false);
  const [waForm, setWaForm] = useState({ access_token: '', phone_number_id: '', cold_template: '', cold_template_lang: 'pt_BR' });
  const [waSaving, setWaSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const res = await fetch(WA_CONNECT_EDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'status', environment }),
      });
      if (!res.ok) return;
      const body = (await res.json().catch(() => ({}))) as { connection?: WAConnMeta | null };
      setWa({ connection: body.connection ?? null });
    })();
  }, [environment]);

  const handleConnectWhatsApp = async () => {
    if (!waForm.phone_number_id.trim() || !waForm.access_token.trim()) return;
    setWaSaving(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sessão expirada');
      const res = await fetch(WA_CONNECT_EDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'connect',
          environment,
          access_token: waForm.access_token.trim(),
          phone_number_id: waForm.phone_number_id.replace(/\D/g, ''),
          cold_template: waForm.cold_template.trim() || undefined,
          cold_template_lang: waForm.cold_template_lang || 'pt_BR',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; display_phone?: string | null; phone_number_id?: string; cold_template?: string | null };
      if (!res.ok) throw new Error(body.error ?? `Falha (${res.status})`);
      toast.success(`WhatsApp oficial conectado: ${body.display_phone ?? body.phone_number_id}`);
      setWa({ connection: { phone_number_id: body.phone_number_id ?? waForm.phone_number_id, display_phone: body.display_phone ?? null, cold_template: body.cold_template ?? null } });
      setWaModalOpen(false);
      setWaForm(f => ({ ...f, access_token: '' }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao conectar');
    } finally {
      setWaSaving(false);
    }
  };

  const handleDisconnectWhatsApp = async () => {
    setWaDisconnecting(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sessão expirada');
      const res = await fetch(WA_CONNECT_EDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'disconnect', environment }),
      });
      if (!res.ok) throw new Error('Falha ao desconectar');
      toast.success('WhatsApp oficial desconectado');
      setWa({ connection: null });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setWaDisconnecting(false);
    }
  };

  const handleDisconnectInstagram = async () => {
    setIgDisconnecting(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sessão expirada');
      const res = await fetch(IG_CONNECT_EDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'disconnect', environment }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Falha (${res.status})`);
      toast.success('Instagram desconectado');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao desconectar');
    } finally {
      setIgDisconnecting(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsForm) return;
    setSavingSettings(true);
    try {
      await saveSettings(settingsForm, user?.id ?? null);
      toast.success('Personalidade e parâmetros salvos! Valem para as próximas execuções.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar configurações');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4 overflow-y-auto pb-2">

      {/* Status do motor */}
      <Card padding="md" className="flex flex-wrap items-center gap-4">
        <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
          <Radar className="w-5 h-5 text-primary-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">Motor de prospecção — fundação ativa</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Estrutura de dados, fila e permissões operando. A execução automática (discovery, IA e abordagem)
            é ativada nas próximas fases, respeitando o nível de automação de cada campanha.
          </p>
        </div>
        <Badge variant="info" size="sm">Modo: fundação</Badge>
      </Card>

      {/* Pipeline do agente */}
      <Card padding="md">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Fluxo do agente</h3>
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {FLOW_STEPS.map((step, i) => (
            <div key={step.label} className="flex items-center gap-2 shrink-0">
              <div className="flex flex-col items-center gap-1 min-w-[86px]">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center">
                  <step.icon className="w-4 h-4 text-gray-500" />
                </div>
                <span className="text-[11px] font-medium text-gray-600">{step.label}</span>
                <Badge variant="default" size="sm">{step.phase}</Badge>
              </div>
              {i < FLOW_STEPS.length - 1 && <span className="w-6 h-px bg-gray-200 mb-5" />}
            </div>
          ))}
        </div>
      </Card>

      {/* Agentes especializados */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {AGENTS.map(agent => (
          <Card key={agent.name} padding="md" className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
              <agent.icon className="w-5 h-5 text-primary-600" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-gray-900 truncate">{agent.name}</p>
                <Badge variant="default" size="sm">{agent.phase}</Badge>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{agent.description}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Garantias */}
      <Card padding="md">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Garantias de operação</h3>
        <ul className="text-xs text-gray-500 space-y-1">
          <li>· Toda ação do agente é registrada na timeline do lead no CRM.</li>
          <li>· Nenhuma abordagem real é executada sem revisão no nível <strong>Assistido</strong>.</li>
          <li>· Campanhas Sharks e Estrategos são isoladas por ambiente (RLS).</li>
          <li>· Integrações externas (e-mail, WhatsApp) passam obrigatoriamente pela validação do backend.</li>
        </ul>
      </Card>

      {/* Canais de integração */}
      <Card padding="md">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Canais de integração</h3>
          <span className="text-[11px] text-gray-400">{activeChannels}/{channelItems.length} ativos</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-2">
          {channelItems.map(c => (
            <div key={c.key} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 border border-gray-100">
              <span className={cn('w-2 h-2 rounded-full shrink-0', channels[c.key] ? 'bg-emerald-500' : 'bg-gray-300')} />
              <span className={cn('text-xs truncate', channels[c.key] ? 'text-gray-700 font-medium' : 'text-gray-400')}>{c.label}</span>
            </div>
          ))}
        </div>

        {/* Instagram do ambiente — conectar/desconectar in-app */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          {ig.connection ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700">
                📷 Instagram conectado: @{ig.connection.username ?? ig.connection.ig_user_id}
              </span>
              {editable && (
                <Button size="sm" variant="ghost" loading={igDisconnecting} onClick={handleDisconnectInstagram}>
                  Desconectar
                </Button>
              )}
            </>
          ) : (
            editable && (
              <Button
                size="sm"
                onClick={() => { window.location.href = buildInstagramOAuthUrl(environment); }}
              >
                📷 Conectar Instagram
              </Button>
            )
          )}
          <p className="text-[11px] text-gray-400">
            {ig.connection
              ? `Página: ${ig.connection.page_name ?? '—'} · comentários, DMs e Lead Ads entram no CRM automaticamente.`
              : 'Conta IG profissional dedicada com Página do Facebook vinculada.'}
          </p>
        </div>

          {/* ── WhatsApp oficial (Cloud API) ── */}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            {wa.connection ? (
              <>
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700">
                  ✅ WhatsApp oficial conectado: {wa.connection.display_phone ?? wa.connection.phone_number_id}
                </span>
                {editable && (
                  <>
                    <Button size="sm" onClick={() => setWaModalOpen(true)}>Atualizar</Button>
                    <Button size="sm" variant="ghost" loading={waDisconnecting} onClick={handleDisconnectWhatsApp}>Desconectar</Button>
                  </>
                )}
              </>
            ) : (
              editable && <Button size="sm" onClick={() => setWaModalOpen(true)}>✅ Conectar WhatsApp oficial (Cloud API)</Button>
            )}
            <p className="text-[11px] text-gray-400">
              {wa.connection
                ? `Template frio: ${wa.connection.cold_template ?? '— (configure para disparo fora da janela 24h)'}`
                : 'API oficial da Meta: respostas na janela 24h grátis; frio exige template aprovado.'}
            </p>
          </div>
      </Card>

      {/* Mensaje modal WhatsApp oficial */}
      <Modal isOpen={waModalOpen} onClose={() => setWaModalOpen(false)} title="WhatsApp oficial — Cloud API (Meta)" size="md">
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Pegue no painel Meta for Developers (app WhatsApp Business): <strong>Phone Number ID</strong> e um
            <strong> Access Token permanente</strong> (System User). Respostas na janela de 24h não têm preço em tráfego; para disparo frio, crie um
            template aprovado e preencha o nome.
          </p>
          <Input
            label="Phone Number ID *"
            value={waForm.phone_number_id}
            onChange={(e) => setWaForm(f => ({ ...f, phone_number_id: e.target.value }))}
            placeholder="ex.: 123456789012345"
          />
          <Input
            label="Access Token (System User) *"
            type="password"
            value={waForm.access_token}
            onChange={(e) => setWaForm(f => ({ ...f, access_token: e.target.value }))}
            placeholder="EAAG..."
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input
              label="Template frio (nome aprovado)"
              value={waForm.cold_template}
              onChange={(e) => setWaForm(f => ({ ...f, cold_template: e.target.value }))}
              placeholder="ex.: first_contact_v1"
              className="sm:col-span-2"
            />
            <Select
              label="Idioma"
              value={waForm.cold_template_lang}
              onChange={(e) => setWaForm(f => ({ ...f, cold_template_lang: e.target.value }))}
              options={[
                { value: 'pt_BR', label: 'pt_BR' },
                { value: 'en_US', label: 'en_US' },
                { value: 'es', label: 'es' },
              ]}
            />
          </div>
          <p className="text-[11px] text-gray-400">O token fica em tabela de serviço, nunca sai pelo REST para usuários (padrão da conexão IG).</p>
        </div>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setWaModalOpen(false)}>Cancelar</Button>
          <Button onClick={handleConnectWhatsApp} loading={waSaving} disabled={!waForm.access_token.trim() || !waForm.phone_number_id.trim()}>
            Conectar
          </Button>
        </div>
      </Modal>

      {/* Personalidade & Parâmetros */}
      <Card padding="md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center">
              <Settings className="w-4 h-4" />
            </span>
            Personalidade & Parâmetros
          </CardTitle>
          {!editable && <span className="text-[11px] text-gray-400">Somente admin edita</span>}
        </CardHeader>
        {settingsForm && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Input label="Nome do agente" value={settingsForm.personality.agent_name} onChange={(e) => setPer('agent_name', e.target.value)} disabled={!editable} />
              <Select
                label="Tom de voz"
                value={settingsForm.personality.tone}
                onChange={(e) => setPer('tone', e.target.value)}
                options={[
                  { value: 'amigavel', label: 'Amigável' },
                  { value: 'formal', label: 'Formal' },
                  { value: 'direto', label: 'Direto' },
                ]}
                disabled={!editable}
              />
              <Input
                label="Assinatura"
                value={settingsForm.personality.signature}
                onChange={(e) => setPer('signature', e.target.value)}
                disabled={!editable}
              />
            </div>
            <Textarea
              label="Persona (como o agente se apresenta)"
              value={settingsForm.personality.persona}
              onChange={(e) => setPer('persona', e.target.value)}
              placeholder="Ex.: Consultora comercial prática, focada em resultado do cliente..."
              rows={2}
              disabled={!editable}
            />
            <Textarea
              label="Regras de voz (o que o agente pode/não pode dizer)"
              value={settingsForm.personality.brand_voice_rules}
              onChange={(e) => setPer('brand_voice_rules', e.target.value)}
              placeholder="Ex.: nunca prometer resultado garantido; frases curtas; 1 pergunta por mensagem..."
              rows={2}
              disabled={!editable}
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Select
                label="Resposta do agente"
                value={settingsForm.personality.voice.mode}
                onChange={(e) => setVoice('mode', e.target.value)}
                options={[
                  { value: 'text', label: 'Texto' },
                  { value: 'audio', label: 'Áudio' },
                  { value: 'both', label: 'Texto + áudio' },
                ]}
                disabled={!editable}
              />
              <Input
                label="Voz (ElevenLabs voice ID)"
                value={settingsForm.personality.voice.voice_id}
                onChange={(e) => setVoice('voice_id', e.target.value)}
                placeholder="Em branco = voz padrão pt-BR"
                disabled={!editable}
              />
              <div className="flex items-end pb-1">
                <p className="text-[11px] text-gray-400 leading-snug">
                  Áudio exige <code>ELEVENLABS_API_KEY</code> no Edge. Sem a chave, o agente responde apenas em texto.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Input
                label="Rascunho auto (fit ≥)"
                type="number" min="0" max="1" step="0.05"
                value={settingsForm.params.fit_draft_threshold}
                onChange={(e) => setP('fit_draft_threshold', e.target.value)}
                disabled={!editable}
              />
              <Input
                label="Descartar (fit <)"
                type="number" min="0" max="1" step="0.05"
                value={settingsForm.params.fit_discard_threshold}
                onChange={(e) => setP('fit_discard_threshold', e.target.value)}
                disabled={!editable}
              />
              <Input
                label="Confiança p/ agir"
                type="number" min="0" max="1" step="0.05"
                value={settingsForm.params.confidence_auto}
                onChange={(e) => setP('confidence_auto', e.target.value)}
                disabled={!editable}
              />
              <Input
                label="Empresas/execução"
                type="number" min="1" max="20"
                value={settingsForm.params.max_companies_per_run}
                onChange={(e) => setP('max_companies_per_run', e.target.value)}
                disabled={!editable}
              />
            </div>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[11px] text-gray-400">
                Valores valem para as próximas execuções do agente neste ambiente.
              </p>
              {editable && (
                <Button size="sm" onClick={handleSaveSettings} loading={savingSettings}>
                  <Save className="w-3.5 h-3.5" />
                  Salvar configurações
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Atividade recente (jobs) */}
      <Card padding="md">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Atividade recente</h3>
          <span className="text-xs text-gray-400">{jobs.length} job{jobs.length === 1 ? '' : 's'}</span>
        </div>
        {jobs.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="Nenhuma execução ainda"
            description="O agente começa a registrar atividades quando a primeira campanha entrar em execução (F2)."
          />
        ) : (
          <div className="space-y-2">
            {jobs.map(job => {
              const status = JOB_STATUS_META[job.status];
              const StatusIcon = JOB_STATUS_ICON[job.status];
              return (
                <div key={job.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50">
                  <StatusIcon className="w-4 h-4 text-gray-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 truncate">
                      {JOB_TYPE_META[job.type].label}
                      {job.campaign?.name && <span className="text-gray-400"> · {job.campaign.name}</span>}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {new Date(job.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                      {job.attempts > 1 && ` · tentativa ${job.attempts}`}
                    </p>
                  </div>
                  <span className={cn('px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0', status.badgeClass)}>
                    {status.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
