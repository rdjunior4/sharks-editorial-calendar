import { cn } from '@/lib/utils';

export type CrossEnv = 'sharks_company' | 'estrategos';

/** Alternador de ambiente para as páginas centrais do Oracullo (god-view guardian). */
export default function EnvSwitcher({ value, onChange }: { value: CrossEnv; onChange: (v: CrossEnv) => void }) {
  const items: Array<{ key: CrossEnv; label: string }> = [
    { key: 'sharks_company', label: 'Sharks Company' },
    { key: 'estrategos', label: 'Estratégos' },
  ];
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-gray-100 p-1">
      {items.map(it => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={cn(
            'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            value === it.key ? 'bg-white text-primary-700 shadow-sm' : 'text-gray-500 hover:text-gray-700',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
