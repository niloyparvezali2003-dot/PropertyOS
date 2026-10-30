import { useState, type FormEvent } from 'react'
import {
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  UserPlus,
} from 'lucide-react'
import {
  createAccountWithEmail,
  getSignInErrorMessage,
  sendVerificationEmail,
  signInWithEmail,
} from '../../services/firebase/auth'

type LoginPageProps = {
  isInvitation?: boolean
}

export function LoginPage({ isInvitation = false }: LoginPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return

    setError('')
    setIsSubmitting(true)

    try {
      if (isRegistering) {
        const user = await createAccountWithEmail(email, password)
        await sendVerificationEmail(user)
      } else {
        await signInWithEmail(email, password)
      }
    } catch (submitError: unknown) {
      setError(getSignInErrorMessage(submitError))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-brand">
          <span className="brand-mark">
            <img src="/icon-192.png" alt="T&N House's" />
          </span>
          <div>
            <strong>T&N House's</strong>
            <span>PROPERTYOS MANAGEMENT</span>
          </div>
        </div>

        <div className="auth-intro">
          <p className="eyebrow">{isInvitation ? 'Shared workspace invitation' : 'Workspace sign-in'}</p>
          <h1 id="login-title">{isRegistering ? 'Create your account' : 'Welcome back'}</h1>
          <p>
            {isInvitation
              ? 'Sign in with the invited email address, or create an account to join the shared property workspace.'
              : 'Sign in to manage your properties, tenants, bills, and payment history.'}
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Enter your email"
              required
              disabled={isSubmitting}
            />
          </div>

          <div className="auth-field">
            <label htmlFor="login-password">Password</label>
            <div className="password-control">
              <LockKeyhole size={17} aria-hidden="true" />
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={isRegistering ? 'new-password' : 'current-password'}
                minLength={isRegistering ? 6 : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isRegistering ? 'Create a password (at least 6 characters)' : 'Enter your password'}
                required
                disabled={isSubmitting}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                disabled={isSubmitting}
              >
                {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>

          {error && <p className="auth-error" role="alert">{error}</p>}

          <button className="button button-primary auth-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <LoaderCircle className="auth-spinner" size={18} aria-hidden="true" />
            ) : isRegistering ? (
              <UserPlus size={18} aria-hidden="true" />
            ) : (
              <LogIn size={18} aria-hidden="true" />
            )}
            {isSubmitting ? 'Please wait...' : isRegistering ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {isInvitation && (
          <button
            className="auth-switch-mode"
            type="button"
            onClick={() => {
              setIsRegistering((value) => !value)
              setError('')
            }}
            disabled={isSubmitting}
          >
            {isRegistering ? 'Already have an account? Sign in' : 'New to PropertyOS? Create an account'}
          </button>
        )}

        <p className="auth-footnote">
          <LockKeyhole size={14} aria-hidden="true" />
          {isInvitation ? 'Your own account · Shared property data' : 'Authorized workspace account only'}
        </p>
      </section>
    </main>
  )
}
