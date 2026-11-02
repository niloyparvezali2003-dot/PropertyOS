import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
} from 'react'
import type { ComponentType, ErrorInfo, ReactNode } from 'react'
import type { User } from 'firebase/auth'
import { LogOut, MailCheck, RefreshCw, WifiOff } from 'lucide-react'

import {
  MobileNavigation,
  Sidebar,
} from './components/layout/Sidebar'
import { LoginPage } from './components/auth/LoginPage'
import { ModuleLoadingScreen } from './components/layout/ModuleLoadingScreen'
import { clearAllCachedLists } from './services/firebase/listCache'
import {
  observeAuthState,
  refreshCurrentUser,
  sendVerificationEmail,
  signOutCurrentUser,
} from './services/firebase/auth'
import {
  acceptWorkspaceInvitation,
  clearInvitationUrlState,
  ensureWorkspaceOwnerMember,
  getInvitationUrlState,
  getWorkspaceMembership,
  observeWorkspaceMembership,
} from './services/firebase/workspace'
import type { AppPage } from './types/navigation'

function lazyWithRetry<Props extends object>(loadModule: () => Promise<{ default: ComponentType<Props> }>) {
  return lazy(async () => {
    let lastError: unknown

    // Retry transient chunk/network failures before showing the manual retry screen.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await loadModule()
      } catch (error: unknown) {
        lastError = error
        if (attempt < 2) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 700 * (attempt + 1))
          })
        }
      }
    }

    throw lastError
  })
}

const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const PropertiesPage = lazyWithRetry(() => import('./pages/PropertiesPage').then((m) => ({ default: m.PropertiesPage })))
const RoomsPage = lazyWithRetry(() => import('./pages/RoomsPage').then((m) => ({ default: m.RoomsPage })))
const TenantsPage = lazyWithRetry(() => import('./pages/TenantsPage').then((m) => ({ default: m.TenantsPage })))
const MetersPage = lazyWithRetry(() => import('./pages/MetersPage').then((m) => ({ default: m.MetersPage })))
const RentBillsPage = lazyWithRetry(() => import('./pages/RentBillsPage').then((m) => ({ default: m.RentBillsPage })))
const ElectricityPage = lazyWithRetry(() => import('./pages/ElectricityPage').then((m) => ({ default: m.ElectricityPage })))
const PaymentsPage = lazyWithRetry(() => import('./pages/PaymentsPage').then((m) => ({ default: m.PaymentsPage })))
const LedgersPage = lazyWithRetry(() => import('./pages/LedgersPage').then((m) => ({ default: m.LedgersPage })))
const FinancialReportsPage = lazyWithRetry(() => import('./pages/FinancialReportsPage').then((m) => ({ default: m.FinancialReportsPage })))
const HistoryPage = lazyWithRetry(() => import('./pages/HistoryPage').then((m) => ({ default: m.HistoryPage })))
const BackupPage = lazyWithRetry(() => import('./pages/BackupPage').then((m) => ({ default: m.BackupPage })))
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const NotePage = lazyWithRetry(() => import('./pages/NotePage').then((m) => ({ default: m.NotePage })))
const OpeningBalancePage = lazyWithRetry(() => import('./pages/OpeningBalancePage').then((m) => ({ default: m.OpeningBalancePage })))
const UsersAccessPage = lazyWithRetry(() => import('./pages/UsersAccessPage').then((m) => ({ default: m.UsersAccessPage })))
const ModulePlaceholder = lazyWithRetry(() => import('./pages/ModulePlaceholder').then((m) => ({ default: m.ModulePlaceholder })))

type StatusCardProps = {
  title: string
  message: string
  detail?: string
  action?: ReactNode
}

function StatusCard({ title, message, detail, action }: StatusCardProps) {
  return (
    <main className="auth-screen">
      <section className="auth-card auth-status-card">
        <div className="auth-brand">
          <span className="brand-mark"><img src="/icon-192.png" alt="T&N House's" /></span>
          <div><strong>T&N House's</strong><span>PROPERTYOS MANAGEMENT</span></div>
        </div>
        <h1>{title}</h1>
        <p className="auth-status-message">{message}</p>
        {detail && <p className="auth-help">{detail}</p>}
        {action}
      </section>
    </main>
  )
}

