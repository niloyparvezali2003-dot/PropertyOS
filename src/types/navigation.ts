import {
  BookOpen,
  Building2,
  DoorOpen,
  Download,
  FileText,
  Gauge,
  History,
  LayoutDashboard,
  ReceiptText,
  Settings,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export type AppPage =
  | 'Dashboard'
  | 'Properties'
  | 'Rooms'
  | 'Tenants'
  | 'Meters'
  | 'Rent & Bills'
  | 'Electricity'
  | 'Payments'
  | 'Ledgers'
  | 'Reports'
  | 'History'
  | 'Backup'
  | 'Settings'

export type NavigationItem = {
  label: AppPage
  icon: LucideIcon
}

export const navigationGroups: {
  title: string
  items: NavigationItem[]
}[] = [
    {
      title: 'WORKSPACE',
      items: [
        { label: 'Dashboard', icon: LayoutDashboard },
        { label: 'Properties', icon: Building2 },
        { label: 'Rooms', icon: DoorOpen },
        { label: 'Meters', icon: Gauge },
        { label: 'Tenants', icon: Users },
      ],
    },
    {
      title: 'FINANCE',
      items: [
        { label: 'Rent & Bills', icon: ReceiptText },
        { label: 'Electricity', icon: Zap },
        { label: 'Payments', icon: Wallet },
        { label: 'Ledgers', icon: BookOpen },
        { label: 'Reports', icon: FileText },
      ],
    },
    {
      title: 'MANAGEMENT',
      items: [
        { label: 'History', icon: History },
        { label: 'Backup', icon: Download },
        { label: 'Settings', icon: Settings },
      ],
    },
  ]

const mobilePrimaryPages = new Set<AppPage>([
  'Dashboard',
  'Properties',
  'Tenants',
  'Payments',
])

const allNavigationItems = navigationGroups.flatMap(
  (group) => group.items,
)

export const mobileNavigationItems =
  allNavigationItems.filter(
    (item) => mobilePrimaryPages.has(item.label),
  )

export const mobileMoreNavigationItems =
  allNavigationItems.filter(
    (item) => !mobilePrimaryPages.has(item.label),
  )