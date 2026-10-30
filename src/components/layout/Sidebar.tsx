import { useState } from 'react'
import { MoreHorizontal, X } from 'lucide-react'

import {
  mobileNavigationItems,
  mobileMoreNavigationItems,
  navigationGroups,
  type AppPage,
  type NavigationItem,
} from '../../types/navigation'

type NavigationProps = {
  activePage: AppPage
  onNavigate: (page: AppPage) => void
}

const mobileLabels: Partial<Record<AppPage, string>> = {
  Dashboard: 'Home',
  Properties: 'Property',
  Rooms: 'Room',
  Meters: 'Meter',
  Tenants: 'Tenant',
  Payments: 'Pay',
  Settings: 'Setting',
  Note: 'Note',
  'Users & Access': 'Users',
  'Opening Balance': 'Opening',
}

function NavigationButton({
  item,
  activePage,
  onNavigate,
  mobile = false,
}: {
  item: NavigationItem
  activePage: AppPage
  onNavigate: (page: AppPage) => void
  mobile?: boolean
}) {
  const Icon = item.icon
  const active = activePage === item.label

  const label = mobile
    ? mobileLabels[item.label] ?? item.label
    : item.label

  return (
    <button
      type="button"
      className={[
        mobile ? 'mobile-nav-link' : 'nav-link',
        active ? 'is-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => onNavigate(item.label)}
      aria-current={active ? 'page' : undefined}
      title={mobile ? item.label : undefined}
    >
      <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

export function Sidebar({
  activePage,
  onNavigate,
}: NavigationProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <img src="/icon-192.png" alt="T&N House's" />
        </div>

        <div className="brand-copy">
          <strong>T&N House's</strong>
          <span>PROPERTY MANAGEMENT</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        {navigationGroups.map((group) => (
          <section className="nav-group" key={group.title}>
            <p className="nav-group-label">{group.title}</p>

            {group.items.map((item) => (
              <NavigationButton
                key={item.label}
                item={item}
                activePage={activePage}
                onNavigate={onNavigate}
              />
            ))}
          </section>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="workspace-avatar">T&amp;N</div>

        <div className="workspace-copy">
          <span>Shared Property Workspace</span>

          <strong className="workspace-owner-name">
            MD.Tofazzal Hossain
          </strong>
          <strong className="workspace-owner-name">
            MST. Nilufa Yaeasmin
          </strong>
        </div>
      </div>
    </aside>
  )
}

export function MobileNavigation({
  activePage,
  onNavigate,
}: NavigationProps) {
  const [moreOpen, setMoreOpen] = useState(false)

  const activePageIsInMoreMenu =
    mobileMoreNavigationItems.some(
      (item) => item.label === activePage,
    )

  function navigateTo(page: AppPage) {
    onNavigate(page)
    setMoreOpen(false)
  }

  return (
    <nav
      className="mobile-bottom-nav"
      aria-label="Mobile navigation"
    >
      {mobileNavigationItems.map((item) => (
        <NavigationButton
          key={item.label}
          item={item}
          activePage={activePage}
          onNavigate={navigateTo}
          mobile
        />
      ))}

      <button
        type="button"
        className={[
          'mobile-nav-link',
          'mobile-nav-more',
          moreOpen || activePageIsInMoreMenu
            ? 'is-active'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => setMoreOpen((current) => !current)}
        aria-expanded={moreOpen}
        aria-controls="mobile-more-menu"
      >
        {moreOpen ? (
          <X size={19} aria-hidden="true" />
        ) : (
          <MoreHorizontal size={19} aria-hidden="true" />
        )}

        <span>{moreOpen ? 'Close' : 'More'}</span>
      </button>

      <div
        id="mobile-more-menu"
        className="mobile-nav-more-panel"
        hidden={!moreOpen}
      >
        <p className="mobile-nav-more-heading">
          ALL MODULES
        </p>

        {mobileMoreNavigationItems.map((item) => (
          <NavigationButton
            key={item.label}
            item={item}
            activePage={activePage}
            onNavigate={navigateTo}
            mobile
          />
        ))}
      </div>
    </nav>
  )
}