import {
  LayoutDashboard,
  Calendar,
  Users,
  Megaphone,
  BookOpen,
  LayoutTemplate,
  History,
  MessageSquare,
  Link2,
  Settings,
  UserCog,
  UserPlus,
  Briefcase,
  Rocket,
  ShieldCheck,
  CalendarDays,
  Building2,
  Target,
  Package,
  Telescope,
  Bot,
  MessagesSquare,
  Handshake,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  icon: LucideIcon;
  label: string;
  shortLabel?: string;
  path: string;
  adminOnly?: boolean;
}

export interface NavSection {
  /** Rótulo da seção — omitido para não exibir cabeçalho */
  label?: string;
  items: NavItem[];
}

export function flattenNav(sections: NavSection[]): NavItem[] {
  return sections.flatMap(s => s.items);
}

/* ─── Sharks Company ─── */
export const SHARKS_NAV: NavSection[] = [
  {
    label: 'Operação',
    items: [
      { icon: LayoutDashboard, label: 'Visão Geral', path: '/sharks' },
      { icon: Calendar, label: 'Calendário', path: '/sharks/calendar' },
      { icon: History, label: 'Histórico', path: '/sharks/history' },
    ],
  },
  {
    label: 'Marketing',
    items: [
      { icon: Megaphone, label: 'Campanhas', path: '/sharks/campaigns' },
      { icon: BookOpen, label: 'Linha Editorial', path: '/sharks/editorial' },
      { icon: Package, label: 'Produtos', path: '/sharks/products' },
    ],
  },
  {
    label: 'Comercial',
    items: [
      { icon: Target, label: 'CRM', path: '/sharks/crm' },
      { icon: Telescope, label: 'Prospecção IA', path: '/sharks/prospeccao' },
      { icon: Handshake, label: 'Parceiros', path: '/sharks/parceiros' },
      { icon: Users, label: 'Clientes', path: '/sharks/clients' },
    ],
  },
  {
    label: 'Comunicação',
    items: [
      { icon: MessageSquare, label: 'Chat', path: '/sharks/chat' },
    ],
  },
  {
    label: 'Administração',
    items: [
      { icon: UserCog, label: 'Time', path: '/sharks/team' },
      { icon: UserPlus, label: 'Acessos', path: '/sharks/access-requests', adminOnly: true },
      { icon: Link2, label: 'Integrações', path: '/sharks/integrations' },
      { icon: Settings, label: 'Configurações', path: '/sharks/settings' },
    ],
  },
];

/* ─── Cliente ─── */
export const CLIENT_NAV: NavSection[] = [
  {
    items: [
      { icon: LayoutDashboard, label: 'Início', path: '/client' },
      { icon: Calendar, label: 'Calendário', path: '/client/calendar' },
      { icon: MessageSquare, label: 'Chat', path: '/client/chat' },
      { icon: History, label: 'Histórico', path: '/client/history' },
      { icon: Link2, label: 'Integrações', path: '/client/integrations' },
    ],
  },
];

/* ─── Estrategos ─── */
export const ESTRATEGOS_NAV: NavSection[] = [
  {
    label: 'Operação',
    items: [
      { icon: LayoutDashboard, label: 'Visão Geral', path: '/estrategos' },
      { icon: Calendar, label: 'Calendário', path: '/estrategos/calendar' },
    ],
  },
  {
    label: 'Projetos',
    items: [
      { icon: Briefcase, label: 'Projetos', path: '/estrategos/projects' },
      { icon: CalendarDays, label: 'Reuniões', path: '/estrategos/meetings' },
      { icon: Rocket, label: 'Implementações', shortLabel: 'Impl.', path: '/estrategos/implementations' },
    ],
  },
  {
    label: 'Comercial',
    items: [
      { icon: Target, label: 'CRM', path: '/estrategos/crm' },
      { icon: Telescope, label: 'Prospecção IA', path: '/estrategos/prospeccao' },
      { icon: Package, label: 'Produtos', path: '/estrategos/products' },
      { icon: Handshake, label: 'Parceiros', path: '/estrategos/parceiros' },
      { icon: Users, label: 'Clientes', path: '/estrategos/clients', adminOnly: true },
    ],
  },
  {
    label: 'Comunicação',
    items: [
      { icon: MessageSquare, label: 'Chat', path: '/estrategos/chat' },
    ],
  },
  {
    label: 'Administração',
    items: [
      { icon: UserCog, label: 'Time', path: '/estrategos/team' },
      { icon: UserPlus, label: 'Acessos', path: '/estrategos/access-requests', adminOnly: true },
      { icon: Link2, label: 'Integrações', path: '/estrategos/integrations' },
    ],
  },
];

/* ─── Oracullo (guardião) ─── */
export const ORACULLO_NAV: NavSection[] = [
  {
    items: [
      { icon: LayoutDashboard, label: 'Visão Geral', path: '/oracullo' },
      { icon: Target, label: 'CRM', path: '/oracullo/crm' },
      { icon: ShieldCheck, label: 'Acessos', path: '/oracullo/access' },
      { icon: UserPlus, label: 'Solicitações', path: '/oracullo/access-requests' },
      { icon: Users, label: 'Usuários', path: '/oracullo/users' },
      { icon: UserCog, label: 'Time', path: '/oracullo/team' },
      { icon: Building2, label: 'Clientes', path: '/oracullo/clients' },
    ],
  },
];

export const SHARKS_BOTTOM_PATHS = [
  '/sharks',
  '/sharks/calendar',
  '/sharks/clients',
  '/sharks/chat',
];

export const CLIENT_BOTTOM_PATHS = [
  '/client',
  '/client/calendar',
  '/client/history',
  '/client/chat',
  '/client/integrations',
];

export const ESTRATEGOS_BOTTOM_PATHS = [
  '/estrategos',
  '/estrategos/calendar',
  '/estrategos/meetings',
  '/estrategos/implementations',
  '/estrategos/projects',
  '/estrategos/chat',
];

export const ORACULLO_BOTTOM_PATHS = [
  '/oracullo',
  '/oracullo/access',
  '/oracullo/clients',
  '/oracullo/users',
];

export const ROOT_PATHS = ['/sharks', '/client', '/estrategos', '/oracullo'];
