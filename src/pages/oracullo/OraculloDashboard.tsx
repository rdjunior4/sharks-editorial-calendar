import PageHeader from '@/components/ui/PageHeader';
import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Card, { CardHeader, CardTitle } from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import StatsCard from '@/components/dashboard/StatsCard';
import MiniCalendar from '@/components/dashboard/MiniCalendar';
import MonthSummaryCard from '@/components/dashboard/MonthSummaryCard';
import StatusBadge from '@/components/actions/StatusBadge';
import ActionDrawer from '@/components/actions/ActionDrawer';
import { supabase } from '@/lib/supabase';
import { type User, type EnvironmentType, type Action, type Campaign, type StrategicDate } from '@/types';
import { formatCalendarDate, parseISO, format, ptBR } from '@/lib/dateUtils';
import { formatDate, cn } from '@/lib/utils';
import { Users, Building2, Briefcase, Link2, CalendarDays, ArrowRight, Boxes } from 'lucide-react';

export default function OraculloDashboard() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[]>([]);
  const [wsCount, setWsCount] = useState<{ sharks: number; estrategos: number }>({ sharks: 0, estrategos: 0 });
  const [actions, setActions] = useState<Action[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [strategicDates, setStrategicDates] = useState<StrategicDate[]>([]);
  const [detailAction, setDetailAction] = useState<Action | null>(null);
  const today = new Date();
  const todayStr = formatCalendarDate(today);
  const [selectedDate, setSelectedDate] = useState(todayStr);

  useEffect(() => {
    const load = async () => {
      const [u, w, ac, cp, sd] = await Promise.all([
        supabase.from('users').select('id, email, full_name, role, avatar_url'),
        supabase.from('workspaces').select('id, organizations(environment)').eq('is_active', true),
        supabase.from('actions').select('*, workspace:workspaces(name)').order('action_date'),
        supabase.from('campaigns').select('*'),
        supabase.from('strategic_dates').select('*'),
      ]);
      setUsers((u.data as unknown as User[]) ?? []);
      const wsRows = (w.data ?? []) as unknown as Array<{ organizations: { environment: EnvironmentType } | null }>;
      setWsCount({
        sharks: wsRows.filter(r => r.organizations?.environment === 'sharks_company').length,
        estrategos: wsRows.filter(r => r.organizations?.environment === 'estrategos').length,
      });
      setActions((ac.data as unknown as Action[]) ?? []);
      setCampaigns((cp.data as unknown as Campaign[]) ?? []);
      setStrategicDates((sd.data as unknown as StrategicDate[]) ?? []);
    };
    load();

    const channel = supabase
      .channel('oracullo-dash')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'actions' }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const selectedDayActions = useMemo(() =>
    actions
      .filter(a => a.action_date === selectedDate && a.status !== 'cancelled')
      .sort((a, b) => (a.action_time || '').localeCompare(b.action_time || '')),
    [actions, selectedDate]
  );

  const isSelectedToday = selectedDate === todayStr;

  const selectedDayLabel = useMemo(() => {
    if (isSelectedToday) return 'Hoje';
    const d = parseISO(selectedDate + 'T00:00:00');
    const raw = format(d, "EEEE, d 'de' MMMM", { locale: ptBR });
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }, [selectedDate, isSelectedToday]);

  const envLabel = (env: EnvironmentType) => env === 'sharks_company' ? 'Sharks' : 'Estrategos';

  return (
    <div className="space-y-4">
      <PageHeader title="Oracullo Calendar" subtitle={<>{formatDate(today)} — Governança dos ambientes</>} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatsCard icon={Users} label="Usuários" value={users.length} />
        <StatsCard icon={Building2} label="Workspaces" value={wsCount.sharks + wsCount.estrategos} />
        <StatsCard icon={CalendarDays} label="Ações total" value={actions.length} />
        <StatsCard icon={Briefcase} label="Projetos Estrategos" value={actions.filter(a => a.environment === 'estrategos').length} />
      </div>

      {/* ESTE MÊS — acima do calendário */}
      <MonthSummaryCard actions={actions} />

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
              {actions.filter(a => a.action_date === todayStr && a.status !== 'cancelled').length} ação{actions.filter(a => a.action_date === todayStr && a.status !== 'cancelled').length !== 1 ? 'ões' : ''} hoje
            </span>
            <span className="text-xs text-gray-400 flex items-center gap-1">
              todos os ambientes <ArrowRight className="w-3 h-3" />
            </span>
          </div>
        </CardHeader>
        <MiniCalendar
          actions={actions}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          campaigns={campaigns}
          strategicDates={strategicDates}
        />
      </Card>

      {/* VISÃO DO DIA — largura total */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>VISÃO DO DIA</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">{selectedDayLabel}</p>
          </div>
        </CardHeader>
        {selectedDayActions.length === 0 ? (
          <div className="py-6 text-center">
            <CalendarDays className="w-10 h-10 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">
              {isSelectedToday ? 'Nenhuma ação para hoje' : 'Nenhuma ação neste dia'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {selectedDayActions.map(action => {
              const env = action.environment || 'sharks_company';
              return (
                <div
                  key={action.id}
                  onClick={() => setDetailAction(action)}
                  className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors"
                >
                  <span className="text-sm font-bold text-gray-900 w-14 shrink-0">
                    {action.action_time?.slice(0, 5) || '—'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{action.title}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {envLabel(env)}
                      {action.workspace?.name ? ` · ${action.workspace.name}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={env === 'sharks_company' ? 'info' : 'success'} size="sm">
                      {envLabel(env)}
                    </Badge>
                    <StatusBadge status={action.status} size="sm" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center">
              <Boxes className="w-4 h-4" />
            </span>
            Ambientes
          </CardTitle>
          <span className="text-xs text-gray-400">visao consolidada</span>
        </CardHeader>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="grid grid-cols-2 gap-3 lg:col-span-1">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-gray-900">{wsCount.sharks + wsCount.estrategos}</p>
              <p className="text-[11px] text-gray-400">Clientes total</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-gray-900">{users.length}</p>
              <p className="text-[11px] text-gray-400">Usuarios</p>
            </div>
          </div>
          <div className="space-y-2 lg:col-span-2">
            {users.slice(0, 5).map(u => (
              <div key={u.id} className="flex items-center gap-2.5">
                <Avatar name={u.full_name} src={u.avatar_url} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 truncate">{u.full_name}</p>
                </div>
                <Badge variant={u.role === 'oracullo_admin' ? 'purple' : 'default'} size="sm">
                  {u.role === 'oracullo_admin' ? 'Oracullo' : u.role === 'admin_sharks' ? 'Admin Sharks' : u.role === 'sharks_team' ? 'Time Sharks' : 'Cliente'}
                </Badge>
              </div>
            ))}
            {users.length > 5 && (
              <p className="text-xs text-gray-400 text-center pt-1">+{users.length - 5} outros</p>
            )}
          </div>
        </div>
        <button
          onClick={() => navigate('/oracullo/access')}
          className="mt-4 w-full text-center text-sm text-primary-600 hover:text-primary-700 transition-colors"
        >
          Ver todos os acessos →
        </button>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Link2 className="w-4 h-4 text-gray-400" /> Ações rápidas</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => navigate('/oracullo/access')} className="px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm text-gray-700 transition-colors">
            Gerenciar acessos
          </button>
          <button onClick={() => navigate('/oracullo/users')} className="px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm text-gray-700 transition-colors">
            Ver usuários
          </button>
          <button onClick={() => navigate('/oracullo/access-requests')} className="px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm text-gray-700 transition-colors">
            Solicitações pendentes
          </button>
        </div>
      </Card>

      {/* Detalhes da ação (clique na ação do dia) */}
      <ActionDrawer
        action={detailAction}
        isOpen={!!detailAction}
        onClose={() => setDetailAction(null)}
        onEdit={a => {
          setDetailAction(null);
          navigate(a.environment === 'estrategos' ? '/estrategos/calendar' : '/sharks/calendar');
        }}
      />
    </div>
  );
}
