import {
  onAuthStateChanged,
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

  return onAuthStateChanged(
    auth,
    onUserChanged,
    onError,
  )
}

export async function signInWithEmail(
  email: string,
  password: string,
): Promise<void> {
  const { auth } = getFirebaseServices()

  await signInWithEmailAndPassword(
    auth,
    email.trim(),
    password,
  )
}

export async function signOutCurrentUser(): Promise<void> {
  const { auth } = getFirebaseServices()
  await signOut(auth)
}

export function getSignInErrorMessage(
  error: unknown,
): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
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

    default:
      return 'Unable to sign in. Check your connection and Firebase setup.'
  }
}