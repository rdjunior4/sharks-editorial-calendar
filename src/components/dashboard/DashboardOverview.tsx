import PageHeader from '@/components/ui/PageHeader';
import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useActions, useOverdueActions } from '@/hooks/useActions';
import StatsCard from '@/components/dashboard/StatsCard';
import MiniCalendar from '@/components/dashboard/MiniCalendar';
import MonthSummaryCard from '@/components/dashboard/MonthSummaryCard';
import StatusBadge from '@/components/actions/StatusBadge';
import Card, { CardHeader, CardTitle } from '@/components/ui/Card';
import WorkspaceLogo from '@/components/ui/WorkspaceLogo';
import { formatDate } from '@/lib/utils';
import { formatCalendarDate, startOfWeek, endOfWeek, parseISO, format, ptBR } from '@/lib/dateUtils';
import { supabase } from '@/lib/supabase';
import { type Campaign, type StrategicDate, type EnvironmentType } from '@/types';
import {
  CalendarDays,
  ArrowRight,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

// ==========================================
// DASHBOARD OVERVIEW
// Fonte única para o "Visão Geral" dos ambientes
// Sharks e Estrategos (diferenças via props).
// ==========================================

type OverdueKey = 'activeClients' | 'actionsThisWeek' | 'scheduled' | 'pending' | 'overdue';

function formatActionDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const d = parseISO(dateStr + 'T00:00:00');
  return isNaN(d.getTime()) ? '—' : format(d, 'dd/MM', { locale: ptBR });
}

interface StatDef {
  icon: LucideIcon;
  label: string;
  key: OverdueKey;
  iconBg?: string;
  onClick?: () => void;
}

interface DashboardOverviewProps {
  env: 'sharks_company' | 'estrategos';
  title: string;
  subtitle: string;
  calendarPath: string;
  stats: StatDef[];
  /** Seção "Clientes/workspaces" (apenas Sharks hoje) */
  showClientsSection?: boolean;
  /** Renderiza "Próximos 7 dias" como lista vertical (Sharks) ou grid (Estrategos) */
  next7Variant?: 'list' | 'grid';
}

