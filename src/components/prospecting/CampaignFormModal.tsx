import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import Button from '@/components/ui/Button';
import ChipMultiSelect from '@/components/ui/ChipMultiSelect';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { useEnvProducts } from '@/hooks/useEnvProducts';
import { useChannelStatus } from '@/hooks/useProspecting';
import {
  AUTOMATION_LEVELS, AUTOMATION_META, CHANNEL_META, COMPANY_SIZES,
  DISCOVERY_META, DISCOVERY_PROVIDERS,
  PROSPECTING_CHANNELS, type AutomationLevel, type CampaignPayload,
  type CampaignStatus, type ProspectingCampaign, type ProspectingEnvironment,
} from '@/lib/prospecting/types';

export interface CampaignFormValues {
  name: string;
  objective: string;
  offer: string;
  segment: string;
  location: string;
  company_size: string;
  icp_description: string;
  trigger_keywords: string;
  target_count: string;
  channels: string[];
  discovery_provider: 'auto' | 'places' | 'firecrawl';
  automation_level: AutomationLevel;
  assigned_to: string;
  product_ids: string[];
  status: CampaignStatus;
}

const EMPTY: CampaignFormValues = {
  name: '', objective: '', offer: '', segment: '', location: '', company_size: '',
  icp_description: '', trigger_keywords: '', target_count: '100', channels: ['whatsapp'],
  discovery_provider: 'auto', automation_level: 'assisted', assigned_to: '', product_ids: [], status: 'draft',
};

interface CampaignFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  campaign: ProspectingCampaign | null;
  environment: ProspectingEnvironment;
  owners: { value: string; label: string }[];
  submitting: boolean;
  onSubmit: (values: CampaignFormValues) => Promise<void>;
}

/* Disponibilidade real do canal no ambiente (checks do Edge prospecting-status) */
const CHANNEL_READY: Record<string, (ch: ReturnType<typeof useChannelStatus>) => boolean> = {
  whatsapp:  ch => ch.n8n,
  instagram: ch => ch.meta,
  email:     ch => ch.resend,
};
const CHANNEL_UNREADY_HELP: Record<string, string> = {
  whatsapp:  'Conecte o WhatsApp via n8n (Evolution)',
  instagram: 'Conecte o Instagram no agente',
  email:     'Configure a chave do Resend',
};

