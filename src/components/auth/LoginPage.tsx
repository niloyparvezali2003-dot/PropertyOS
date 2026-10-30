import { useState, type FormEvent } from 'react'
import {
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  LogIn,
} from 'lucide-react'
import {
  getSignInErrorMessage,
  signInWithEmail,
} from '../../services/firebase/auth'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    if (isSubmitting) return

    setError('')
    setIsSubmitting(true)

    try {
      await signInWithEmail(email, password)
    } catch (error: unknown) {
      setError(getSignInErrorMessage(error))
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
          <p className="eyebrow">Owner workspace</p>
          <h1 id="login-title">Welcome back</h1>
          <p>
            Sign in to manage your properties, tenants, bills,
            and payment history.
          </p>
        </div>

        <form
          className="auth-form"
          onSubmit={handleSubmit}
        >
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
              <LockKeyhole
                size={17}
                aria-hidden="true"
              />

              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                required
                disabled={isSubmitting}
              />

              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={
                  showPassword ? 'Hide password' : 'Show password'
                }
                aria-pressed={showPassword}
                disabled={isSubmitting}
              >
                {showPassword ? (
                  <EyeOff size={18} aria-hidden="true" />
                ) : (
                  <Eye size={18} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="button button-primary auth-submit"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <LoaderCircle
                className="auth-spinner"
                size={18}
                aria-hidden="true"
              />
            ) : (
              <LogIn size={18} aria-hidden="true" />
            )}

            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="auth-footnote">
          <LockKeyhole size={14} aria-hidden="true" />
          Authorized owner account only
        </p>
      </section>
    </main>
  )
}