const ownerUid = import.meta.env.VITE_PROPERTYOS_OWNER_UID?.trim()
type WorkspaceAccessState = 'checking' | 'active' | 'verification' | 'denied' | 'error'

type ModuleLoadErrorBoundaryProps = {
  isOnline: boolean
  children: ReactNode
}

type ModuleLoadErrorBoundaryState = {
  hasError: boolean
}

class ModuleLoadErrorBoundary extends Component<ModuleLoadErrorBoundaryProps, ModuleLoadErrorBoundaryState> {
  state: ModuleLoadErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ModuleLoadErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[PropertyOS] Unable to load the selected module.', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <ModuleLoadingScreen
          isOnline={this.props.isOnline}
          loadError
          onRetry={() => window.location.reload()}
        />
      )
    }

    return this.props.children
  }
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthReady, setIsAuthReady] = useState(false)
  const [authProblem, setAuthProblem] = useState('')
  const [sessionError, setSessionError] = useState('')
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false)
  const [isResendingVerification, setIsResendingVerification] = useState(false)
  const [verificationMessage, setVerificationMessage] = useState('')
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccessState>('checking')
  const [workspaceAccessError, setWorkspaceAccessError] = useState('')
  const [authRevision, setAuthRevision] = useState(0)
  const [invitation, setInvitation] = useState(getInvitationUrlState)
  const [activePage, setActivePage] = useState<AppPage>('Dashboard')
  const [searchValue, setSearchValue] = useState('')
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = observeAuthState(
        (nextUser) => {
          if (!nextUser) clearAllCachedLists()
          setUser(nextUser)
          setIsAuthReady(true)
          setAuthProblem('')
        },
        () => {
          setAuthProblem('Unable to verify the current sign-in session. Check your Firebase configuration and connection.')
          setIsAuthReady(true)
        },
      )
    } catch (error: unknown) {
      setAuthProblem(error instanceof Error ? error.message : 'Unable to initialize Firebase Authentication.')
      setIsAuthReady(true)
    }
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    // Capture primitive values before starting async work. This avoids stale
    // React state references and keeps TypeScript's null/undefined checks
    // valid inside the async function.
    const authenticatedUid = user?.uid ?? ''
    const isEmailVerified = user?.emailVerified === true
    const workspaceUid = ownerUid ?? ''
    const pendingInvitation = invitation

    if (!authenticatedUid) {
      setWorkspaceAccess('checking')
      setWorkspaceAccessError('')
      return
    }
    if (!workspaceUid || workspaceUid === 'PASTE_YOUR_FIREBASE_USER_UID_HERE') return

    let cancelled = false
    setWorkspaceAccess('checking')
    setWorkspaceAccessError('')

    async function resolveAccess(): Promise<void> {
      try {
        if (pendingInvitation && pendingInvitation.workspaceUid !== workspaceUid) {
          throw new Error('This invitation belongs to a different PropertyOS workspace.')
        }

        if (authenticatedUid === workspaceUid) {
          await ensureWorkspaceOwnerMember(workspaceUid)
          if (!cancelled) setWorkspaceAccess('active')
          return
        }

        if (pendingInvitation) {
          if (!isEmailVerified) {
            if (!cancelled) setWorkspaceAccess('verification')
            return
          }
          await acceptWorkspaceInvitation(workspaceUid, pendingInvitation.token)
          clearInvitationUrlState()
          if (!cancelled) {
            setInvitation(null)
            setWorkspaceAccess('active')
          }
          return
        }

        const membership = await getWorkspaceMembership(workspaceUid, authenticatedUid)
        if (!membership || membership.status !== 'active') {
          if (!cancelled) setWorkspaceAccess('denied')
          return
        }
        if (!cancelled) setWorkspaceAccess('active')
      } catch (error: unknown) {
        if (!cancelled) {
          setWorkspaceAccessError(error instanceof Error ? error.message : 'Unable to verify workspace access.')
          setWorkspaceAccess('error')
        }
      }
    }

    void resolveAccess()
    return () => { cancelled = true }
  }, [user?.uid, user?.emailVerified, invitation, ownerUid, authRevision])

  useEffect(() => {
    if (!user || workspaceAccess !== 'active' || !ownerUid || user.uid === ownerUid) return

    return observeWorkspaceMembership(
      ownerUid,
      user.uid,
      (membership) => {
        if (!membership || membership.status !== 'active') {
          clearAllCachedLists()
          setWorkspaceAccessError('Your access to this shared workspace has been removed. Contact a workspace member if you need access again.')
          setWorkspaceAccess('denied')
        }
      },
      (error) => {
        if ('code' in error && error.code === 'permission-denied') {
          clearAllCachedLists()
          setWorkspaceAccessError('Your access to this shared workspace could not be confirmed. Sign in again or contact a workspace member.')
          setWorkspaceAccess('denied')
        }
      },
    )
  }, [user?.uid, workspaceAccess, ownerUid])

  async function handleSignOut() {
    if (isSigningOut) return
    setSessionError('')
    setIsSigningOut(true)
    try {
      clearAllCachedLists()
      await signOutCurrentUser()
      setWorkspaceAccess('checking')
    } catch {
      setSessionError('Sign-out failed. Check your connection and try again.')
    } finally {
      setIsSigningOut(false)
    }
  }

  async function handleVerificationRefresh() {
    if (!user || isRefreshingVerification) return
    setIsRefreshingVerification(true)
    setVerificationMessage('')
    try {
      await refreshCurrentUser(user)
      setAuthRevision((value) => value + 1)
      if (!user.emailVerified) {
        setVerificationMessage('Email verification has not reached this session yet. Open the verification email, then try again.')
      }
    } catch (error: unknown) {
      setVerificationMessage(error instanceof Error ? error.message : 'Unable to refresh email verification status.')
    } finally {
      setIsRefreshingVerification(false)
    }
  }

  async function handleResendVerification() {
    if (!user || isResendingVerification) return
    setIsResendingVerification(true)
    setVerificationMessage('')
    try {
      await sendVerificationEmail(user)
      setVerificationMessage(`A new verification email was sent to ${user.email ?? 'your email address'}.`)
    } catch (error: unknown) {
      setVerificationMessage(error instanceof Error ? error.message : 'Unable to send a verification email.')
    } finally {
      setIsResendingVerification(false)
    }
  }

  if (!isAuthReady) {
    return <StatusCard title="Checking your session" message="PropertyOS is securely checking your sign-in status." />
  }
  if (authProblem) {
    return <StatusCard title="Authentication needs attention" message={authProblem} detail="Confirm your Firebase configuration in .env.local, then restart the development server." />
  }
  if (!ownerUid || ownerUid === 'PASTE_YOUR_FIREBASE_USER_UID_HERE') {
    return <StatusCard title="Finish workspace setup" message="PropertyOS needs the original workspace owner's UID before opening the shared workspace." detail="Confirm VITE_PROPERTYOS_OWNER_UID in .env.local. Keep this value the same for both Ali and Niloy's deployments." />
  }
  if (!user) return <LoginPage isInvitation={Boolean(invitation)} />

  if (workspaceAccess === 'checking') {
    return <StatusCard title="Checking workspace access" message="Verifying your membership in the shared T&N House's workspace." />
  }

  if (workspaceAccess === 'verification') {
    return (
      <StatusCard
        title="Verify your invited email"
        message={`This invitation can only be accepted by the verified email address it was sent to. Signed in as ${user.email ?? 'your account'}.`}
        detail="Open the verification email in your inbox. After verifying, return here and refresh the verification status."
        action={(
          <div className="auth-status-actions">
            <button className="button button-primary auth-status-action" type="button" onClick={() => void handleVerificationRefresh()} disabled={isRefreshingVerification}>
              {isRefreshingVerification ? <RefreshCw className="auth-spinner" size={17} /> : <MailCheck size={17} />}
              I've verified my email
            </button>
            <button className="button button-secondary auth-status-action" type="button" onClick={() => void handleResendVerification()} disabled={isResendingVerification}>
              {isResendingVerification ? 'Sending...' : 'Resend verification email'}
            </button>
            {verificationMessage && <p className="auth-help" role="status">{verificationMessage}</p>}
            <button className="button button-ghost auth-status-action" type="button" onClick={handleSignOut} disabled={isSigningOut}>Sign out</button>
          </div>
        )}
      />
    )
  }

  if (workspaceAccess === 'denied' || workspaceAccess === 'error') {
    return (
      <StatusCard
        title={workspaceAccess === 'denied' ? 'Workspace access not found' : 'Unable to access workspace'}
        message={workspaceAccessError || (workspaceAccess === 'denied'
          ? 'This account is not an active member of the configured shared workspace.'
          : 'PropertyOS could not verify your workspace membership.')}
        detail="Use the original owner account or open a valid single-use invitation link with the invited email address."
        action={(
          <button className="button button-secondary auth-status-action" type="button" onClick={handleSignOut} disabled={isSigningOut}>
            <LogOut size={17} />{isSigningOut ? 'Signing out...' : 'Sign out'}
          </button>
        )}
      />
    )
  }

  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <div className="app-main">
        <header className="mobile-header">
          <span className="brand-mark"><img src="/icon-192.png" alt="T&N House's" /></span>
          <strong>T&N House's</strong>
          <button className="sign-out-button mobile-sign-out" type="button" onClick={handleSignOut} disabled={isSigningOut} aria-label="Sign out" title="Sign out">
            <LogOut size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="desktop-session-bar">
          <span className="session-email">{user.email ?? 'Workspace member'}</span>
          <span className="workspace-session-label">Shared workspace · Full access</span>
          <button className="sign-out-button" type="button" onClick={handleSignOut} disabled={isSigningOut}>
            <LogOut size={16} aria-hidden="true" />{isSigningOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>

        {!isOnline && (
          <div className="network-status-banner" role="status">
            <WifiOff size={16} aria-hidden="true" />
            <span><strong>You're offline.</strong> Some features may be unavailable until your connection returns. Previously cached information may still be accessible.</span>
          </div>
        )}

        <main className="page-content">
          {sessionError && <p className="auth-error" role="alert">{sessionError}</p>}
          <ModuleLoadErrorBoundary isOnline={isOnline}>
            <Suspense fallback={<ModuleLoadingScreen isOnline={isOnline} />}>
            {activePage === 'Dashboard' ? (
              <DashboardPage ownerUid={ownerUid} searchValue={searchValue} onSearchChange={setSearchValue} onNavigate={setActivePage} />
            ) : activePage === 'Properties' ? (
              <PropertiesPage ownerUid={ownerUid} />
            ) : activePage === 'Rooms' ? (
              <RoomsPage ownerUid={ownerUid} onNavigate={setActivePage} />
            ) : activePage === 'Tenants' ? (
              <TenantsPage ownerUid={ownerUid} />
            ) : activePage === 'Meters' ? (
              <MetersPage ownerUid={ownerUid} />
            ) : activePage === 'Rent & Bills' ? (
              <RentBillsPage ownerUid={ownerUid} />
            ) : activePage === 'Electricity' ? (
              <ElectricityPage ownerUid={ownerUid} />
            ) : activePage === 'Payments' ? (
              <PaymentsPage ownerUid={ownerUid} />
            ) : activePage === 'Ledgers' ? (
              <LedgersPage ownerUid={ownerUid} />
            ) : activePage === 'Reports' ? (
              <FinancialReportsPage ownerUid={ownerUid} />
            ) : activePage === 'Note' ? (
              <NotePage ownerUid={ownerUid} />
            ) : activePage === 'Opening Balance' ? (
              <OpeningBalancePage ownerUid={ownerUid} />
            ) : activePage === 'Users & Access' ? (
              <UsersAccessPage ownerUid={ownerUid} />
            ) : activePage === 'History' ? (
              <HistoryPage ownerUid={ownerUid} />
            ) : activePage === 'Backup' ? (
              <BackupPage ownerUid={ownerUid} />
            ) : activePage === 'Settings' ? (
              <SettingsPage ownerUid={ownerUid} />
            ) : (
              <ModulePlaceholder page={activePage} onNavigate={setActivePage} />
            )}
            </Suspense>
          </ModuleLoadErrorBoundary>
        </main>
      </div>
      <MobileNavigation activePage={activePage} onNavigate={setActivePage} />
    </div>
  )
}

export default App
