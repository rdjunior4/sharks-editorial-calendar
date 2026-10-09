import PageHeader from '@/components/ui/PageHeader';
import { useState } from 'react';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import WorkspaceLogo from '@/components/ui/WorkspaceLogo';
import ClientWizard from '@/components/clients/ClientWizard';
import ClientEditModal, { type ClientEditTarget } from '@/components/clients/ClientEditModal';
import { deactivateClient } from '@/lib/clientFactory';
import { toast } from 'sonner';
import { Plus, Building2, MapPin, ChevronRight, Pencil, Trash2 } from 'lucide-react';

export default function SharksClients() {
  const { workspacesByEnv, setCurrentWorkspace, refreshWorkspaces } = useWorkspace();
  const workspaces = workspacesByEnv('sharks_company');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<ClientEditTarget | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (wsId: string, wsName: string) => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deactivateClient(wsId);
      await refreshWorkspaces();
      toast.success(`Cliente "${wsName}" removido.`);
      setDeleteConfirm(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover cliente');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader
          title="Clientes"
          subtitle="Gerencie os workspaces de cada cliente"
        />
        <Button onClick={() => setWizardOpen(true)}>
          <Plus className="w-4 h-4" />
          Novo cliente
        </Button>
      </div>

      {workspaces.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="Nenhum cliente cadastrado"
            description="Crie seu primeiro workspace para começar a planejar."
            action={<Button onClick={() => setWizardOpen(true)}>+ Novo cliente</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500">
              {workspaces.length} cliente{workspaces.length !== 1 ? 's' : ''} ativo{workspaces.length !== 1 ? 's' : ''}
            </span>
            <span className="flex-1 h-px bg-gray-100" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {workspaces.map(ws => {
              const location = [ws.city, ws.state].filter(Boolean).join(', ');
              const segment = (ws.segment ?? '').trim();
              return (
                <Card
                  key={ws.id}
                  className="relative group transition-all duration-200 hover:shadow-lg hover:shadow-gray-200/70 hover:border-primary-200"
                >
                  <div
                    className="flex items-top gap-3.5 cursor-pointer rounded-xl"
                    onClick={() => { setCurrentWorkspace(ws); window.location.hash = '#/sharks/calendar'; }}
                  >
                    <div className="rounded-xl ring-1 ring-black/5 shadow-sm overflow-hidden shrink-0">
                      <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size="lg" />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <h3 className="font-semibold text-gray-900 leading-tight group-hover:text-primary-700 transition-colors">
                        {ws.name}
                      </h3>
                      {segment ? (
                        <span className="mt-1.5 inline-block px-2 py-0.5 rounded-full bg-gray-50 border border-gray-100 text-[11px] font-medium text-gray-600">
                          {segment}
                        </span>
                      ) : (
                        <span className="mt-1.5 inline-block px-2 py-0.5 rounded-full bg-gray-50 border border-dashed border-gray-200 text-[11px] text-gray-400">
                          Sem segmento
                        </span>
                      )}
                      <p className="text-xs text-gray-400 flex items-center gap-1 mt-2">
                        <MapPin className="w-3 h-3 text-gray-300" />
                        {location || 'Localização não informada'}
                      </p>
                    </div>
                    <span className="w-6 h-6 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center shrink-0 transition-all duration-200 group-hover:bg-primary-50 group-hover:border-primary-200">
                      <ChevronRight className="w-3.5 h-3.5 text-gray-300 transition-all duration-200 group-hover:text-primary-500 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                  {/* Action buttons */}
                  <div className="absolute top-2 right-2 flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing({
                          id: ws.id,
                          name: ws.name,
                          segment: ws.segment,
                          city: ws.city,
                          state: ws.state,
                          logo_url: ws.logo_url,
                        });
                      }}
                      className="p-1.5 rounded-lg bg-white/90 backdrop-blur border border-gray-200 text-gray-500 hover:text-primary-600 hover:border-primary-200 hover:bg-primary-50 transition-colors shadow-sm"
                      title="Editar"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(ws.id); }}
                      className="p-1.5 rounded-lg bg-white/90 backdrop-blur border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors shadow-sm"
                      title="Excluir"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* Onboarding Wizard completo (linha editorial, frequência, datas e Google Calendar) */}
      <ClientWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        environment="sharks_company"
        onCreated={() => { refreshWorkspaces(); }}
      />

      {/* Edit Client */}
      <ClientEditModal
        open={!!editing}
        onClose={() => setEditing(null)}
        client={editing}
        onSaved={() => { refreshWorkspaces(); }}
      />

      {/* Delete Confirmation Modal */}
      <Modal isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Excluir Cliente" size="sm">
        <p className="text-sm text-gray-600">
          Tem certeza que deseja excluir <strong>{workspaces.find(w => w.id === deleteConfirm)?.name}</strong>?
        </p>
        <p className="text-xs text-gray-400 mt-2">
          Esta ação irá desativar o cliente. Os dados não serão apagados permanentemente.
        </p>
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>Cancelar</Button>
          <Button
            variant="danger"
            onClick={() => {
              const ws = workspaces.find(w => w.id === deleteConfirm);
              if (ws) handleDelete(ws.id, ws.name);
            }}
            loading={deleting}
          >
            Excluir
          </Button>
        </div>
      </Modal>
    </div>
  );
}