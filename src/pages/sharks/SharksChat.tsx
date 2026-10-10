import PageHeader from '@/components/ui/PageHeader';
import { useState, useEffect } from 'react';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useAuth } from '@/contexts/AuthContext';
import { useChat } from '@/hooks/useChat';
import { useChatUnread } from '@/hooks/useChatUnread';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import ChatPanel from '@/components/chat/ChatPanel';
import WorkspaceLogo from '@/components/ui/WorkspaceLogo';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';
import { MessageType } from '@/types';
import { MessageSquare, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';

export default function SharksChat() {
  const { user } = useAuth();
  const { workspacesByEnv, currentWorkspace } = useWorkspace();
  const workspaces = workspacesByEnv('sharks_company');
  const { isMobile } = useBreakpoint();
  const [selectedWsId, setSelectedWsId] = useState<string>(currentWorkspace?.id || '');
  const [showWsList, setShowWsList] = useState(false);

  const activeWsId = selectedWsId || currentWorkspace?.id;
  const { messages, send, loading, threadId } = useChat(activeWsId, user);
  const { counts, markRead } = useChatUnread(user?.id);
  const selectedWs = workspaces.find(w => w.id === activeWsId);

  useEffect(() => {
    if (!threadId || !activeWsId || loading) return;
    const hasUnreadIncoming = messages.some(m => m.sender.id !== user?.id && m.status !== 'read');
    if (hasUnreadIncoming) markRead(threadId, activeWsId);
  }, [threadId, activeWsId, messages, loading, markRead, user?.id]);

  const handleSend = async (content: string, type: MessageType) => {
    if (!activeWsId || !user) return;
    const ok = await send(content, type);
    if (!ok) toast.error('Não foi possível enviar a mensagem.');
  };

  const handleSelectWs = (wsId: string) => {
    setSelectedWsId(wsId);
    setShowWsList(false);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4 lg:space-y-6">
      <PageHeader title="Chat" subtitle="Converse com os clientes em tempo real" />

      {isMobile && (
        <div className="relative">
          <button
            onClick={() => setShowWsList(!showWsList)}
            className="w-full flex items-center justify-between gap-2 p-3 bg-white border border-gray-200 rounded-lg text-left"
          >
            <div className="flex items-center gap-2 min-w-0">
              {selectedWs ? (
                <>
                  <WorkspaceLogo name={selectedWs.name} logoUrl={selectedWs.logo_url} size="sm" />
                  <span className="text-sm font-medium text-gray-900 truncate">{selectedWs.name}</span>
                  {counts[selectedWs.id] > 0 && (
                    <Badge variant="primary" size="sm">{counts[selectedWs.id]}</Badge>
                  )}
                </>
              ) : (
                <span className="text-sm text-gray-500">Selecione um cliente</span>
              )}
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showWsList ? 'rotate-180' : ''}`} />
          </button>
          {showWsList && (
            <div className="absolute top-full left-0 right-0 z-10 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
              {workspaces.map(ws => (
                <button
                  key={ws.id}
                  onClick={() => handleSelectWs(ws.id)}
                  className={`w-full flex items-center gap-3 p-3 text-left hover:bg-gray-50 transition-colors ${
                    activeWsId === ws.id ? 'bg-primary-50' : ''
                  }`}
                >
                  <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size="sm" />
                  <span className="text-sm font-medium text-gray-900 truncate flex-1">{ws.name}</span>
                  {counts[ws.id] > 0 && <Badge variant="primary" size="sm">{counts[ws.id]}</Badge>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3  gap-4 flex-1 min-h-0">
        {!isMobile && (
          <Card padding="sm" className="lg:col-span-1 h-full flex flex-col min-h-0 overflow-hidden">
            <h3 className="font-semibold text-gray-900 mb-3 px-2 shrink-0">Clientes</h3>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
              {workspaces.map(ws => {
                const wsMessages = messages;
                const lastMessage = activeWsId === ws.id ? wsMessages[wsMessages.length - 1] : null;
                return (
                  <button
                    key={ws.id}
                    onClick={() => setSelectedWsId(ws.id)}
                    className={`w-full flex items-center gap-3 p-2 rounded-lg transition-colors ${
                      activeWsId === ws.id ? 'bg-primary-50 border border-primary-200' : 'hover:bg-gray-50 border border-transparent'
                    }`}
                  >
                    <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size="md" />
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium text-gray-900 truncate">{ws.name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {activeWsId === ws.id && lastMessage
                          ? `${lastMessage.sender.full_name}: ${lastMessage.content}`
                          : 'Clique para abrir a conversa'}
                      </p>
                    </div>
                    {counts[ws.id] > 0 && (
                      <span className="shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center text-[11px] font-semibold text-white bg-primary-500 rounded-full">
                        {counts[ws.id]}
                      </span>
                    )}
                  </button>
                );
              })}
              {workspaces.length === 0 && (
                <p className="text-sm text-gray-500 px-2 py-4">Nenhum cliente cadastrado.</p>
              )}
            </div>
          </Card>
        )}

        <div className="lg:col-span-2 h-full min-h-0">
          {!activeWsId ? (
            <Card padding="sm" className="h-full flex items-center justify-center">
              <EmptyState
                icon={MessageSquare}
                title="Selecione um cliente"
                description="Escolha um cliente na lista para ver a conversa."
              />
            </Card>
          ) : (
            <ChatPanel
              key={activeWsId}
              messages={messages}
              currentUser={user!}
              onSendMessage={handleSend}
              loading={loading}
              title={workspaces.find(w => w.id === activeWsId)?.name || ''}
              subtitle={
                <span className="inline-flex items-center gap-1.5">
                  <Badge variant="success">Online</Badge>
                  <span>Resposta rápida em horário comercial · Tempo real</span>
                </span>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
