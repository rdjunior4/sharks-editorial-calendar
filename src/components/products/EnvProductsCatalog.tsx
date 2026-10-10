import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import EmptyState from '@/components/ui/EmptyState';
import PageHeader from '@/components/ui/PageHeader';
import { useEnvProducts, type EnvProduct } from '@/hooks/useEnvProducts';
import type { CrmEnvironment } from '@/hooks/useLeads';
import { toast } from 'sonner';
import { Package, Plus, Search, Pencil, Archive, ArchiveRestore } from 'lucide-react';

const CATEGORIES = ['Serviço', 'Produto', 'Plano', 'Outro'];

/**
 * Catálogo da AGÊNCIA por ambiente (migration 065) — é deste catálogo
 * que os leads selecionam os produtos de interesse.
 */
export default function EnvProductsCatalog({ environment }: { environment: CrmEnvironment }) {
  const items = useEnvProducts(environment, false);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EnvProduct | null>(null);
  const [form, setForm] = useState({ name: '', description: '', category: 'Serviço' });
  const [saving, setSaving] = useState(false);

  useEffect(() => { setModalOpen(false); }, [environment]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q));
  }, [items, search]);

  const openNew = () => { setEditing(null); setForm({ name: '', description: '', category: 'Serviço' }); setModalOpen(true); };
  const openEdit = (p: EnvProduct) => { setEditing(p); setForm({ name: p.name, description: p.description ?? '', category: p.category ?? 'Serviço' }); setModalOpen(true); };

  const handleSave = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const payload = {
        environment,
        name: form.name.trim(),
        description: form.description.trim() || null,
        category: form.category,
      };
      const { error } = editing
        ? await supabase.from('environment_products').update(payload).eq('id', editing.id)
        : await supabase.from('environment_products').insert(payload);
      if (error) throw new Error(error.message);
      toast.success(editing ? 'Produto atualizado!' : 'Produto cadastrado!');
      setModalOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar produto');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (p: EnvProduct) => {
    const next = p.status === 'active' ? 'archived' : 'active';
    const { error } = await supabase.from('environment_products').update({ status: next }).eq('id', p.id);
    if (error) toast.error('Erro ao atualizar');
    else toast.success(next === 'active' ? 'Produto reativado' : 'Produto arquivado');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Catálogo do ambiente"
          subtitle="Serviços e produtos da agência — os leads selecionam o interesse daqui"
        />
        <Button onClick={openNew}>
          <Plus className="w-4 h-4" />
          Novo produto
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar produto..." className="pl-9" />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={Package}
            title="Nenhum produto no catálogo"
            description="Cadastre os serviços/produtos da agência para vincular ao interesse dos leads."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(p => (
            <Card key={p.id} className="flex items-center gap-3 p-3.5">
              <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                <Package className="w-5 h-5 text-primary-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900 truncate">{p.name}</p>
                  <Badge variant={p.status === 'active' ? 'success' : 'default'} size="sm">
                    {p.status === 'active' ? 'Ativo' : 'Arquivado'}
                  </Badge>
                  {p.category && <Badge variant="info" size="sm">{p.category}</Badge>}
                </div>
                {p.description && <p className="text-xs text-gray-500 truncate mt-0.5">{p.description}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => toggleStatus(p)}
                  className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors"
                  title={p.status === 'active' ? 'Arquivar' : 'Reativar'}
                >
                  {p.status === 'active' ? <Archive className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => openEdit(p)}
                  className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors"
                  title="Editar"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Modal cadastro/edição */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar produto' : 'Novo produto'} size="sm">
        <div className="space-y-4">
          <Input
            label="Nome"
            value={form.name}
            onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Ex: Tráfego pago"
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Categoria</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, category: c }))}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                    form.category === c ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <Input
            label="Descrição"
            value={form.description}
            onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Descrição opcional"
          />
        </div>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancelar</Button>
          <Button onClick={handleSave} loading={saving} disabled={!form.name.trim()}>Salvar</Button>
        </div>
      </Modal>
    </div>
  );
}
