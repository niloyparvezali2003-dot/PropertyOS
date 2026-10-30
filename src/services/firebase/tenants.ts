import { getCachedList } from './listCache'

import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'

import {
  commitIdentifierReservation,
  IdentifierLimitReachedError,
  InvalidIdentifierSequenceError,
  parseIdentifierNumber,
  reserveNextIdentifier,
} from './identifiers'

import { getCurrentActorUid, getFirebaseServices } from './client'

import {
  tenantFormSchema,
  type TenantFormValues,
  type TenantStatus,
} from '../../schemas/tenant'

export type TenantRecord = {
  id: string
  tenantCode: string
  fullName: string
  phone: string
  email: string
  address: string
  notes: string
  status: TenantStatus
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export class TenantNotFoundError extends Error {
  constructor() {
    super('This tenant no longer exists. Refresh and try again.')
    this.name = 'TenantNotFoundError'
  }
}

function getTenantRef(ownerUid: string, tenantId: string) {
  const { db } = getFirebaseServices()

  return doc(db, 'users', ownerUid, 'tenants', tenantId)
}

function prepareTenantInput(
  rawInput: TenantFormValues,
): TenantFormValues {
  const input = tenantFormSchema.parse(rawInput)

  return {
    ...input,
    fullName: input.fullName.trim().replace(/\s+/g, ' '),
    phone: input.phone.trim(),
    email: input.email.trim(),
    address: input.address.trim(),
    notes: input.notes.trim(),
  }
}

export async function listTenants(
  ownerUid: string,
): Promise<TenantRecord[]> {
  return getCachedList(ownerUid, 'Tenants', async () => {
    const { db } = getFirebaseServices()

    const tenantsRef = collection(
      db,
      'users',
      ownerUid,
      'tenants',
    )

    const snapshot = await getDocs(
      query(tenantsRef, orderBy('createdAt', 'desc')),
    )

    const codes = new Set<string>()

    return snapshot.docs.map((tenantDocument) => {
      const data = tenantDocument.data()

      if (
        typeof data.tenantCode !== 'string' ||
        parseIdentifierNumber('tenant', data.tenantCode) === null ||
        typeof data.fullName !== 'string' ||
        typeof data.phone !== 'string' ||
        typeof data.email !== 'string' ||
        typeof data.address !== 'string' ||
        typeof data.notes !== 'string' ||
        typeof data.createdBy !== 'string' ||
        typeof data.updatedBy !== 'string' ||
        (data.status !== 'active' && data.status !== 'archived')
      ) {
        throw new Error(
          `Tenant record ${tenantDocument.id} contains invalid stored data.`,
        )
      }

      if (codes.has(data.tenantCode)) {
        throw new Error(
          `Duplicate tenant code ${data.tenantCode} detected. No tenant records were changed.`,
        )
      }

      codes.add(data.tenantCode)

      return {
        id: tenantDocument.id,
        tenantCode: data.tenantCode,
        fullName: data.fullName,
        phone: data.phone,
        email: data.email,
        address: data.address,
        notes: data.notes,
        status: data.status as TenantStatus,
        createdAt:
          data.createdAt instanceof Timestamp ? data.createdAt : null,
        updatedAt:
          data.updatedAt instanceof Timestamp ? data.updatedAt : null,
        createdBy: data.createdBy,
        updatedBy: data.updatedBy,
      }
    })
  })
}

export async function createTenant(
  ownerUid: string,
  rawInput: TenantFormValues,
): Promise<string> {
  const input = prepareTenantInput(rawInput)
  const { db } = getFirebaseServices()

  const tenantsRef = collection(
    db,
    'users',
    ownerUid,
    'tenants',
  )

  // Keep the Firestore document ID separate from the tenant code.
  const tenantRef = doc(tenantsRef)

  await runTransaction(db, async (transaction) => {
    const reservation = await reserveNextIdentifier(
      transaction,
      ownerUid,
      'tenant',
    )

    transaction.set(tenantRef, {
      tenantCode: reservation.code,
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      address: input.address,
      notes: input.notes,
      status: input.status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
    })

    commitIdentifierReservation(transaction, reservation)
  })

  return tenantRef.id
}

export async function updateTenant(
  ownerUid: string,
  tenantId: string,
  rawInput: TenantFormValues,
): Promise<void> {
  const input = prepareTenantInput(rawInput)
  const { db } = getFirebaseServices()
  const tenantRef = getTenantRef(ownerUid, tenantId)

  await runTransaction(db, async (transaction) => {
    const tenantSnapshot = await transaction.get(tenantRef)

    if (!tenantSnapshot.exists()) {
      throw new TenantNotFoundError()
    }

    const currentData = tenantSnapshot.data()

    if (
      typeof currentData.tenantCode !== 'string' ||
      parseIdentifierNumber('tenant', currentData.tenantCode) === null
    ) {
      throw new Error(
        'The stored tenant ID is invalid. No changes were made.',
      )
    }

    // The permanent tenant code and creator never change.
    transaction.update(tenantRef, {
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      address: input.address,
      notes: input.notes,
      status: input.status,
      updatedAt: serverTimestamp(),
      updatedBy: getCurrentActorUid(),
    })
  })
}

export function getTenantErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof TenantNotFoundError ||
    error instanceof IdentifierLimitReachedError ||
    error instanceof InvalidIdentifierSequenceError
  ) {
    return error.message
  }

  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : ''

  switch (code) {
    case 'permission-denied':
    case 'firestore/permission-denied':
      return 'Database access was denied. Check the published Firestore rules and owner UID.'

    case 'unavailable':
    case 'firestore/unavailable':
      return 'Firestore is unavailable. Check your internet connection and try again.'

    case 'unauthenticated':
      return 'Your session has expired. Sign in again.'

    case 'resource-exhausted':
      return 'The Firebase quota or resource limit has been reached.'

    default:
      return error instanceof Error
        ? error.message
        : 'Something went wrong while accessing tenants.'
  }
}
