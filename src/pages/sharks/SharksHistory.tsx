import PageHeader from '@/components/ui/PageHeader';
import { localDate } from '@/lib/localDate';
import { useMemo, useState } from 'react';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useActions } from '@/hooks/useActions';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import StatusBadge from '@/components/actions/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import { ACTION_STATUSES, CONTENT_FORMATS, OBJECTIVES } from '@/lib/constants';
import { formatDate, formatTime } from '@/lib/utils';
import { History as HistoryIcon, Search } from 'lucide-react';

export default function SharksHistory() {
  const { workspacesByEnv, currentWorkspace } = useWorkspace();
  const workspaces = workspacesByEnv('sharks_company');
  const { actions } = useActions({});

  const [filters, setFilters] = useState({
    workspaceId: currentWorkspace?.id || '',
    search: '',
    status: '',
    format: '',
    startDate: '',
    endDate: '',
  });

  const filtered = useMemo(() => {
    return actions
      .filter(a => {
        if (filters.workspaceId && a.workspace_id !== filters.workspaceId) return false;
        if (filters.status && a.status !== filters.status) return false;
        if (filters.format && a.format !== filters.format) return false;
        if (filters.startDate && a.action_date < filters.startDate) return false;
        if (filters.endDate && a.action_date > filters.endDate) return false;
        if (filters.search && !a.title.toLowerCase().includes(filters.search.toLowerCase())) return false;
        // Only show past or published actions in history
        const isPastOrDone = ['published', 'completed', 'cancelled'].includes(a.status) || a.action_date <= localDate();
        return isPastOrDone;
      })
      .sort((a, b) => b.action_date.localeCompare(a.action_date));
  }, [actions, filters]);

  return (
    <div className="space-y-4">
      <PageHeader title="Histórico" subtitle="Consulte todas as ações passadas" />

      {/* Filters */}
      <Card padding="sm">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Input
            placeholder="Buscar..."
            value={filters.search}
            onChange={(e) => setFilters(p => ({ ...p, search: e.target.value }))}
            className="col-span-2"
          />
          <Select
            placeholder="Cliente"
            value={filters.workspaceId}
            onChange={(e) => setFilters(p => ({ ...p, workspaceId: e.target.value }))}
            options={workspaces.map(w => ({ value: w.id, label: w.name }))}
          />
          <Select
            placeholder="Status"
            value={filters.status}
            onChange={(e) => setFilters(p => ({ ...p, status: e.target.value }))}
            options={Object.entries(ACTION_STATUSES).map(([v, s]) => ({ value: v, label: s.label }))}
          />
          <Select
            placeholder="Formato"
            value={filters.format}
            onChange={(e) => setFilters(p => ({ ...p, format: e.target.value }))}
            options={Object.entries(CONTENT_FORMATS).map(([v, l]) => ({ value: v, label: l }))}
          />
          <Input
            type="month"
            value={filters.startDate ? filters.startDate.slice(0, 7) : ''}
            onChange={(e) => {
              if (e.target.value) {
                setFilters(p => ({
                  ...p,
                  startDate: `${e.target.value}-01`,
                  endDate: localDate(new Date(Number(e.target.value.split('-')[0]), Number(e.target.value.split('-')[1]), 0)),
                }));
              }
            }}
          />
        </div>
      </Card>

      {/* Results */}
      {filtered.length === 0 ? (
        <Card>
          <EmptyState icon={HistoryIcon} title="Nenhuma ação encontrada" description="Ajuste os filtros ou aguarde novas publicações." />
        </Card>
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Data</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Conteúdo</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Formato</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Cliente</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Responsável</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(action => {
                  const ws = workspaces.find(w => w.id === action.workspace_id);
                  return (
                    <tr key={action.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-2.5 text-sm text-gray-500 whitespace-nowrap">
                        {formatDate(action.action_date)}
                        {action.action_time && (
                          <span className="text-xs text-gray-400 ml-1">{formatTime(action.action_time)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-sm font-medium text-gray-900 max-w-[300px] truncate">
                        {action.title}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-500 hidden md:table-cell">
                        {action.format ? CONTENT_FORMATS[action.format] : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-500 hidden lg:table-cell">{ws?.name}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={action.status} size="sm" />
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-500 hidden lg:table-cell">—</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-gray-100 text-xs text-gray-400">
            {filtered.length} ação(ões) encontrada(s)
          </div>
        </Card>
      )}
    </div>
  );
}