export default function DashboardOverview({
  env,
  title,
  subtitle,
  calendarPath,
  stats,
  showClientsSection = false,
  next7Variant = 'list',
}: DashboardOverviewProps) {
  const navigate = useNavigate();
  const { workspacesByEnv } = useWorkspace();
  const workspaces = workspacesByEnv(env);

  const allActions = useActions({ environment: env });
  const overdueAll = useOverdueActions();
  const overdue = useMemo(() => overdueAll.filter(a => a.environment === env), [overdueAll, env]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [strategicDates, setStrategicDates] = useState<StrategicDate[]>([]);

  useEffect(() => {
    Promise.all([
      supabase.from('campaigns').select('*'),
      supabase.from('strategic_dates').select('*'),
    ]).then(([cp, sd]) => {
      setCampaigns((cp.data as unknown as Campaign[]) ?? []);
      setStrategicDates((sd.data as unknown as StrategicDate[]) ?? []);
    });
  }, []);

  // Filtra campanhas e datas estratégicas pelos workspaces do ambiente
  const envWsIds = useMemo(() => new Set(workspaces.map(w => w.id)), [workspaces]);
  const envCampaigns = useMemo(
    () => campaigns.filter(c => !c.workspace_id || envWsIds.has(c.workspace_id)),
    [campaigns, envWsIds],
  );
  const envStrategicDates = useMemo(
    () => strategicDates.filter(d => !d.workspace_id || envWsIds.has(d.workspace_id)),
    [strategicDates, envWsIds],
  );

  const today = new Date();
  const todayStr = formatCalendarDate(today);
  const weekStart = formatCalendarDate(startOfWeek(today, { weekStartsOn: 0 }));
  const weekEnd = formatCalendarDate(endOfWeek(today, { weekStartsOn: 0 }));

  const [selectedDate, setSelectedDate] = useState(todayStr);
  const isSelectedToday = selectedDate === todayStr;

  const data = useMemo(() => {
    const actionsThisWeek = allActions.actions.filter(a => a.action_date >= weekStart && a.action_date <= weekEnd);
    return {
      activeClients: workspaces.length,
      actionsThisWeek: actionsThisWeek.length,
      scheduled: allActions.actions.filter(a => a.status === 'scheduled').length,
      pending: allActions.actions.filter(a => ['draft', 'briefing'].includes(a.status)).length,
      overdue: overdue.length,
      todayActions: allActions.actions.filter(a => a.action_date === todayStr),
      selectedDayActions: allActions.actions
        .filter(a => a.action_date === selectedDate && a.status !== 'cancelled')
        .sort((a, b) => (a.action_time || '').localeCompare(b.action_time || '')),
      next7Days: allActions.actions
        .filter(a => a.action_date > todayStr && a.action_date <= formatCalendarDate(new Date(Date.now() + 7 * 86400000)))
        .slice(0, 8),
    };
  }, [allActions.actions, overdue.length, workspaces.length, todayStr, selectedDate, weekStart, weekEnd]);

  const selectedDayLabel = useMemo(() => {
    if (isSelectedToday) return 'Hoje';
    const d = parseISO(selectedDate + 'T00:00:00');
    const raw = format(d, "EEEE, d 'de' MMMM", { locale: ptBR });
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }, [selectedDate, isSelectedToday]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <PageHeader title={<>{title}</>} subtitle={<>{formatDate(today)} — {subtitle}</>} />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {stats.map(s => (
          <StatsCard
            key={s.label}
            icon={s.icon}
            label={s.label}
            value={data[s.key]}
            iconBg={s.iconBg}
            onClick={s.onClick}
          />
        ))}
      </div>

      {/* ESTE MÊS — acima do calendário */}
      <MonthSummaryCard actions={allActions.actions} />

      {/* CALENDARIO - largura total da secao */}
      <Card className="border-t-4 border-t-primary-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center">
              <CalendarDays className="w-4 h-4" />
            </span>
            CALENDÁRIO
          </CardTitle>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" />
              {data.todayActions.length} ação{data.todayActions.length !== 1 ? 'ões' : ''} hoje
            </span>
            <button
              onClick={() => navigate(calendarPath)}
              className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-1"
            >
              Ver calendário completo <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </CardHeader>
        <MiniCalendar
          actions={allActions.actions}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          campaigns={envCampaigns}
          strategicDates={envStrategicDates}
          onOpenCalendar={() => navigate(calendarPath)}
        />
      </Card>

      {/* VISÃO DO DIA — largura total */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>VISÃO DO DIA</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">{selectedDayLabel}</p>
          </div>
          <button
            onClick={() => navigate(calendarPath)}
            className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-1"
          >
            Ver calendário <ArrowRight className="w-3 h-3" />
          </button>
        </CardHeader>
        {data.selectedDayActions.length === 0 ? (
          <div className="py-8 text-center">
            <CalendarDays className="w-10 h-10 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">
              {isSelectedToday ? 'Nenhuma ação para hoje' : 'Nenhuma ação neste dia'}
            </p>
            <button
              onClick={() => navigate(calendarPath)}
              className="mt-3 text-sm text-primary-600 hover:text-primary-700 font-medium"
            >
              + Nova ação
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {data.selectedDayActions.map(action => (
              <div key={action.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <span className="text-sm font-bold text-gray-900 w-14 shrink-0">
                  {action.action_time?.slice(0, 5) || '—'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{action.title}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {workspaces.find(w => w.id === action.workspace_id)?.name}
                    {action.responsible?.full_name && ` · ${action.responsible.full_name}`}
                  </p>
                </div>
                <StatusBadge status={action.status} size="sm" className="shrink-0" />
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* PRÓXIMOS 7 DIAS */}
      {next7Variant === 'list' ? (
        <Card>
          <CardHeader>
            <CardTitle>Próximos 7 dias</CardTitle>
            <span className="text-xs text-gray-400">{data.next7Days.length} ações</span>
          </CardHeader>
          {data.next7Days.length === 0 ? (
            <div className="py-8 text-center">
              <TrendingUp className="w-10 h-10 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">Nenhuma ação agendada para os próximos dias</p>
              <button
                onClick={() => navigate(calendarPath)}
                className="mt-3 text-sm text-primary-600 hover:text-primary-700 font-medium"
              >
                Gerar semana automaticamente
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {data.next7Days.map(action => {
                const ws = workspaces.find(w => w.id === action.workspace_id);
                return (
                  <div key={action.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{action.title}</p>
                      <p className="text-xs text-gray-500">
                        {formatDate(action.action_date)}
                        {ws && ` · ${ws.name}`}
                      </p>
                    </div>
                    <StatusBadge status={action.status} size="sm" />
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ) : (
        data.next7Days.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Próximos 7 dias</CardTitle>
              <button
                onClick={() => navigate(calendarPath)}
                className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-1"
              >
                Ver calendário <ArrowRight className="w-3 h-3" />
              </button>
            </CardHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {data.next7Days.map(action => (
                <div key={action.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-10 h-10 rounded-lg bg-primary-100 text-primary-600 flex items-center justify-center text-xs font-bold shrink-0">
                    {formatActionDate(action.action_date)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{action.title}</p>
                    <p className="text-xs text-gray-500">{action.action_time?.slice(0, 5) || '—'}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )
      )}

      {/* CLIENTES */}
      {showClientsSection && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Clientes</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {workspaces.map(ws => {
              const wsActions = allActions.actions.filter(a => a.workspace_id === ws.id);
              const wsPending = wsActions.filter(a => ['draft', 'briefing'].includes(a.status)).length;
              const published = wsActions.filter(a => ['published', 'completed'].includes(a.status)).length;
              const progress = wsActions.length > 0 ? Math.round((published / wsActions.length) * 100) : 0;

              return (
                <Card key={ws.id} hover padding="md" onClick={() => navigate(calendarPath)}>
                  <div className="flex items-start justify-between mb-3">
                    <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size="md" />
                    <StatusBadge status={ws.is_active ? 'scheduled' : 'cancelled'} size="sm" />
                  </div>
                  <h3 className="font-semibold text-gray-900">{ws.name}</h3>
                  <p className="text-xs text-gray-500 mb-3">{ws.segment}</p>
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
                    <span>{wsActions.length} ações totais</span>
                    <span>{progress}% concluído</span>
                  </div>
                  <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary-500 rounded-full transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}