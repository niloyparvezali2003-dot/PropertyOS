import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  type User,
  type Unsubscribe,
} from 'firebase/auth'
import { getFirebaseServices } from './client'

export function observeAuthState(
  onUserChanged: (user: User | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const { auth } = getFirebaseServices()
  return onAuthStateChanged(auth, onUserChanged, onError)
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { auth } = getFirebaseServices()
  await signInWithEmailAndPassword(auth, email.trim(), password)
}

export async function createAccountWithEmail(email: string, password: string): Promise<User> {
  const { auth } = getFirebaseServices()
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password)
  return credential.user
}

export async function sendVerificationEmail(user: User): Promise<void> {
  const { auth } = getFirebaseServices()
  auth.languageCode = 'en'
  await sendEmailVerification(user, {
    url: window.location.href,
    handleCodeInApp: false,
  })
}

export async function refreshCurrentUser(user: User): Promise<void> {
  await reload(user)
  // Firestore rules use the email_verified ID-token claim. Force a new token
  // after the email action updates the Firebase user profile.
  await user.getIdToken(true)
}

export async function signOutCurrentUser(): Promise<void> {
  const { auth } = getFirebaseServices()
  await signOut(auth)
}

export function getSignInErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Email or password is incorrect.'
    case 'auth/invalid-email':
      return 'Enter a valid email address.'
    case 'auth/user-disabled':
      return 'This account has been disabled.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.'
    case 'auth/network-request-failed':
      return 'Connection failed. Check your internet and try again.'
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in is not enabled in Firebase.'
    case 'auth/unauthorized-domain':
      return 'This website domain is not authorized in Firebase.'
    case 'auth/email-already-in-use':
      return 'An account already exists for this email. Sign in instead.'
    case 'auth/weak-password':
      return 'Use a stronger password with at least 6 characters.'
    default:
      return 'Unable to sign in. Check your connection and Firebase setup.'
  }
}