export default function CampaignFormModal({
  isOpen, onClose, campaign, environment, owners, submitting, onSubmit,
}: CampaignFormModalProps) {
  const [form, setForm] = useState<CampaignFormValues>(EMPTY);
  const status = useChannelStatus(true);
  const catalogProducts = useEnvProducts(environment);

  useEffect(() => {
    if (!isOpen) return;
    setForm(campaign
      ? {
          name: campaign.name ?? '',
          objective: campaign.objective ?? '',
          offer: campaign.offer ?? '',
          segment: campaign.segment ?? '',
          location: campaign.location ?? '',
          company_size: campaign.company_size ?? '',
          icp_description: campaign.icp_description ?? '',
          trigger_keywords: (campaign.trigger_keywords ?? []).join(', '),
          target_count: String(campaign.target_count ?? 100),
          channels: campaign.channels ?? [],
          discovery_provider: campaign.discovery_provider ?? 'auto',
          automation_level: campaign.automation_level,
          assigned_to: campaign.assigned_to ?? '',
          product_ids: (campaign.products ?? []).map(x => x.product?.id).filter((v): v is string => !!v),
          status: campaign.status,
        }
      : EMPTY);
  }, [isOpen, campaign]);

  const set = (key: keyof CampaignFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.name.trim()) return;
    await onSubmit(form);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={campaign ? 'Editar campanha' : 'Nova campanha de prospecção'}
      size="lg"
    >
      <div className="space-y-4">
        <Input
          label="Nome da campanha *"
          value={form.name}
          onChange={set('name')}
          placeholder="Ex: Distribuidores de alimentos — PE"
        />
        <Input
          label="Objetivo"
          value={form.objective}
          onChange={set('objective')}
          placeholder="Ex: Gerar reuniões com donos de negócio"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Segmento" value={form.segment} onChange={set('segment')} placeholder="Alimentação, serviços..." />
          <Input label="Localização" value={form.location} onChange={set('location')} placeholder="Cidade, estado ou região" />
          <Select
            label="Porte da empresa"
            value={form.company_size}
            onChange={set('company_size')}
            placeholder="Qualquer porte"
            options={COMPANY_SIZES.map(s => ({ value: s, label: s }))}
          />
          <Input
            label="Quantidade desejada"
            type="number"
            min="1"
            max="100000"
            value={form.target_count}
            onChange={set('target_count')}
          />
        </div>

        <Textarea
          label="Público-alvo (ICP)"
          value={form.icp_description}
          onChange={(e) => setForm(f => ({ ...f, icp_description: e.target.value }))}
          placeholder="Descreva o cliente ideal: ex.: distribuidores de alimentos de médio porte em SP que vendem por atacado e já usam delivery próprio."
          rows={3}
        />
        <p className="text-[11px] text-gray-400 -mt-2">O agente usa esta descrição para descobrir empresas e medir o fit de cada lead contra este perfil.</p>

        <Textarea
          label="Oferta / desconto para a conversa (opcional)"
          value={form.offer}
          onChange={(e) => setForm(f => ({ ...f, offer: e.target.value }))}
          placeholder="Ex.: Primeira semana de teste grátis + 10% off no contrato de 12 meses no mês do startup."
          rows={2}
        />
        <p className="text-[11px] text-gray-400 -mt-2">O agente cita esta oferta na conversa e nos rascunhos quando fizer sentido. Sem promessas fora daqui.</p>

        <Input
          label="Palavras-chave de gatilho (separadas por vírgula)"
          value={form.trigger_keywords}
          onChange={(e) => setForm(f => ({ ...f, trigger_keywords: e.target.value }))}
          placeholder="Ex.: quero, orçamento, preço, faturamento, consulta"
        />
        <p className="text-[11px] text-gray-400 -mt-2">Quando um prospect comentar ou mandar DM no Instagram contendo um desses termos, o agente entra automaticamente.</p>

        <ChipMultiSelect
          label="Produtos ofertados"
          options={catalogProducts.map(p => ({ id: p.id, name: p.name }))}
          values={form.product_ids}
          onChange={(ids) => setForm(f => ({ ...f, product_ids: ids }))}
          placeholder="Selecionar produtos do ambiente..."
          emptyMessage="Nenhum produto cadastrado — cadastre na página Produtos"
        />

        {/* Canais dinâmicos: mostra status de conexão e desabilita canal indisponível */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Canais de prospecção</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PROSPECTING_CHANNELS.map(ch => {
              const available = CHANNEL_READY[ch](status);
              const selected = form.channels.includes(ch);
              return (
                <button
                  key={ch}
                  type="button"
                  disabled={!available}
                  title={available ? CHANNEL_META[ch].hint : `${CHANNEL_META[ch].label} indisponível — ${CHANNEL_UNREADY_HELP[ch]}`}
                  onClick={() => setForm(f => ({
                    ...f,
                    channels: selected ? f.channels.filter(c => c !== ch) : [...f.channels, ch],
                  }))}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-3 text-left transition-all',
                    selected && available
                      ? 'border-primary-400 bg-primary-50 ring-1 ring-primary-300'
                      : 'border-gray-200 bg-white hover:border-gray-300',
                    !available && 'opacity-45 cursor-not-allowed hover:border-gray-200',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                      selected && available ? 'border-primary-500 bg-primary-500' : 'border-gray-300 bg-white',
                    )}
                  >
                    {selected && available && <Check className="w-2.5 h-2.5 text-white" />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                      {CHANNEL_META[ch].label}
                      <span className={cn('w-1.5 h-1.5 rounded-full', available ? 'bg-emerald-500' : 'bg-gray-300')} />
                    </span>
                    <span className="text-[11px] text-gray-500 line-clamp-2">
                      {available ? CHANNEL_META[ch].hint : CHANNEL_UNREADY_HELP[ch]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">Verde = conectado neste ambiente. O agente escolhe o canal do lead: WhatsApp usa telefone, Instagram usa @, e-mail usa contact_email.</p>
        </div>

        <Select
          label="Fonte de descoberta de leads"
          value={form.discovery_provider}
          onChange={(e) => setForm(f => ({ ...f, discovery_provider: e.target.value as 'auto' | 'places' | 'firecrawl' }))}
          options={DISCOVERY_PROVIDERS.map(p => ({ value: p, label: DISCOVERY_META[p].label }))}
        />
        <p className="text-[11px] text-gray-400 -mt-2">
          {`${DISCOVERY_META[form.discovery_provider].hint}${
            form.discovery_provider === 'firecrawl' && !status.firecrawl ? ' — Firecrawl ainda não configurado (mande a API key)' : ''
          }`}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Select
              label="Nível de automação"
              value={form.automation_level}
              onChange={(e) => setForm(f => ({ ...f, automation_level: e.target.value as AutomationLevel }))}
              options={AUTOMATION_LEVELS.map(a => ({ value: a, label: AUTOMATION_META[a].label }))}
            />
            <p className="text-[11px] text-gray-400 mt-1">
              <strong>Assisted:</strong> você aprova cada envio · <strong>Semi-auto:</strong> aprova o 1º, o resto segue · <strong>Auto:</strong> dispara sozinho (ritmo controlado)
            </p>
          </div>
          <Select
            label="Responsável"
            value={form.assigned_to}
            onChange={set('assigned_to')}
            placeholder="Sem responsável"
            options={owners}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button
          onClick={handleSubmit}
          loading={submitting}
          disabled={!form.name.trim() || form.channels.length === 0}
        >
          {campaign ? 'Salvar' : 'Criar campanha'}
        </Button>
      </div>
    </Modal>
  );
}

export function payloadFromValues(values: CampaignFormValues, environment: ProspectingEnvironment): CampaignPayload {
  return {
    name: values.name.trim(),
    objective: values.objective.trim() || null,
    offer: values.offer.trim() || null,
    segment: values.segment.trim() || null,
    location: values.location.trim() || null,
    company_size: values.company_size || null,
    icp_description: values.icp_description.trim() || null,
    trigger_keywords: (values.trigger_keywords || '')
      .split(/[,;\n]/)
      .map(s => s.trim())
      .filter(Boolean),
    target_count: Math.max(1, Math.min(100000, parseInt(values.target_count, 10) || 100)),
    channels: values.channels,
    discovery_provider: values.discovery_provider,
    automation_level: values.automation_level,
    assigned_to: values.assigned_to || null,
    product_ids: values.product_ids,
    status: values.status,
  };
}
