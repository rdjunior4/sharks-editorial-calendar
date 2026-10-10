import PageHeader from '@/components/ui/PageHeader';
import { useEffect, useState } from 'react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import Badge from '@/components/ui/Badge';
import { supabase } from '@/lib/supabase';
import { ENVIRONMENT_META, type User, type EnvironmentType } from '@/types';
import { formatDate } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface Row {
  user_id: string;
  environment: EnvironmentType;
}

export default function OraculloUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [access, setAccess] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const [u, a] = await Promise.all([
        supabase.from('users').select('*').order('created_at', { ascending: false }),
        supabase.from('user_environments').select('user_id, environment'),
      ]);
      setUsers((u.data as unknown as User[]) ?? []);
      setAccess((a.data as unknown as Row[]) ?? []);
      setLoading(false);
    };
    load();
    const channel = supabase
      .channel('oracullo-users')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_environments' }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const envsOf = (userId: string) => access.filter(a => a.user_id === userId).map(a => a.environment);

  const ROLE_LABEL: Record<string, string> = {
    oracullo_admin: 'Oracullo',
    admin_sharks: 'Admin Sharks',
    sharks_team: 'Time Sharks',
    client: 'Cliente',
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Usuários" subtitle="Todos os usuários da plataforma Oracullo" />

      <Card>
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 text-primary-500 animate-spin" /></div>
        ) : (
          <div className="divide-y divide-gray-100">
            {users.map(u => {
              const envs = envsOf(u.id);
              return (
                <div key={u.id} className="flex items-center justify-between gap-4 py-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={u.full_name} src={u.avatar_url} size="md" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{u.full_name}</p>
                      <p className="text-xs text-gray-500 truncate">{u.email} · desde {formatDate(u.created_at)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {envs.length > 0 ? envs.map(env => (
                      <span key={env} className="px-2 py-1 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-600">
                        {ENVIRONMENT_META[env].emoji} {ENVIRONMENT_META[env].short}
                      </span>
                    )) : (
                      <span className="px-2 py-1 rounded-lg border border-dashed border-gray-200 text-xs text-gray-300">sem ambiente</span>
                    )}
                    <Badge variant={u.role === 'oracullo_admin' ? 'purple' : 'default'} size="sm">
                      {ROLE_LABEL[u.role] ?? u.role}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
