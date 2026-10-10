import PageHeader from '@/components/ui/PageHeader';
import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import Card, { CardHeader, CardTitle } from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import AvatarUploader from '@/components/ui/AvatarUploader';
import Badge from '@/components/ui/Badge';
import Switch from '@/components/ui/Switch';
import { USER_ROLES } from '@/lib/constants';
import { getNotifPrefs, setNotifPrefs, type NotifPrefs } from '@/lib/notificationPrefs';
import { toast } from 'sonner';
import {
  Settings as SettingsIcon,
  User as UserIcon,
  Shield,
  Lock,
  Bell,
  LogOut,
  Loader2,
  Save,
  Check,
} from 'lucide-react';

export default function SharksSettings() {
  const { user, signOut, refreshProfile } = useAuth();

  // perfil
  const [name, setName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  // senha
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // preferencias
  const [prefs, setPrefs] = useState<NotifPrefs>(getNotifPrefs());

  useEffect(() => {
    setName(user?.full_name ?? '');
    setAvatarUrl(user?.avatar_url || null);
    setPrefs(getNotifPrefs());
  }, [user?.id, user?.full_name, user?.avatar_url]);

  const savePrefs = (next: NotifPrefs) => {
    setPrefs(next);
    setNotifPrefs(next);
  };

  const handleSaveProfile = async () => {
    if (!name.trim()) {
      toast.error('O nome não pode ficar vazio');
      return;
    }
    setSavingProfile(true);
    const { error } = await supabase
      .from('users')
      .update({ full_name: name.trim(), avatar_url: avatarUrl })
      .eq('id', user!.id);
    setSavingProfile(false);
    if (error) {
      toast.error(`Erro ao salvar: ${error.message}`);
    } else {
      await refreshProfile();
      toast.success('Perfil atualizado!');
    }
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      toast.error('A senha deve ter no mínimo 6 caracteres');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('As senhas não conferem');
      return;
    }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) {
      toast.error(`Erro ao trocar senha: ${error.message}`);
    } else {
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Senha alterada com sucesso!');
    }
  };

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Configurações" subtitle="Preferências da sua conta" />

      {/* Perfil */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserIcon className="w-4 h-4 text-primary-500" />
            Perfil
          </CardTitle>
          <Badge variant="primary" className="flex items-center gap-1">
            <Shield className="w-3 h-3" />
            {USER_ROLES[user?.role || 'client']}
          </Badge>
        </CardHeader>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-4">
          <AvatarUploader name={name || 'U'} avatarUrl={avatarUrl} userId={user?.id || ''} onChange={setAvatarUrl} size="lg" />
          <div className="flex-1 w-full space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Nome completo</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Seu nome" />
            </div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">{user?.email}</p>
              <Button size="sm" onClick={handleSaveProfile} disabled={savingProfile || (name === (user?.full_name ?? '') && (avatarUrl ?? '') === (user?.avatar_url ?? ''))}>
                {savingProfile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Seguranca */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-primary-500" />
            Segurança
          </CardTitle>
        </CardHeader>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Nova senha</label>
            <Input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Mínimo 6 caracteres" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Confirmar senha</label>
            <Input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Repita a senha" />
          </div>
          <Button onClick={handleChangePassword} disabled={savingPassword || !newPassword || !confirmPassword}>
            {savingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
            Trocar senha
          </Button>
        </div>
      </Card>

      {/* Notificacoes */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-primary-500" />
            Notificações
          </CardTitle>
        </CardHeader>
        <div className="space-y-2">
          <Switch
            checked={prefs.chat}
            onChange={v => savePrefs({ ...prefs, chat: v })}
            label="Mensagens do chat"
            description="Avisar quando clientes ou a equipe enviarem mensagens"
          />
          <Switch
            checked={prefs.overdue}
            onChange={v => savePrefs({ ...prefs, overdue: v })}
            label="Ações atrasadas"
            description="Alertar sobre ações que passaram da data sem publicação"
          />
          <Switch
            checked={prefs.sync}
            onChange={v => savePrefs({ ...prefs, sync: v })}
            label="Sincronização Google Calendar"
            description="Avisar sobre falhas de sincronização com a agenda"
          />
        </div>
        <p className="text-[11px] text-gray-400 mt-3 flex items-center gap-1">
          <Check className="w-3 h-3 text-emerald-500" />
          Preferências salvas automaticamente neste dispositivo
        </p>
      </Card>

      {/* Sessao */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogOut className="w-4 h-4 text-primary-500" />
            Sessão
          </CardTitle>
        </CardHeader>
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">Encerrar a sessão e voltar para o login</p>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            <LogOut className="w-4 h-4" />
            Sair da conta
          </Button>
        </div>
      </Card>

      {/* Conta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="w-4 h-4 text-primary-500" />
            Conta
          </CardTitle>
        </CardHeader>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between py-2 border-b border-gray-50">
            <span className="text-gray-500">Modo de dados</span>
            <span className="text-emerald-600 font-medium">Supabase (produção)</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-50">
            <span className="text-gray-500">Autenticação</span>
            <span className="text-emerald-600 font-medium">Supabase Auth + RLS</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-50">
            <span className="text-gray-500">Tempo real</span>
            <span className="text-emerald-600 font-medium">Ativo (calendário, chat, campanhas)</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-50">
            <span className="text-gray-500">Versão</span>
            <span className="text-gray-900 font-medium">1.0.0 MVP</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
