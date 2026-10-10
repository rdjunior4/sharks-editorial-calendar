import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import Avatar from '@/components/ui/Avatar';
import { usePartners, useCalendarMarcos, createMarco, updateMarcoStatus, type Partner, type PartnerPayload, type CalendarMarco, type MarcoKind } from '@/hooks/usePartners';
import { useEnvStaff } from '@/hooks/useLeads';
import type { CrmEnvironment } from '@/hooks/useLeads';
import { toast } from 'sonner';
import { Handshake, Plus, Pencil, CalendarClock, CheckCircle2, XCircle, Trash2, Search } from 'lucide-react';

/* ─── Página Parceiros: cadastro no padrão do catálogo + agenda ─── */
export default function PartnersPage({ environment }: { environment: CrmEnvironment }) {
  const { partners, loading } = usePartners(environment);
  const { marcos } = useCalendarMarcos(environment);
  const owners = useEnvStaff(environment);

  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Partner | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{ name: string; contact_name: string; contact_email: string; contact_phone: string; social_instagram: string; notes: string; status: 'active' | 'inactive' }>({ name: '', contact_name: '', contact_email: '', contact_phone: '', social_instagram: '', notes: '', status: 'active' });

  // Planejar reunião/ação
  const [planFor, setPlanFor] = useState<Partner | null>(null);
  const [plan, setPlan] = useState<{ kind: MarcoKind; title: string; event_date: string; event_time: string; responsible_id: string }>({ kind: 'reuniao_parceiro', title: '', event_date: '', event_time: '', responsible_id: '' });
  const [planning, setPlanning] = useState(false);

  useEffect(() => { setFormOpen(false); setPlanFor(null); }, [environment]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return partners;
    return partners.filter(p => p.name.toLowerCase().includes(q) || (p.contact_name ?? '').toLowerCase().includes(q) || (p.social_instagram ?? '').toLowerCase().includes(q));
  }, [partners, search]);

  const upcoming = useMemo(() => marcos
    .filter(m => m.kind !== 'lead_cadastrado' && m.status === 'planned')
    .sort((a, b) => a.event_date.localeCompare(b.event_date)), [marcos]);

  const openNew = () => { setEditing(null); setForm({ name: '', contact_name: '', contact_email: '', contact_phone: '', social_instagram: '', notes: '', status: 'active' }); setFormOpen(true); };
  const openEdit = (p: Partner) => { setEditing(p); setForm({ name: p.name, contact_name: p.contact_name ?? '', contact_email: p.contact_email ?? '', contact_phone: p.contact_phone ?? '', social_instagram: p.social_instagram ?? '', notes: p.notes ?? '', status: p.status }); setFormOpen(true); };

  const handleSave = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const payload: PartnerPayload = {
        name: form.name.trim(),
        contact_name: form.contact_name.trim() || null,
        contact_email: form.contact_email.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        social_instagram: form.social_instagram.trim() || null,
        notes: form.notes.trim() || null,
        status: form.status,
      };
      const { error } = editing
        ? await supabase.from('partners').update(payload).eq('id', editing.id)
        : await supabase.from('partners').insert({ ...payload, environment });
      if (error) throw new Error(error.message);
      toast.success(editing ? 'Parceiro atualizado!' : 'Parceiro cadastrado!');
      setFormOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar parceiro');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (p: Partner) => {
    try {
      const { error } = await supabase.from('partners').update({ status: p.status === 'active' ? 'inactive' : 'active' }).eq('id', p.id);
      if (error) throw new Error(error.message);
      toast.success(p.status === 'active' ? 'Parceiro inativado' : 'Parceiro reativado');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar');
    }
  };

  const openPlan = (p: Partner) => {
    setPlanFor(p);
    setPlan({ kind: 'reuniao_parceiro', title: '', event_date: '', event_time: '', responsible_id: '' });
  };

  const handlePlan = async () => {
    if (!planFor || !plan.event_date || !plan.title.trim() || planning) return;
    setPlanning(true);
    try {
      await createMarco({
        environment,
        kind: plan.kind,
        title: plan.title.trim(),
        event_date: plan.event_date,
        event_time: plan.event_time || null,
        partner_id: planFor.id,
        responsible_id: plan.responsible_id || null,
      });
      toast.success('Registrado no calendário!');
      setPlanFor(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao planejar');
    } finally {
      setPlanning(false);
    }
  };

  const handleMarcoStatus = async (m: CalendarMarco, status: 'done' | 'canceled') => {
    try {
      await updateMarcoStatus(m.id, status);
      toast.success(status === 'done' ? 'Marcado como realizada' : 'Cancelada');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar');
    }
  };

  const partnerName = (id: string | null) => partners.find(p => p.id === id)?.name ?? 'Parceiro';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Parceiros"
          subtitle="Cadastro da agência conectado à agenda — reuniões e ações planejadas aparecem no calendário"
        />
        <Button onClick={openNew}>
          <Plus className="w-4 h-4" />
          Novo parceiro
        </Button>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Parceiros ativos', value: partners.filter(p => p.status === 'active').length },
          { label: 'Na agenda (planejadas)', value: upcoming.length },
          { label: 'Realizadas', value: marcos.filter(m => m.kind !== 'lead_cadastrado' && m.status === 'done').length },
        ].map(({ label, value }) => (
          <Card key={label} padding="sm" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
              <Handshake className="w-5 h-5 text-primary-600" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-bold text-gray-900 tabular-nums leading-none">{value}</p>
              <p className="text-[11px] text-gray-500 truncate mt-0.5">{label}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Próximos na agenda */}
      {upcoming.length > 0 && (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-primary-600" />
            Próximos na agenda
          </h3>
          <div className="space-y-1.5">
            {upcoming.slice(0, 5).map(m => (
              <div key={m.id} className="flex items-center gap-2 text-xs bg-gray-50 rounded-lg px-3 py-2">
                <span className="font-medium text-gray-700 shrink-0">
                  {new Date(`${m.event_date}T${m.event_time ?? '00:00'}`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                  {m.event_time ? ` ${m.event_time.slice(0, 5)}` : ''}
                </span>
                <span className="truncate flex-1 text-gray-600">{m.kind === 'reuniao_parceiro' ? '🤝' : '✨'} {m.title} — {partnerName(m.partner_id)}</span>
                {m.responsible && <Avatar name={m.responsible.full_name} src={m.responsible.avatar_url} size="xs" />}
                <button onClick={() => handleMarcoStatus(m, 'done')} className="p-1 rounded text-emerald-600 hover:bg-emerald-50" title="Marcar realizada"><CheckCircle2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => handleMarcoStatus(m, 'canceled')} className="p-1 rounded text-gray-400 hover:bg-red-50 hover:text-red-500" title="Cancelar"><XCircle className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Lista */}
      <div className="relative max-w-sm">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar parceiro..."
          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 placeholder:text-gray-400"
        />
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center py-10">
          <Loading />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={Handshake}
            title="Nenhum parceiro cadastrado"
            description="Cadastre parceiros e planeje reuniões e ações com eles na agenda — tudo aparece no calendário."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(p => (
            <Card key={p.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-900 truncate">{p.name}</p>
                    {p.status === 'active'
                      ? <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700">Ativo</span>
                      : <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-500">Inativo</span>}
                    {p.social_instagram && <span className="text-[11px] text-gray-400">📷 @{p.social_instagram}</span>}
                  </div>
                  {(p.contact_name || p.contact_email || p.contact_phone) && (
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {[p.contact_name, p.contact_email, p.contact_phone].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {p.notes && <p className="text-xs text-gray-400 mt-0.5 truncate">{p.notes}</p>}
                  <div className="flex items-center gap-2 mt-2">
                    <Button size="sm" variant="ghost" onClick={() => openPlan(p)}>
                      <CalendarClock className="w-3.5 h-3.5" />
                      Planejar
                    </Button>
                    {(() => {
                      const next = marcos.find(m => m.partner_id === p.id && m.status === 'planned' && m.kind !== 'lead_cadastrado');
                      return next ? (
                        <span className="text-[11px] text-gray-400 truncate max-w-[240px]">
                          Próx.: {new Date(`${next.event_date}T${next.event_time ?? '00:00'}`).toLocaleDateString('pt-BR')} · {next.title}
                        </span>
                      ) : null;
                    })()}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => handleToggleStatus(p)} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors" title={p.status === 'active' ? 'Inativar' : 'Reativar'}>
                    {p.status === 'active' ? <XCircle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={() => openEdit(p)} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors" title="Editar">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Modal parceiro */}
      <Modal isOpen={formOpen} onClose={() => setFormOpen(false)} title={editing ? 'Editar parceiro' : 'Novo parceiro'} size="sm">
        <div className="space-y-3">
          <Input label="Nome *" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex.: Distribuidora ABC" />
          <Input label="Contato (nome)" value={form.contact_name} onChange={(e) => setForm(f => ({ ...f, contact_name: e.target.value }))} placeholder="Pessoa de contato" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="E-mail" value={form.contact_email} onChange={(e) => setForm(f => ({ ...f, contact_email: e.target.value }))} />
            <Input label="Telefone" value={form.contact_phone} onChange={(e) => setForm(f => ({ ...f, contact_phone: e.target.value }))} />
          </div>
          <Input label="Instagram" value={form.social_instagram} onChange={(e) => setForm(f => ({ ...f, social_instagram: e.target.value }))} placeholder="handle sem @" />
          <Textarea label="Notas" value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Observações sobre a parceria..." />
        </div>
        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setFormOpen(false)}>Cancelar</Button>
          <Button onClick={handleSave} loading={saving} disabled={!form.name.trim()}>Salvar</Button>
        </div>
      </Modal>

      {/* Modal planejar reunião/ação */}
      <Modal isOpen={!!planFor} onClose={() => setPlanFor(null)} title={`Planejar com ${planFor?.name ?? ''}`} size="sm">
        <div className="space-y-3">
          <Select
            label="Tipo"
            value={plan.kind}
            onChange={(e) => setPlan(f => ({ ...f, kind: e.target.value as MarcoKind }))}
            options={[
              { value: 'reuniao_parceiro', label: '🤝 Reunião com parceiro' },
              { value: 'acao_parceiro', label: '✨ Ação com parceiro' },
            ]}
          />
          <Input label="Título *" value={plan.title} onChange={(e) => setPlan(f => ({ ...f, title: e.target.value }))} placeholder="Ex.: Planejamento da campanha trimestral" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Data *" type="date" value={plan.event_date} onChange={(e) => setPlan(f => ({ ...f, event_date: e.target.value }))} />
            <Input label="Hora" type="time" value={plan.event_time} onChange={(e) => setPlan(f => ({ ...f, event_time: e.target.value }))} />
          </div>
          <Select
            label="Responsável"
            value={plan.responsible_id}
            onChange={(e) => setPlan(f => ({ ...f, responsible_id: e.target.value }))}
            placeholder="Sem responsável"
            options={owners}
          />
        </div>
        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setPlanFor(null)}>Cancelar</Button>
          <Button onClick={handlePlan} loading={planning} disabled={!plan.title.trim() || !plan.event_date}>
            <CalendarClock className="w-3.5 h-3.5" />
            Planejar
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Loading() {
  return <p className="text-sm text-gray-400">Carregando...</p>;
}
