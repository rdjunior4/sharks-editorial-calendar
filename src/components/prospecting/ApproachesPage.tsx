import { useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import Select from '@/components/ui/Select';
import EmptyState from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { Search, Radio } from 'lucide-react';
import { useApproaches, type ApproachFeedItem, type ProspectingEnvironment } from '@/hooks/useProspecting';
import { formatRelativeTime } from '@/lib/crmStages';
import ProvisionedAudio from '@/components/ui/ProvisionedAudio';

type ApproachStatus = 'outreach_draft' | 'outreach_sent' | 'reply_received';

const STATUS_META: Record<ApproachStatus, { label: string; badgeClass: string; icon: string }> = {
  outreach_draft:  { label: 'Rascunho', badgeClass: 'bg-amber-100 text-amber-700', icon: '✏️' },
  outreach_sent:   { label: 'Enviada', badgeClass: 'bg-emerald-100 text-emerald-700', icon: '📤' },
  reply_received:  { label: 'Resposta', badgeClass: 'bg-sky-100 text-sky-700', icon: '📥' },
};

const STATUS_OPTIONS = [
  { value: 'outreach_draft', label: 'Rascunho' },
  { value: 'outreach_sent', label: 'Enviada' },
  { value: 'reply_received', label: 'Resposta' },
];

interface ApproachesPageProps {
  environment: ProspectingEnvironment;
}

export default function ApproachesSection({ environment }: ApproachesPageProps) {
  const items = useApproaches(environment);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter(i => {
      if (statusFilter && i.type !== statusFilter) return false;
      if (!term) return true;
      return (i.lead?.name ?? '').toLowerCase().includes(term) || i.content.toLowerCase().includes(term);
    });
  }, [items, statusFilter, search]);

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por lead ou conteúdo..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:border-primary-500 placeholder:text-gray-400"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            placeholder="Todos os status"
            options={STATUS_OPTIONS}
          />
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
          <Radio className="w-3.5 h-3.5 animate-pulse" />
          Tempo real
        </span>
      </div>

      {/* Feed */}
      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <Card padding="md" className="w-full max-w-md">
            <EmptyState
              icon={Radio}
              title="Nenhuma abordagem ainda"
              description="Quando o agente gerar rascunhos, enviar mensagens ou receber respostas, tudo aparece aqui em tempo real."
            />
          </Card>
        </div>
      ) : filtered.length === 0 ? (
        <Card padding="md">
          <p className="text-sm text-gray-500 text-center py-6">Nenhuma abordagem para o filtro atual.</p>
        </Card>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pb-2">
          {filtered.map(item => {
            const status = STATUS_META[item.type];
            const isOpen = expanded === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setExpanded(isOpen ? null : item.id)}
                className={cn(
                  'w-full text-left bg-white border rounded-lg p-3.5 transition-all',
                  isOpen ? 'border-primary-300 ring-1 ring-primary-200' : 'border-gray-200 hover:border-gray-300 hover:shadow-sm',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-900 truncate">{item.lead?.name ?? 'Lead'}</p>
                      <span className={cn('px-2 py-0.5 rounded-full text-[11px] font-medium', status.badgeClass)}>
                        {status.icon} {status.label}
                      </span>
                    </div>
                    <p className={cn('text-xs text-gray-600 mt-1 whitespace-pre-wrap', !isOpen && 'line-clamp-2')}>
                      {item.content}
                    </p>
                  </div>
                  <span className="text-[11px] text-gray-400 shrink-0 mt-0.5">
                    {formatRelativeTime(item.created_at)}
                  </span>
                </div>
                {isOpen && (item.metadata?.audio_path || item.metadata?.audio_url) && (
                  <div className="mt-2 pt-2 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
                    <p className="text-[11px] text-gray-400 mb-1.5">🎙️ Resposta em áudio gerada pelo agente:</p>
                    <ProvisionedAudio path={item.metadata?.audio_path ?? null} url={item.metadata?.audio_url ?? null} className="w-full h-9" />
                  </div>
                )}
                {isOpen && item.lead?.social_instagram && (
                  <p className="text-[11px] text-gray-400 mt-2 pt-2 border-t border-gray-100">
                    Instagram: @{item.lead.social_instagram.replace(/^@/, '')} (abordagem manual no app)
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
