import { Building2, Bot } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import Avatar from '@/components/ui/Avatar';
import { formatBRL, formatRelativeTime } from '@/lib/crmStages';
import type { CrmClient, Lead } from '@/hooks/useLeads';
import { ENVIRONMENT_META } from '@/types';

interface ClientsTabProps {
  leads: Lead[];
  agendaClients: CrmClient[];
  showEnv?: boolean;
  onOpenLead: (lead: Lead) => void;
}

export default function ClientsTab({ leads, agendaClients, showEnv, onOpenLead }: ClientsTabProps) {
  const converted = leads.filter(l => l.stage === 'won' && l.workspace_id && l.workspace);
  const totalMonthly = converted.reduce((acc, l) => acc + (Number(l.monthly_value) || 0), 0);
  const totalWon = converted.reduce((acc, l) => acc + (Number(l.value) || 0), 0);

  if (agendaClients.length === 0 && converted.length === 0) {
    return (
      <div className="py-10">
        <div className="w-full max-w-md">
          <EmptyState
            icon={Building2}
            title="Nenhum cliente ainda"
            description="Os clientes cadastrados na agenda e os leads convertidos aparecem aqui."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {/* Resumo */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="text-gray-500">
          <strong className="text-gray-900">{agendaClients.length}</strong>{' '}
          {agendaClients.length === 1 ? 'cliente' : 'clientes'} da agenda
        </span>
        <span className="text-gray-500">
          Contratos via CRM: <strong className="text-gray-900 tabular-nums">{formatBRL(totalWon)}</strong>
        </span>
        <span className="text-gray-500">
          Recorrência mensal: <strong className="text-emerald-600 tabular-nums">{formatBRL(totalMonthly)}</strong>
        </span>
      </div>

      {/* Todos os clientes da agenda */}
      <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 content-start p-1">
        {agendaClients.map(c => (
          <div key={`agenda-${c.id}`} className="bg-white border border-emerald-100 rounded-lg p-3">
            <div className="flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                <Building2 className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 truncate">{c.name}</p>
                <p className="text-xs text-gray-400 truncate">
                  {c.segment ?? 'cliente'}
                  {c.environment && ` · ${ENVIRONMENT_META[c.environment as keyof typeof ENVIRONMENT_META]?.emoji ?? ''}`}
                </p>
              </div>
            </div>
            <p className="text-[11px] font-medium text-emerald-600 mt-2">✓ ativo na agenda</p>
          </div>
        ))}

        {/* Leads convertidos (via CRM) */}
        {converted.map(lead => (
          <button
            key={lead.id}
            onClick={() => onOpenLead(lead)}
            className="bg-white border border-gray-200 rounded-lg p-3 text-left transition-all hover:border-gray-300 hover:shadow-md"
          >
            <div className="flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                <Building2 className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {lead.origin === 'prospecting_agent' && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-1 py-0.5 rounded shrink-0" title="Lead captado pelo Agente de Prospecção IA">
                      <Bot className="w-2.5 h-2.5" /> IA
                    </span>
                  )}
                  <p className="text-sm font-semibold text-gray-900 truncate">{lead.workspace?.name}</p>
                </div>
                <p className="text-xs text-gray-400 truncate">
                  lead: {lead.name}
                  {showEnv && ` · ${ENVIRONMENT_META[lead.environment].emoji}`}
                </p>
              </div>
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-2 min-w-0">
              <span className="flex items-center gap-1.5 min-w-0 text-xs text-gray-500">
                {lead.owner ? (
                  <Avatar name={lead.owner.full_name} src={lead.owner.avatar_url} size="xs" />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-gray-100 shrink-0" />
                )}
                <span className="truncate">{lead.owner?.full_name ?? 'Sem responsável'}</span>
              </span>
              {lead.value != null && (
                <span className="text-sm font-semibold text-gray-800 tabular-nums shrink-0">
                  {formatBRL(lead.value)}
                </span>
              )}
            </div>

            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-gray-400">
                atualizado {formatRelativeTime(lead.updated_at)}
              </span>
              {lead.monthly_value != null && (
                <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-full shrink-0">
                  {formatBRL(lead.monthly_value)}/mês
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
