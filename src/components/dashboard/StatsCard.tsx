import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import Card from '@/components/ui/Card';

interface StatsCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  trend?: string;
  trendUp?: boolean;
  iconBg?: string;
  className?: string;
  onClick?: () => void;
}

export default function StatsCard({ icon: Icon, label, value, trend, trendUp, iconBg = 'bg-primary-50 text-primary-600', className, onClick }: StatsCardProps) {
  return (
    <Card
      padding="sm"
      hover={!!onClick}
      className={cn(className)}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center', iconBg)}>
          <Icon className="w-5 h-5" />
        </div>
        {trend && (
          <span className={cn(
            'text-xs font-medium px-1.5 py-0.5 rounded-full',
            trendUp ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
          )}>
            {trend}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold text-gray-900 mt-2 tabular-nums">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </Card>
  );
}
