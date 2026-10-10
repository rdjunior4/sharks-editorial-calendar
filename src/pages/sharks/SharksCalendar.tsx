import Card from '@/components/ui/Card';
import { useState, useEffect, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import { Action, CalendarViewType, EnvironmentType } from '@/types';
import { cn, formatWeekdayShort } from '@/lib/utils';
import { getCalendarDays, isSameMonth, isSameDay, formatCalendarDate, format, ptBR, addDays, startOfWeek } from '@/lib/dateUtils';
import { isOverdue } from '@/lib/dateUtils';
import { useActions } from '@/hooks/useActions';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useAuth } from '@/contexts/AuthContext';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useIntegration } from '@/hooks/useIntegration';
import { isConnected, processQueue } from '@/lib/googleSync';
import CalendarEvent, { type CalendarEventProps } from '@/components/calendar/CalendarEvent';
import CalendarFilters from '@/components/calendar/CalendarFilters';
import WeekGeneratorModal from '@/components/calendar/WeekGeneratorModal';
import ActionDrawer from '@/components/actions/ActionDrawer';
import ActionForm from '@/components/actions/ActionForm';
import Button from '@/components/ui/Button';
import Tabs from '@/components/ui/Tabs';
import { useEditorial } from '@/hooks/useEditorial';
import { useStrategicDates } from '@/hooks/useStrategicDates';
import { useCalendarMarcos, updateMarcoStatus, updateMarco, type CalendarMarco } from '@/hooks/usePartners';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { useActiveCampaigns } from '@/hooks/useCampaigns';
import { ACTION_STATUSES, ACTION_STATUS_DOT_CLASSES } from '@/lib/constants';
import { ChevronLeft, ChevronRight, Calendar, Plus, Wand2, RefreshCw } from 'lucide-react';
import { DndContext, DragOverlay, closestCenter, DragStartEvent, DragEndEvent, useDraggable, useDroppable, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { toast } from 'sonner';

/* ─── Drag & Drop helpers (dnd-kit) ─── */

interface DroppableCellProps {
  id: string;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
}

/** Célula de dia que aceita ações arrastadas (feedback visual ao passar) */
function DroppableCell({ id, className, style, onClick, children }: DroppableCellProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      id={id}
      style={style}
      onClick={onClick}
      className={cn(className, isOver && 'ring-2 ring-inset ring-primary-400 ring-offset-0')}
    >
      {children}
    </div>
  );
}

interface DraggableEventProps extends CalendarEventProps {
  disabled?: boolean;
}

/** Evento arrastável — clique continua funcionando (sensor exige 6px de movimento) */
function DraggableEvent({ disabled, action, ...eventProps }: DraggableEventProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: action.id,
    disabled,
    data: { action },
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={isDragging ? 'opacity-40' : ''}
      style={{ touchAction: 'manipulation' }}
    >
      <CalendarEvent action={action} {...eventProps} />
    </div>
  );
}

/** Pill compacta do mês (elemento custom, não CalendarEvent) */
function DraggablePill({ action, disabled, onClick, className, children }: {
  action: Action;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: action.id,
    disabled,
    data: { action },
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      style={{ touchAction: 'manipulation' }}
      className={cn('flex items-center gap-1 px-1 py-0.5 rounded cursor-pointer hover:bg-gray-100 transition-colors', className, isDragging && 'opacity-40')}
    >
      {children}
    </div>
  );
}

interface SharksCalendarProps {
  initialView?: CalendarViewType;
  environment?: EnvironmentType;
}

