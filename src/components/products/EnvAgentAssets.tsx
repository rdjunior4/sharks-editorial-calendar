import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import Badge from '@/components/ui/Badge';
import ChipMultiSelect from '@/components/ui/ChipMultiSelect';
import EmptyState from '@/components/ui/EmptyState';
import PageHeader from '@/components/ui/PageHeader';
import { useEnvProducts } from '@/hooks/useEnvProducts';
import { useSignedUrl } from '@/lib/prospecting/media';
import type { CrmEnvironment } from '@/hooks/useLeads';
import { toast } from 'sonner';
import { Trophy, Plus, Pencil, Trash2, Paperclip } from 'lucide-react';

type AssetType = 'prova_social' | 'portfolio' | 'case' | 'faq' | 'script';

const ASSET_TYPE_META: Record<AssetType, { label: string; badgeClass: string }> = {
  prova_social: { label: 'Prova social', badgeClass: 'bg-emerald-100 text-emerald-700' },
  portfolio:    { label: 'Portfólio',   badgeClass: 'bg-violet-100 text-violet-700' },
  case:         { label: 'Case',        badgeClass: 'bg-sky-100 text-sky-700' },
  faq:          { label: 'FAQ',         badgeClass: 'bg-amber-100 text-amber-700' },
  script:       { label: 'Script',      badgeClass: 'bg-gray-100 text-gray-600' },
};

export interface EnvAsset {
  id: string;
  environment: string;
  type: AssetType;
  title: string;
  content: string;
  file_url: string | null;
  created_at: string;
  products: Array<{ product: { id: string; name: string } }> | null;
}

const ASSET_SELECT = 'id, environment, type, title, content, file_url, created_at, products:environment_asset_products(product:environment_products(id, name))';

function syncAssetProducts(assetId: string, productIds: string[]): Promise<void> {
  return (async () => {
    const { error: delErr } = await supabase.from('environment_asset_products').delete().eq('asset_id', assetId);
    if (delErr) throw new Error(delErr.message);
    if (productIds.length > 0) {
      const { error: insErr } = await supabase
        .from('environment_asset_products')
        .insert(productIds.map(pid => ({ asset_id: assetId, product_id: pid })));
      if (insErr) throw new Error(insErr.message);
    }
  })();
}

async function uploadAssetFile(environment: string, file: File): Promise<string> {
  const path = `${environment}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, '_')}`;
  const { error } = await supabase.storage.from('agent-assets').upload(path, file, { upsert: false });
  if (error) throw new Error(`Upload falhou: ${error.message}`);
  return path; // bucket privado — armazena o path; signed URL na exibição
}

/** Link do material anexo — resolve path/legacy para signed URL (1h). */
function AssetFileLink({ fileUrl }: { fileUrl: string }) {
  const href = useSignedUrl(fileUrl, 'agent-assets');
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-[11px] text-primary-600 hover:underline mt-1 inline-flex items-center gap-1">
      <Paperclip className="w-3 h-3" /> Material anexo
    </a>
  );
}

/**
 * Assets de IA do ambiente (migration 075) — provas sociais, portfólio,
 * cases, FAQ e scripts vinculados aos produtos. O agente injeta no prompt
 * ao gerar mensagens para leads cuja campanha usa esses produtos.
 */
