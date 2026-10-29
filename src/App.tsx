import {
  lazy,
  Suspense,
  useEffect,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { User } from 'firebase/auth'
import { Building2, LogOut } from 'lucide-react'

import {
  MobileNavigation,
  Sidebar,
} from './components/layout/Sidebar'

import { LoginPage } from './components/auth/LoginPage'

const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((m) => ({
    default: m.DashboardPage,
  })),
)

const PropertiesPage = lazy(() =>
  import('./pages/PropertiesPage').then((m) => ({
    default: m.PropertiesPage,
  })),
)

const RoomsPage = lazy(() =>
  import('./pages/RoomsPage').then((m) => ({
    default: m.RoomsPage,
  })),
)

const TenantsPage = lazy(() =>
  import('./pages/TenantsPage').then((m) => ({
    default: m.TenantsPage,
  })),
)

const MetersPage = lazy(() =>
  import('./pages/MetersPage').then((m) => ({
    default: m.MetersPage,
  })),
)

const RentBillsPage = lazy(() =>
  import('./pages/RentBillsPage').then((m) => ({
    default: m.RentBillsPage,
  })),
)

const ElectricityPage = lazy(() =>
  import('./pages/ElectricityPage').then((m) => ({
    default: m.ElectricityPage,
  })),
)

const PaymentsPage = lazy(() =>
  import('./pages/PaymentsPage').then((m) => ({
    default: m.PaymentsPage,
  })),
)

const LedgersPage = lazy(() =>
  import('./pages/LedgersPage').then((m) => ({
    default: m.LedgersPage,
  })),
)

const FinancialReportsPage = lazy(() =>
  import('./pages/FinancialReportsPage').then((m) => ({
    default: m.FinancialReportsPage,
  })),
)

const HistoryPage = lazy(() =>
  import('./pages/HistoryPage').then((m) => ({
    default: m.HistoryPage,
  })),
)

const BackupPage = lazy(() =>
  import('./pages/BackupPage').then((m) => ({
    default: m.BackupPage,
  })),
)

const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({
    default: m.SettingsPage,
  })),
)

const ModulePlaceholder = lazy(() =>
  import('./pages/ModulePlaceholder').then((m) => ({
    default: m.ModulePlaceholder,
  })),
)

import {
  observeAuthState,
  signOutCurrentUser,
} from './services/firebase/auth'

import type { AppPage } from './types/navigation'

type StatusCardProps = {
  title: string
  message: string
  detail?: string
  action?: ReactNode
}

function StatusCard({
  title,
  message,
  detail,
  action,
}: StatusCardProps) {
  return (
    <main className="auth-screen">
      <section className="auth-card auth-status-card">
        <div className="auth-brand">
          <span className="brand-mark">
            <Building2 size={24} aria-hidden="true" />
          </span>

          <div>
            <strong>PropertyOS</strong>
            <span>PROPERTY MANAGEMENT</span>
          </div>
        </div>

        <h1>{title}</h1>
        <p className="auth-status-message">{message}</p>

        {detail && (
          <p className="auth-help">{detail}</p>
        )}

        {action}
      </section>
    </main>
  )
}