/** Pill compacto de marco — usado nas views mês/semana/dia/agenda */
function MarcoPill({ marco, onSelect, className }: { marco: CalendarMarco; onSelect: (m: CalendarMarco) => void; className?: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onSelect(marco); }}
      className={cn(
        'w-full text-left px-1 py-0.5 rounded border text-left transition-colors',
        marco.kind === 'lead_cadastrado'
          ? 'bg-gray-50 border-gray-200 hover:bg-gray-100'
          : 'bg-violet-50 border-violet-200 hover:bg-violet-100',
        marco.status === 'done' && 'opacity-60 line-through',
        className,
      )}
      title={`${marco.title}${marco.event_time ? ` · ${marco.event_time.slice(0, 5)}` : ''}`}
    >
      <span className={cn('text-[8px] font-medium truncate block', marco.kind === 'lead_cadastrado' ? 'text-gray-500' : 'text-violet-700')}>
        {marco.event_time ? `${marco.event_time.slice(0, 5)} ` : ''}{marco.title}
      </span>
    </button>
  );
}

export default function SharksCalendar({ initialView = 'month', environment }: SharksCalendarProps) {
  const { isMobile } = useBreakpoint();
  const { isAdmin } = useAuth();
  const envForMarcos = (environment ?? 'sharks_company') as 'sharks_company' | 'estrategos';
  const { marcos } = useCalendarMarcos(envForMarcos);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<CalendarViewType>(isMobile ? 'month' : initialView);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selectedAction, setSelectedAction] = useState<Action | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedMarco, setSelectedMarco] = useState<CalendarMarco | null>(null);
  const [marcoEditOpen, setMarcoEditOpen] = useState(false);
  const [marcoForm, setMarcoForm] = useState<{ title: string; event_date: string; event_time: string }>({ title: '', event_date: '', event_time: '' });
  const [editingAction, setEditingAction] = useState<Action | null>(null);
  const [formDefaultDate, setFormDefaultDate] = useState<string | undefined>(undefined);
  const [draggedAction, setDraggedAction] = useState<Action | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const { currentWorkspace } = useWorkspace();
  const { integration } = useIntegration(currentWorkspace?.id);
  const [syncing, setSyncing] = useState(false);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  // Drag & drop: Pointer com 6px (clique preservado) + Touch com 250ms de hold (mobile)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const filterObj = useMemo(() => ({
    workspaceId: currentWorkspace?.id,
    format: (filters.format as Action['format'] | undefined) || undefined,
    status: (filters.status as Action['status'] | undefined) || undefined,
    objective: (filters.objective as Action['objective'] | undefined) || undefined,
    environment,
  }), [currentWorkspace?.id, filters.format, filters.status, filters.objective, environment]);

  const { actions, update, remove, create, loadStatus } = useActions(filterObj);
  const { pillars, profile } = useEditorial(currentWorkspace?.id);
  const activeCampaigns = useActiveCampaigns(currentWorkspace?.id);
  const { dates: strategicDates } = useStrategicDates(currentWorkspace?.id);

  const weekStep = 7;
  const goToToday = () => setCurrentDate(new Date());
  const goPrev = () => {
    if (view === 'month') setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1));
    else if (view === 'week') setCurrentDate(d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - weekStep));
    else if (view === 'day') setCurrentDate(d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
    else setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  };
  const goNext = () => {
    if (view === 'month') setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1));
    else if (view === 'week') setCurrentDate(d => new Date(d.getFullYear(), d.getMonth(), d.getDate() + weekStep));
    else if (view === 'day') setCurrentDate(d => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    else setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  };

  const handleActionClick = (action: Action) => {
    setSelectedAction(action);
    setDrawerOpen(true);
  };

  const handleEdit = (action: Action) => {
    setEditingAction(action);
    setFormOpen(true);
    setDrawerOpen(false);
  };

  const handleCreate = () => {
    setEditingAction(null);
    setFormDefaultDate(undefined);
    setFormOpen(true);
  };

  const handleCreateAtDate = (dateStr: string) => {
    setEditingAction(null);
    setFormDefaultDate(dateStr);
    setFormOpen(true);
  };

  const handleQuickStatus = async (action: Action, newStatus: Action['status']) => {
    const result = await update(action.id, { status: newStatus });
    if (result.ok) {
      toast.success(`Status alterado para "${ACTION_STATUSES[newStatus]?.label || newStatus}"`);
    } else {
      toast.error(result.error || 'Erro ao alterar status');
    }
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await processQueue(currentWorkspace?.id ?? null);
      if (res.failed) {
        toast.warning(`${res.ok ?? 0} sincronizado(s), ${res.failed} falharam.`);
      } else if (res.processed) {
        toast.success(`${res.processed} ação(ões) sincronizada(s) com Google Calendar.`);
      } else {
        toast.success('Tudo sincronizado.');
      }
    } catch (e) {
      toast.error(`Erro ao sincronizar: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleDuplicate = async (action: Action) => {
    const { id, created_at, updated_at, campaign, editorial_pillar, responsible, workspace, ...payload } = action;
    const result = await create({
      ...payload,
      title: `${action.title} (cópia)`,
      status: 'draft',
      sync_status: 'not_synced',
    });
    if (result.ok) {
      toast.success('Ação duplicada como rascunho!');
    } else {
      toast.error(result.error || 'Erro ao duplicar ação');
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const action = actions.find(a => a.id === event.active.id);
    if (action) setDraggedAction(action);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedAction(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const actionId = active.id as string;
    const newDate = over.id as string;

    update(actionId, { action_date: newDate }).then(result => {
      if (result.ok) {
        toast.success('Data atualizada — enviando ao Google Calendar...');
        // Drena a fila imediatamente: evento movido no GCal em segundos
        processQueue(currentWorkspace?.id ?? null).catch(() => {});
      } else {
        toast.error(result.error || 'Erro ao mover ação');
      }
    });
  };

  // Reset expanded day when navigating months
  useEffect(() => {
    setExpandedDay(null);
  }, [currentDate.getMonth(), currentDate.getFullYear()]);

  const calendarDays = getCalendarDays(currentDate);
  const weekDays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const monthLabel = format(currentDate, 'MMMM yyyy', { locale: ptBR });

// View Semana: semana completa (7 dias). No mobile a grade fica mais larga
// que a tela e rola lateralmente para ver a semana inteira.
const weekDayWindow = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(currentDate, { weekStartsOn: 0 }), i));

  const views: { id: CalendarViewType; label: string }[] = isMobile
    ? [
        { id: 'month', label: 'Mês' },
        { id: 'day', label: 'Dia' },
        { id: 'week', label: 'Sem' },
        { id: 'agenda', label: 'Agenda' },
      ]
    : [
        { id: 'month', label: 'Mês' },
        { id: 'week', label: 'Semana' },
        { id: 'agenda', label: 'Agenda' },
      ];

  return (
    <div className="flex flex-col gap-4 h-[calc(100dvh-12.5rem)] lg:h-[calc(100dvh-6.5rem)]">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {/* Header */}
        <div className="flex flex-col gap-3 shrink-0">
          {/* Linha 1: título + Hoje + Filtros */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight capitalize truncate">{monthLabel}</h1>
              <Button variant="ghost" size="sm" onClick={goToToday}>Hoje</Button>
            </div>
            <CalendarFilters activeFilters={filters} onFilterChange={setFilters} environment={environment} />
          </div>

          {/* Linha 2: controles em uma linha (views + navegação + ações) */}
          <div className="flex items-center gap-2 flex-wrap">
            <Tabs tabs={views} activeTab={view} onChange={setView} />

            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" onClick={goPrev}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={goNext}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={!currentWorkspace}
              onClick={() => setGeneratorOpen(true)}
            >
              <Wand2 className="w-4 h-4" />
              <span className="hidden sm:inline">Gerar semana</span>
            </Button>

            {isConnected(currentWorkspace?.id) && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncing}
              >
                <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
                <span className="hidden sm:inline">Sincronizar</span>
              </Button>
            )}

            <Button size="sm" onClick={handleCreate}>
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Nova ação</span>
            </Button>
          </div>
        </div>

        {/* Month View */}
        {view === 'month' && (
          <Card padding="none" className="overflow-hidden flex flex-col min-h-0">
            <div className="grid grid-cols-7 border-b border-gray-200 shrink-0">
              {(isMobile ? ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'] : weekDays).map((day, i) => (
                <div key={i} className="px-1 sm:px-3 py-2 text-xs font-semibold text-gray-500 text-center border-r last:border-r-0">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {calendarDays.map((day, i) => {
                const dateStr = formatCalendarDate(day);
                const dayActions = actions.filter(a => a.action_date === dateStr);
                const isCurrentMonth = isSameMonth(day, currentDate);
                const isToday = isSameDay(day, new Date());

                // Campanhas ativas neste dia
                const dayCampaigns = activeCampaigns.filter(c => {
                  if (!c.start_date) return false;
                  const start = c.start_date;
                  const end = c.end_date || c.start_date;
                  return dateStr >= start && dateStr <= end;
                });

                // Datas estratégicas deste dia
                const dayStrategic = strategicDates.filter(s => s.date === dateStr);

                // Marcos do calendário (parceiros + leads, migration 076)
                const dayMarcos = marcos.filter(m => m.event_date === dateStr && m.status !== 'canceled');

                return (
                  <DroppableCell
                    key={i}
                    id={dateStr}
                    onClick={() => { if (dayActions.length === 0) handleCreateAtDate(dateStr); }}
                    style={dayCampaigns.length > 0 ? {
                      backgroundImage: `linear-gradient(${dayCampaigns[0].color || '#0066FF'}0F, ${dayCampaigns[0].color || '#0066FF'}0F)`,
                    } : undefined}
                    className={cn(
                      'min-h-[88px] border-r border-b last:border-r-0 p-1 sm:p-1.5 transition-colors',
                      !isCurrentMonth && 'bg-gray-50/50',
                      isToday && 'bg-primary-50/30',
                      dayActions.length === 0 && 'cursor-pointer',
                      'calendar-cell hover:bg-gray-50/80'
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={cn(
                        'text-xs font-medium w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full',
                        isToday && 'bg-primary-500 text-white',
                        !isToday && isCurrentMonth && 'text-gray-900',
                        !isCurrentMonth && 'text-gray-300'
                      )}>
                        {day.getDate()}
                      </span>
                    </div>
                    {/* Datas estratégicas */}
                    {dayStrategic.length > 0 && (
                      <div className="flex flex-col gap-0.5 mb-1">
                        {dayStrategic.map(s => (
                          <div
                            key={s.id}
                            className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-amber-50 border border-amber-200"
                            title={s.description || s.title}
                          >
                            <span className="text-[8px] text-amber-600 font-medium truncate">{s.title}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Marcos: reuniões/ações de parceiros + leads novos */}
                    {dayMarcos.length > 0 && (
                      <div className="flex flex-col gap-0.5 mb-1">
                        {dayMarcos.slice(0, 3).map(m => (
                          <MarcoPill key={m.id} marco={m} onSelect={setSelectedMarco} />
                        ))}
                        {dayMarcos.length > 3 && <p className="text-[8px] text-gray-400 leading-none">+{dayMarcos.length - 3} marcos</p>}
                      </div>
                    )}
                    {/* Faixa de campanha: continua entre dias, com label no inicio */}
                    {dayCampaigns.length > 0 && (
                      <div className="flex flex-col gap-0.5 mb-1">
                        {dayCampaigns.slice(0, 2).map(c => {
                          const rangeEnd = c.end_date || c.start_date!;
                          const col = i % 7;
                          const isStart = dateStr === c.start_date || col === 0;
                          const isEnd = dateStr === rangeEnd || col === 6;
                          const showLabel = dateStr === c.start_date || (col === 0 && c.start_date! < dateStr);
                          const color = c.color || '#0066FF';
                          return (
                            <div
                              key={c.id}
                              title={`${c.name}${c.start_date ? ` · ${c.start_date.split('-').reverse().join('/')} → ${rangeEnd.split('-').reverse().join('/')}` : ''}`}
                              className={cn(
                                'flex items-center overflow-hidden',
                                showLabel ? 'h-[14px] px-1' : 'h-1.5',
                                isStart && isEnd && 'rounded-full',
                                isStart && !isEnd && 'rounded-l-full',
                                !isStart && isEnd && 'rounded-r-full'
                              )}
                              style={{ backgroundColor: color }}
                            >
                              {showLabel && (
                                <span className="text-[8px] font-semibold text-white truncate">🏁 {c.name}</span>
                              )}
                            </div>
                          );
                        })}
                        {dayCampaigns.length > 2 && (
                          <p className="text-[8px] text-gray-400 leading-none">+{dayCampaigns.length - 2} campanhas</p>
                        )}
                      </div>
                    )}
                    {(() => {
                        const maxVisible = isMobile ? 3 : 4;
                        const isExpanded = expandedDay === dateStr;
                        const hiddenCount = dayActions.length - maxVisible;
                        return (
                          <div className="space-y-0.5">
                            {/* Pills compactas (estado colapsado) */}
                            {!isExpanded && dayActions.slice(0, maxVisible).map(action => (
                              <DraggablePill
                                key={action.id}
                                action={action}
                                disabled={action.status === 'cancelled'}
                                onClick={(e) => { e.stopPropagation(); handleActionClick(action); }}
                              >
                                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', ACTION_STATUS_DOT_CLASSES[action.status] || 'bg-gray-400')} />
                                <span className="text-[10px] font-medium truncate">{action.title}</span>
                              </DraggablePill>
                            ))}
                            {/* Botão "Ver todas" */}
                            {!isExpanded && hiddenCount > 0 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setExpandedDay(dateStr); }}
                                className="w-full text-[9px] sm:text-[10px] text-primary-600 font-medium hover:text-primary-700 py-0.5 transition-colors"
                              >
                                Ver todas ({hiddenCount}+)
                              </button>
                            )}
                            {/* Estado expandido: todas as ações com scroll */}
                            {isExpanded && (
                              <div className="space-y-0.5 border-t border-gray-100 pt-1">
                                {dayActions.map(action => (
                                  <DraggablePill
                                    key={action.id}
                                    action={action}
                                    disabled={action.status === 'cancelled'}
                                    onClick={(e) => { e.stopPropagation(); handleActionClick(action); }}
                                  >
                                    <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', ACTION_STATUS_DOT_CLASSES[action.status] || 'bg-gray-400')} />
                                    <span className="text-[10px] font-medium truncate">{action.title}</span>
                                  </DraggablePill>
                                ))}
                                <button
                                  onClick={(e) => { e.stopPropagation(); setExpandedDay(null); }}
                                  className="w-full text-[9px] text-gray-400 hover:text-gray-600 py-0.5 transition-colors"
                                >
                                  Recolher
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                  </DroppableCell>
                );
              })}
            </div>

            {/* Legenda */}
            {(activeCampaigns.filter(c => c.start_date).length > 0 || strategicDates.length > 0) && (
              <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-t border-gray-100 bg-gray-50/50">
                {activeCampaigns.filter(c => c.start_date).map(c => (
                  <span key={c.id} className="flex items-center gap-1.5 text-[11px] text-gray-600">
                    <span className="w-3 h-1.5 rounded-full" style={{ backgroundColor: c.color || '#0066FF' }} />
                    {c.name}
                  </span>
                ))}
                {strategicDates.length > 0 && (
                  <span className="flex items-center gap-1.5 text-[11px] text-amber-600">
                    <span className="w-3 h-1.5 rounded-full bg-amber-400" />
                    Data estratégica
                  </span>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Week View */}
        {view === 'week' && (
          <Card padding="none" className="overflow-hidden flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-auto">
              <div className={cn('min-h-full flex flex-col', isMobile && 'min-w-[720px]')}>
                <div className="sticky top-0 z-10 bg-white grid grid-cols-7 border-b border-gray-200 shrink-0">
                  {weekDayWindow.map((day, i) => (
                    <div key={i} className="px-2 py-3 text-center border-r last:border-r-0">
                      <p className="text-xs text-gray-500">{isMobile ? formatWeekdayShort(day) : weekDays[i]}</p>
                      <p className={cn(
                        'text-lg font-semibold',
                        isSameDay(day, new Date()) ? 'text-primary-500' : 'text-gray-900'
                      )}>
                        {day.getDate()}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-1 min-h-0">
                  {weekDayWindow.map((day, i) => {
                    const dateStr = formatCalendarDate(day);
                    const dayActions = actions.filter(a => a.action_date === dateStr);
                    const dayCampaigns = activeCampaigns.filter(c => {
                      if (!c.start_date) return false;
                      const start = c.start_date;
                      const end = c.end_date || c.start_date;
                      return dateStr >= start && dateStr <= end;
                    });
                    const dayStrategic = strategicDates.filter(s => s.date === dateStr);
                    const dayWeekMarcos = marcos.filter(m => m.event_date === dateStr && m.status !== 'canceled');

                    return (
                      <DroppableCell
                        key={i}
                        id={dateStr}
                        className="flex-1 min-w-0 min-h-0 border-r last:border-r-0 p-1.5 sm:p-2 space-y-1 sm:space-y-2 overflow-y-auto"
                      >
                        {dayStrategic.length > 0 && (
                          <div className="flex flex-col gap-0.5">
                            {dayStrategic.map(s => (
                              <div key={s.id} className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-amber-50 border border-amber-200" title={s.description || s.title}>
                                <span className="text-[8px] text-amber-600 font-medium truncate">{s.title}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {dayWeekMarcos.length > 0 && (
                          <div className="flex flex-col gap-0.5">
                            {dayWeekMarcos.slice(0, 4).map(m => (
                              <MarcoPill key={m.id} marco={m} onSelect={setSelectedMarco} />
                            ))}
                          </div>
                        )}
                        {dayCampaigns.length > 0 && (
                          <div className="flex flex-col gap-0.5">
                            {dayCampaigns.map(c => (
                              <div
                                key={c.id}
                                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md"
                                style={{ backgroundColor: `${c.color || '#0066FF'}1F` }}
                                title={`${c.name}${c.start_date ? ` · ${c.start_date.split('-').reverse().join('/')} → ${(c.end_date || c.start_date).split('-').reverse().join('/')}` : ''}`}
                              >
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: c.color || '#0066FF' }} />
                                <span className="text-[9px] font-semibold truncate" style={{ color: c.color || '#0066FF' }}>
                                  🏁 {c.name}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {dayActions.map(action => (
                          <DraggableEvent
                            key={action.id}
                            action={action}
                            disabled={action.status === 'cancelled'}
                            onClick={() => handleActionClick(action)}
                            onQuickStatus={handleQuickStatus}
                            compact={isMobile}
                            showTime={isMobile}
                            showClient={isAdmin}
                          />
                        ))}
                        {dayActions.length === 0 && loadStatus === 'success' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCreateAtDate(dateStr)}
                            className="w-full text-[10px] text-gray-300 hover:text-gray-500 py-1 px-1"
                          >
                            + Nova ação
                          </Button>
                        )}
                      </DroppableCell>
                    );
                  })}
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Day View (mobile-optimized) */}
        {view === 'day' && (
          <Card padding="none" className="overflow-hidden flex-1 min-h-0 flex flex-col">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/50 shrink-0">
              <p className="text-sm font-semibold text-gray-900 capitalize">
                {format(currentDate, 'EEEE, dd MMMM yyyy', { locale: ptBR })}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {actions.filter(a => a.action_date === formatCalendarDate(currentDate)).length} ação(ões) neste dia
              </p>
            </div>
            <div className="divide-y divide-gray-100 flex-1 min-h-0 overflow-y-auto">
              {(() => {
                const dateStr = formatCalendarDate(currentDate);
                const dayActions = actions.filter(a => a.action_date === dateStr);
                const dayViewMarcos = marcos.filter(m => m.event_date === dateStr && m.status !== 'canceled');
                if (dayActions.length === 0 && dayViewMarcos.length === 0) {
                  return (
                    <div className="p-8 text-center cursor-pointer hover:bg-gray-50/80 transition-colors" onClick={() => handleCreateAtDate(dateStr)}>
                      <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                      <p className="text-sm font-medium text-gray-900">Nenhuma ação</p>
                      <p className="text-xs text-gray-500 mt-1">Clique aqui para criar uma ação.</p>
                    </div>
                  );
                }
                return (
                  <>
                    {dayViewMarcos.map(m => (
                      <div key={m.id} className="p-3">
                        <MarcoPill marco={{ ...m }} onSelect={(mm) => setSelectedMarco(mm)} className="text-[10px] py-1" />
                      </div>
                    ))}
                    {dayActions.map(action => (
                      <div key={action.id} className="p-3 hover:bg-gray-50/80 transition-colors">
                        <CalendarEvent
                          action={action}
                          onClick={() => handleActionClick(action)}
                          onQuickStatus={handleQuickStatus}
                          showClient={isAdmin}
                        />
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          </Card>
        )}

        {/* Agenda View */}
        {view === 'agenda' && (
          <Card padding="none" className="divide-y divide-gray-100 flex-1 min-h-0 overflow-y-auto">
            {calendarDays.filter(d => actions.some(a => a.action_date === formatCalendarDate(d))).length === 0 ? (
              <div className="p-8 text-center">
                <Calendar className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-900">Nenhuma ação neste período</p>
                <p className="text-xs text-gray-500 mt-1">Crie uma nova ação ou gere uma semana automaticamente.</p>
              </div>
            ) : (
              calendarDays.map((day, i) => {
                const dateStr = formatCalendarDate(day);
                const dayActions = actions.filter(a => a.action_date === dateStr);
                const dayAgendaMarcos = marcos.filter(m => m.event_date === dateStr && m.status !== 'canceled');
                if (dayActions.length === 0 && dayAgendaMarcos.length === 0) return null;

                return (
                  <div key={i} className="p-4">
                    <p className="text-sm font-semibold text-gray-900 mb-2 capitalize">
                      {format(day, 'EEEE, dd MMM', { locale: ptBR })}
                    </p>
                    <div className="space-y-2 ml-4">
                      {dayAgendaMarcos.map(m => (
                        <MarcoPill key={m.id} marco={m} onSelect={setSelectedMarco} className="text-[10px] py-1" />
                      ))}
                      {dayActions.map(action => (
                        <CalendarEvent
                          key={action.id}
                          action={action}
                          onClick={() => handleActionClick(action)}
                          onQuickStatus={handleQuickStatus}
                          showClient={isAdmin}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        )}

        <DragOverlay>
          {draggedAction ? (
            <CalendarEvent action={draggedAction} onClick={() => {}} isDragging />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Action Drawer */}
      <ActionDrawer
        action={selectedAction ? actions.find(a => a.id === selectedAction.id) ?? selectedAction : null}
        isOpen={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedAction(null); }}
        onEdit={handleEdit}
        onDelete={remove}
        onDuplicate={handleDuplicate}
        onUpdate={(id, patch) => update(id, patch)}
      />

      {/* Action Form */}
      <ActionForm
        action={editingAction}
        isOpen={formOpen}
        defaultDate={formDefaultDate}
        onClose={() => { setFormOpen(false); setEditingAction(null); setFormDefaultDate(undefined); }}
        environment={environment}
      />

      {/* Week Generator */}
      {currentWorkspace && (
        <WeekGeneratorModal
          isOpen={generatorOpen}
          onClose={() => setGeneratorOpen(false)}
          workspaceId={currentWorkspace.id}
          workspaceName={currentWorkspace.name}
          profile={profile}
          pillars={pillars}
          existingActions={actions}
          strategicDates={strategicDates}
          activeCampaigns={activeCampaigns}
        />
      )}

      {/* Detalhe/edição do marco */}
      <Modal isOpen={!!selectedMarco} onClose={() => { setSelectedMarco(null); setMarcoEditOpen(false); }} title="Marco da agenda" size="sm">
        {selectedMarco && (
          marcoEditOpen ? (
            <div className="space-y-3">
              <Input
                label="Título"
                value={marcoForm.title}
                onChange={(e) => setMarcoForm(f => ({ ...f, title: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Data"
                  type="date"
                  value={marcoForm.event_date}
                  onChange={(e) => setMarcoForm(f => ({ ...f, event_date: e.target.value }))}
                />
                <Input
                  label="Hora"
                  type="time"
                  value={marcoForm.event_time}
                  onChange={(e) => setMarcoForm(f => ({ ...f, event_time: e.target.value }))}
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                <Button variant="ghost" size="sm" onClick={() => setMarcoEditOpen(false)}>Voltar</Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      await updateMarco(selectedMarco.id, {
                        title: marcoForm.title || selectedMarco.title,
                        event_date: marcoForm.event_date || selectedMarco.event_date,
                        event_time: marcoForm.event_time || null,
                      });
                      toast.success('Marco atualizado');
                      setSelectedMarco(null);
                      setMarcoEditOpen(false);
                    } catch (e) { toast.error(e instanceof Error ? e.message : 'Erro'); }
                  }}
                >
                  Salvar
                </Button>
              </div>
            </div>
          ) : (
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium text-gray-400">
                {selectedMarco.kind === 'reuniao_parceiro' ? '🤝 Reunião com parceiro' : selectedMarco.kind === 'acao_parceiro' ? '✨ Ação com parceiro' : selectedMarco.kind === 'reuniao_lead' ? '📅 Reunião com lead' : '🎯 Marco de lead'}
              </p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{selectedMarco.title}</p>
            </div>
            <p className="text-sm text-gray-600">
              {new Date(`${selectedMarco.event_date}T${selectedMarco.event_time ?? '00:00'}`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })}
              {selectedMarco.event_time ? ` às ${selectedMarco.event_time.slice(0, 5)}` : ''}
            </p>
            {selectedMarco.description && <p className="text-sm text-gray-600">{selectedMarco.description}</p>}
            {selectedMarco.partner?.name && <p className="text-sm text-gray-600">Parceiro: <strong>{selectedMarco.partner.name}</strong></p>}
            {selectedMarco.responsible?.full_name && <p className="text-sm text-gray-600">Responsável: {selectedMarco.responsible.full_name}</p>}
            {selectedMarco.status === 'planned' && (
              <div className="flex gap-2 pt-2 border-t border-gray-100">
                <Button size="sm" variant="ghost" onClick={() => { setMarcoForm({ title: selectedMarco.title, event_date: selectedMarco.event_date, event_time: selectedMarco.event_time?.slice(0, 5) ?? '' }); setMarcoEditOpen(true); }}>
                  Editar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => { try { await updateMarcoStatus(selectedMarco.id, 'done'); toast.success('Marco concluído'); } catch (e) { toast.error(e instanceof Error ? e.message : 'Erro'); } finally { setSelectedMarco(null); } }}
                >
                  Concluir
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => { try { await updateMarcoStatus(selectedMarco.id, 'canceled'); toast.success('Marco cancelado'); } catch (e) { toast.error(e instanceof Error ? e.message : 'Erro'); } finally { setSelectedMarco(null); } }}
                >
                  Cancelar
                </Button>
              </div>
            )}
          </div>
          )
        )}
      </Modal>
    </div>
  );
}