export default function EnvAgentAssets({ environment }: { environment: CrmEnvironment }) {
  const items = useEnvAssets(environment);
  const catalogProducts = useEnvProducts(environment);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EnvAsset | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<{ type: AssetType; title: string; content: string; product_ids: string[] }>(
    { type: 'case', title: '', content: '', product_ids: [] },
  );
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { setModalOpen(false); }, [environment]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => i.title.toLowerCase().includes(q) || i.content.toLowerCase().includes(q));
  }, [items, search]);

  const openNew = () => {
    setEditing(null);
    setForm({ type: 'case', title: '', content: '', product_ids: [] });
    setFile(null);
    setModalOpen(true);
  };
  const openEdit = (a: EnvAsset) => {
    setEditing(a);
    setForm({
      type: a.type,
      title: a.title,
      content: a.content,
      product_ids: (a.products ?? []).map(x => x.product?.id).filter((v): v is string => !!v),
    });
    setFile(null);
    setModalOpen(true);
  };

  const handleSave = useCallback(async () => {
    if (!form.title.trim() || !form.content.trim() || saving) return;
    setSaving(true);
    try {
      let fileUrl: string | null = editing?.file_url ?? null;
      if (file) fileUrl = await uploadAssetFile(environment, file);
      const payload = {
        environment,
        type: form.type,
        title: form.title.trim(),
        content: form.content.trim(),
        file_url: fileUrl,
      };
      let assetId: string;
      if (editing) {
        const { error } = await supabase.from('environment_assets').update(payload).eq('id', editing.id);
        if (error) throw new Error(error.message);
        assetId = editing.id;
      } else {
        const { data, error } = await supabase.from('environment_assets').insert(payload).select('id').single();
        if (error) throw new Error(error.message);
        assetId = data.id;
      }
      await syncAssetProducts(assetId, form.product_ids);
      toast.success(editing ? 'Asset atualizado!' : 'Asset criado! O agente usa este material nos prompts.');
      setModalOpen(false);
      setFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar asset');
    } finally {
      setSaving(false);
    }
  }, [form, saving, editing, file, environment]);

  const handleDelete = async (a: EnvAsset) => {
    try {
      const { error } = await supabase.from('environment_assets').delete().eq('id', a.id);
      if (error) throw new Error(error.message);
      toast.success('Asset excluído');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Assets de IA"
          subtitle="Provas sociais, portfólio, cases, FAQ e scripts — material que o agente injeta nas mensagens, por produto"
        />
        <Button onClick={openNew}>
          <Plus className="w-4 h-4" />
          Novo asset
        </Button>
      </div>

      <div className="relative max-w-sm">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar asset..."
          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 placeholder:text-gray-400"
        />
        <Paperclip className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={Trophy}
            title="Nenhum asset ainda"
            description="Cadastre provas sociais, cases, portfólio e FAQ — o agente cita este material nas abordagens relacionadas aos produtos vinculados."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(a => {
            const meta = ASSET_TYPE_META[a.type];
            return (
              <Card key={a.id} className="p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-900 truncate">{a.title}</p>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${meta.badgeClass}`}>{meta.label}</span>
                      {(a.products?.length ?? 0) > 0 && (
                        <span className="text-[11px] text-gray-400">
                          {a.products!.map(x => x.product?.name).filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-600 mt-1 line-clamp-2 whitespace-pre-wrap">{a.content}</p>
                    {a.file_url && <AssetFileLink fileUrl={a.file_url} />}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openEdit(a)}
                      className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors"
                      title="Editar"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(a)}
                      className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors"
                      title="Excluir"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal criar/editar asset */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar asset' : 'Novo asset de IA'} size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Select
              label="Tipo"
              value={form.type}
              onChange={(e) => setForm(f => ({ ...f, type: e.target.value as AssetType }))}
              options={Object.entries(ASSET_TYPE_META).map(([value, m]) => ({ value, label: m.label }))}
            />
            <Input
              label="Título"
              value={form.title}
              onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Ex.: Case Bar do Zé — +340% leads"
              className="sm:col-span-2"
            />
          </div>
          <Textarea
            label="Conteúdo (o que o agente pode citar)"
            value={form.content}
            onChange={(e) => setForm(f => ({ ...f, content: e.target.value }))}
            placeholder="Ex.: Em 3 meses, o Bar do Zé saltou de 40 para 172 leads/mês com tráfego local. Avaliação média 4,9 no Google..."
            rows={5}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Arquivo (opcional)</label>
            <div className="flex items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.mp4,.doc,.docx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-xs text-gray-500 file:mr-3 file:px-3 file:py-1.5 file:text-xs file:font-medium file:rounded-lg file:border-0 file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
              />
              {file && <Badge variant="info" size="sm">{file.name.slice(0, 24)}</Badge>}
            </div>
            {editing?.file_url && !file && (
              <p className="text-[11px] text-gray-400 mt-1">
                Já existe material anexo — enviar novo substitui.
              </p>
            )}
          </div>
          <ChipMultiSelect
            label="Produtos relacionados"
            options={catalogProducts.map(p => ({ id: p.id, name: p.name }))}
            values={form.product_ids}
            onChange={(ids) => setForm(f => ({ ...f, product_ids: ids }))}
            placeholder="Vincular aos produtos..."
            emptyMessage="Nenhum produto no catálogo"
          />
        </div>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancelar</Button>
          <Button onClick={handleSave} loading={saving} disabled={!form.title.trim() || !form.content.trim()}>
            Salvar
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/* ─── Hook: assets do ambiente (com realtime leve) ─── */
function useEnvAssets(environment: CrmEnvironment): EnvAsset[] {
  const [assets, setAssets] = useState<EnvAsset[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('environment_assets')
        .select(ASSET_SELECT)
        .eq('environment', environment)
        .order('created_at', { ascending: false });
      if (!active) return;
      if (error) {
        console.error('[assets] load:', error.message);
        return;
      }
      setAssets(((data ?? []) as unknown) as EnvAsset[]);
    };
    load();
    const channel = supabase
      .channel(`env-assets-${environment}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'environment_assets' }, () => { load(); })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return assets;
}
