import {
  getApp,
  getApps,
  initializeApp,
  type FirebaseOptions,
  type FirebaseApp,
} from 'firebase/app'
import {
  getAuth,
  type Auth,
} from 'firebase/auth'
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore'

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const requiredConfig = [
  ['VITE_FIREBASE_API_KEY', firebaseConfig.apiKey],
  ['VITE_FIREBASE_AUTH_DOMAIN', firebaseConfig.authDomain],
  ['VITE_FIREBASE_PROJECT_ID', firebaseConfig.projectId],
  ['VITE_FIREBASE_APP_ID', firebaseConfig.appId],
] as const

type FirebaseServices = {
  app: FirebaseApp
  auth: Auth
  db: Firestore
}

let cachedServices: FirebaseServices | undefined

export function getFirebaseServices(): FirebaseServices {
  if (cachedServices) {
    return cachedServices
  }

  const missing = requiredConfig
    .filter(([, value]) =>
      typeof value !== 'string' || value.trim() === '',
    )
    .map(([key]) => key)

  if (missing.length > 0) {
    throw new Error(
      `Firebase configuration is missing: ${missing.join(', ')}. ` +
      'Check the .env.local file and restart the development server.',
    )
  }

  const app = getApps().length > 0
    ? getApp()
    : initializeApp(firebaseConfig)

  let db: Firestore

  try {
    // Keep Firestore's local document/query cache in IndexedDB so previously
    // loaded workspace data is available across reloads and brief outages.
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    })
  } catch (error: unknown) {
    // Some browser profiles disable IndexedDB or may already have an
    // initialized Firestore instance (for example during Vite HMR). Fall
    // back to the SDK's normal in-memory cache instead of blocking the app.
    console.warn(
      '[PropertyOS] Persistent Firestore cache is unavailable; using memory cache.',
      error,
    )
    db = getFirestore(app)
  }

  cachedServices = {
    app,
    auth: getAuth(app),
    db,
  }

  return cachedServices
}