const ownerUid =
  import.meta.env.VITE_PROPERTYOS_OWNER_UID?.trim()

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthReady, setIsAuthReady] = useState(false)
  const [authProblem, setAuthProblem] = useState('')
  const [sessionError, setSessionError] = useState('')
  const [isSigningOut, setIsSigningOut] = useState(false)

  const [activePage, setActivePage] =
    useState<AppPage>('Dashboard')

  const [searchValue, setSearchValue] = useState('')

  useEffect(() => {
    let unsubscribe: (() => void) | undefined

    try {
      unsubscribe = observeAuthState(
        (nextUser) => {
          setUser(nextUser)
          setIsAuthReady(true)
          setAuthProblem('')
        },
        () => {
          setAuthProblem(
            'Unable to verify the current sign-in session. ' +
            'Check your Firebase configuration and connection.',
          )

          setIsAuthReady(true)
        },
      )
    } catch (error: unknown) {
      setAuthProblem(
        error instanceof Error
          ? error.message
          : 'Unable to initialize Firebase Authentication.',
      )

      setIsAuthReady(true)
    }

    return () => unsubscribe?.()
  }, [])

  async function handleSignOut() {
    if (isSigningOut) return

    setSessionError('')
    setIsSigningOut(true)

    try {
      await signOutCurrentUser()
    } catch {
      setSessionError(
        'Sign-out failed. Check your connection and try again.',
      )
    } finally {
      setIsSigningOut(false)
    }
  }

  if (!isAuthReady) {
    return (
      <StatusCard
        title="Checking your session"
        message="PropertyOS is securely checking your sign-in status."
      />
    )
  }

  if (authProblem) {
    return (
      <StatusCard
        title="Authentication needs attention"
        message={authProblem}
        detail="Confirm your Firebase web configuration in .env.local, then restart the development server."
      />
    )
  }

  if (
    !ownerUid ||
    ownerUid === 'PASTE_YOUR_FIREBASE_USER_UID_HERE'
  ) {
    return (
      <StatusCard
        title="Finish owner setup"
        message="PropertyOS needs your owner account UID before opening the workspace."
        detail="Confirm VITE_PROPERTYOS_OWNER_UID in .env.local and restart Vite if you recently changed it."
      />
    )
  }

  if (!user) {
    return <LoginPage />
  }

  if (user.uid !== ownerUid) {
    return (
      <StatusCard
        title="Access not authorized"
        message="This account is not the configured PropertyOS owner."
        detail="Sign out and use the authorized owner account."
        action={
          <button
            className="button button-secondary auth-status-action"
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
          >
            <LogOut size={17} />
            {isSigningOut ? 'Signing out...' : 'Sign out'}
          </button>
        }
      />
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
      />

      <div className="app-main">
        <header className="mobile-header">
          <span className="brand-mark">
            <Building2 size={21} aria-hidden="true" />
          </span>

          <strong>PropertyOS</strong>

          <button
            className="sign-out-button mobile-sign-out"
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="desktop-session-bar">
          <span className="session-email">
            {user.email ?? 'Authorized owner'}
          </span>

          <button
            className="sign-out-button"
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
          >
            <LogOut size={16} aria-hidden="true" />
            {isSigningOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>

        <main className="page-content">
          {sessionError && (
            <p className="auth-error" role="alert">
              {sessionError}
            </p>
          )}

          <Suspense
            fallback={
              <div className="module-placeholder" role="status">
                <p className="eyebrow">PROPERTYOS</p>
                <h1>Loading module...</h1>
                <p className="page-description">
                  Preparing your workspace.
                </p>
              </div>
            }
          >
            {activePage === 'Dashboard' ? (
              <DashboardPage
                ownerUid={user.uid}
                searchValue={searchValue}
                onSearchChange={setSearchValue}
                onNavigate={setActivePage}
              />
            ) : activePage === 'Properties' ? (
              <PropertiesPage ownerUid={user.uid} />
            ) : activePage === 'Rooms' ? (
              <RoomsPage
                ownerUid={user.uid}
                onNavigate={setActivePage}
              />
            ) : activePage === 'Tenants' ? (
              <TenantsPage ownerUid={user.uid} />
            ) : activePage === 'Meters' ? (
              <MetersPage ownerUid={user.uid} />
            ) : activePage === 'Rent & Bills' ? (
              <RentBillsPage ownerUid={user.uid} />
            ) : activePage === 'Electricity' ? (
              <ElectricityPage ownerUid={user.uid} />
            ) : activePage === 'Payments' ? (
              <PaymentsPage ownerUid={user.uid} />
            ) : activePage === 'Ledgers' ? (
              <LedgersPage ownerUid={user.uid} />
            ) : activePage === 'Reports' ? (
              <FinancialReportsPage ownerUid={user.uid} />
            ) : activePage === 'History' ? (
              <HistoryPage ownerUid={user.uid} />
            ) : activePage === 'Backup' ? (
              <BackupPage ownerUid={user.uid} />
            ) : activePage === 'Settings' ? (
              <SettingsPage ownerUid={user.uid} />
            ) : (
              <ModulePlaceholder
                page={activePage}
                onNavigate={setActivePage}
              />
            )}
          </Suspense>
        </main>
      </div>

      <MobileNavigation
        activePage={activePage}
        onNavigate={setActivePage}
      />
    </div>
  )
}

export default App