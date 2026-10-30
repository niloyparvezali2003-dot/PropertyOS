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
  formatIdentifier,
  getIdentifierSequenceRef,
  IdentifierLimitReachedError,
  InvalidIdentifierSequenceError,
  parseIdentifierNumber,
  reserveNextIdentifier,
} from './identifiers'

import { getCurrentActorUid, getFirebaseServices } from './client'
import { propertyFormSchema } from '../../schemas/property'
import type { PropertyFormValues } from '../../schemas/property'

export type PropertyStatus = 'active' | 'archived'

export type PropertyRecord = {
  id: string
  propertyCode: string
  name: string
  normalizedName: string
  address: string
  notes: string
  status: PropertyStatus
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export class DuplicatePropertyNameError extends Error {
  constructor() {
    super('A property with this name already exists.')
    this.name = 'DuplicatePropertyNameError'
  }
}

export class PropertyNotFoundError extends Error {
  constructor() {
    super(
      'This property no longer exists. Refresh the list and try again.',
    )
    this.name = 'PropertyNotFoundError'
  }
}

function normalizePropertyName(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function getNameIndexId(normalizedName: string): string {
  return encodeURIComponent(normalizedName)
}

function getPropertyRef(ownerUid: string, propertyId: string) {
  const { db } = getFirebaseServices()

  return doc(db, 'users', ownerUid, 'properties', propertyId)
}

function getNameIndexRef(
  ownerUid: string,
  normalizedName: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'propertyNameIndex',
    getNameIndexId(normalizedName),
  )
}

function getCreationTime(value: unknown): number {
  return value instanceof Timestamp
    ? value.toMillis()
    : Number.MAX_SAFE_INTEGER
}

// The legacy property-code migration is complete for the active app session.
// New properties already receive codes in their normal creation transaction.
const propertyCodeMigrationComplete = new Set<string>()

export function resetPropertyCodeMigration(ownerUid: string): void {
  propertyCodeMigrationComplete.delete(ownerUid)
}

/**
 * One-time, transaction-safe migration for properties without
 * propertyCode. Existing Firestore document IDs remain untouched.
 */
async function ensurePropertyCodes(
  ownerUid: string,
): Promise<void> {
  if (propertyCodeMigrationComplete.has(ownerUid)) return

  const { db } = getFirebaseServices()

  const propertiesRef = collection(
    db,
    'users',
    ownerUid,
    'properties',
  )

  // Queries are performed outside the transaction.
  const initialSnapshot = await getDocs(propertiesRef)

  if (initialSnapshot.size > 99) {
    throw new IdentifierLimitReachedError('property')
  }

  const orderedDocuments = [...initialSnapshot.docs].sort(
    (a, b) => {
      const timeDifference =
        getCreationTime(a.data().createdAt) -
        getCreationTime(b.data().createdAt)

      return timeDifference || a.id.localeCompare(b.id)
    },
  )

  const sequenceRef = getIdentifierSequenceRef(
    ownerUid,
    'property',
  )

  await runTransaction(db, async (transaction) => {
    // All transaction reads happen before any writes.
    const sequenceSnapshot = await transaction.get(sequenceRef)

    const currentDocuments = await Promise.all(
      orderedDocuments.map((item) =>
        transaction.get(item.ref),
      ),
    )

    const usedNumbers = new Map<number, string>()
    let highestUsedNumber = 0

    for (const snapshot of currentDocuments) {
      if (!snapshot.exists()) continue

      const data = snapshot.data()

      if (
        !Object.prototype.hasOwnProperty.call(
          data,
          'propertyCode',
        )
      ) {
        continue
      }

      const number = parseIdentifierNumber(
        'property',
        data.propertyCode,
      )

      if (number === null) {
        throw new Error(
          `Property ${snapshot.id} has an invalid permanent code. No migration was applied.`,
        )
      }

      if (usedNumbers.has(number)) {
        throw new Error(
          `Duplicate property code ${data.propertyCode} detected. No migration was applied.`,
        )
      }

      usedNumbers.set(number, snapshot.id)
      highestUsedNumber = Math.max(highestUsedNumber, number)
    }

    const storedNextNumber = sequenceSnapshot.exists()
      ? sequenceSnapshot.data().nextNumber
      : 1

    if (
      !Number.isInteger(storedNextNumber) ||
      storedNextNumber < 1 ||
      storedNextNumber > 100
    ) {
      throw new InvalidIdentifierSequenceError('property')
    }

    // Never move a sequence backwards or reuse an assigned code.
    let nextNumber = Math.max(
      storedNextNumber,
      highestUsedNumber + 1,
    )

    let assignedAnyCode = false

    for (const snapshot of currentDocuments) {
      if (!snapshot.exists()) continue

      const data = snapshot.data()

      if (
        Object.prototype.hasOwnProperty.call(
          data,
          'propertyCode',
        )
      ) {
        continue
      }

      while (usedNumbers.has(nextNumber)) {
        nextNumber += 1
      }

      if (nextNumber > 99) {
        throw new IdentifierLimitReachedError('property')
      }

      const propertyCode = formatIdentifier(
        'property',
        nextNumber,
      )

      transaction.update(snapshot.ref, { propertyCode })

      usedNumbers.set(nextNumber, snapshot.id)
      highestUsedNumber = Math.max(highestUsedNumber, nextNumber)
      nextNumber += 1
      assignedAnyCode = true
    }

    const finalNextNumber = Math.max(
      nextNumber,
      highestUsedNumber + 1,
    )

    if (!sequenceSnapshot.exists()) {
      if (currentDocuments.some((item) => item.exists())) {
        transaction.set(sequenceRef, {
          nextNumber: finalNextNumber,
          updatedAt: serverTimestamp(),
        })
      }
    } else if (
      assignedAnyCode ||
      finalNextNumber > storedNextNumber
    ) {
      transaction.update(sequenceRef, {
        nextNumber: finalNextNumber,
        updatedAt: serverTimestamp(),
      })
    }
  })

  propertyCodeMigrationComplete.add(ownerUid)
}

export async function listProperties(
  ownerUid: string,
): Promise<PropertyRecord[]> {
  return getCachedList(ownerUid, 'Properties', async () => {
    await ensurePropertyCodes(ownerUid)

    const { db } = getFirebaseServices()

    const propertiesRef = collection(
      db,
      'users',
      ownerUid,
      'properties',
    )

    const snapshot = await getDocs(
      query(propertiesRef, orderBy('createdAt', 'desc')),
    )

    return snapshot.docs.map((document) => {
      const data = document.data()

      if (
        typeof data.propertyCode !== 'string' ||
        parseIdentifierNumber('property', data.propertyCode) === null ||
        typeof data.name !== 'string' ||
        typeof data.normalizedName !== 'string' ||
        typeof data.address !== 'string' ||
        typeof data.notes !== 'string' ||
        typeof data.createdBy !== 'string' ||
        typeof data.updatedBy !== 'string' ||
        (data.status !== 'active' && data.status !== 'archived')
      ) {
        throw new Error(
          `Property ${document.id} contains invalid stored data.`,
        )
      }

      return {
        id: document.id,
        propertyCode: data.propertyCode,
        name: data.name,
        normalizedName: data.normalizedName,
        address: data.address,
        notes: data.notes,
        status: data.status,
        createdAt:
          data.createdAt instanceof Timestamp
            ? data.createdAt
            : null,
        updatedAt:
          data.updatedAt instanceof Timestamp
            ? data.updatedAt
            : null,
        createdBy: data.createdBy,
        updatedBy: data.updatedBy,
      }
    })
  })
}

export async function createProperty(
  ownerUid: string,
  rawInput: PropertyFormValues,
): Promise<string> {
  const input = propertyFormSchema.parse(rawInput)

  // Migrate existing records before allocating a new code.
  await ensurePropertyCodes(ownerUid)

  const { db } = getFirebaseServices()
  const normalizedName = normalizePropertyName(input.name)

  const propertiesRef = collection(
    db,
    'users',
    ownerUid,
    'properties',
  )

  // This remains the internal Firestore ID.
  const propertyRef = doc(propertiesRef)

  const nameIndexRef = getNameIndexRef(
    ownerUid,
    normalizedName,
  )

  await runTransaction(db, async (transaction) => {
    const nameIndexSnapshot = await transaction.get(nameIndexRef)

    if (nameIndexSnapshot.exists()) {
      throw new DuplicatePropertyNameError()
    }

    // The sequence and name-index reads happen before writes.
    const reservation = await reserveNextIdentifier(
      transaction,
      ownerUid,
      'property',
    )

    transaction.set(propertyRef, {
      propertyCode: reservation.code,
      name: input.name,
      normalizedName,
      address: input.address,
      notes: input.notes,
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
    })

    transaction.set(nameIndexRef, {
      propertyId: propertyRef.id,
      normalizedName,
      displayName: input.name,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    commitIdentifierReservation(transaction, reservation)
  })

  return propertyRef.id
}

export async function updateProperty(
  ownerUid: string,
  propertyId: string,
  rawInput: PropertyFormValues,
): Promise<void> {
  const input = propertyFormSchema.parse(rawInput)
  const { db } = getFirebaseServices()

  const propertyRef = getPropertyRef(ownerUid, propertyId)
  const normalizedName = normalizePropertyName(input.name)

  const nextIndexRef = getNameIndexRef(
    ownerUid,
    normalizedName,
  )

  await runTransaction(db, async (transaction) => {
    const propertySnapshot = await transaction.get(propertyRef)

    if (!propertySnapshot.exists()) {
      throw new PropertyNotFoundError()
    }

    const currentData = propertySnapshot.data()

    if (typeof currentData.normalizedName !== 'string') {
      throw new Error(
        'The stored property name is invalid. Refresh and try again.',
      )
    }

    const currentIndexRef = getNameIndexRef(
      ownerUid,
      currentData.normalizedName,
    )

    const nextIndexSnapshot = await transaction.get(nextIndexRef)

    const currentIndexSnapshot =
      currentData.normalizedName === normalizedName
        ? nextIndexSnapshot
        : await transaction.get(currentIndexRef)

    if (
      nextIndexSnapshot.exists() &&
      nextIndexSnapshot.data().propertyId !== propertyId
    ) {
      throw new DuplicatePropertyNameError()
    }

    if (
      currentData.normalizedName !== normalizedName &&
      currentIndexSnapshot.exists() &&
      currentIndexSnapshot.data().propertyId === propertyId
    ) {
      transaction.delete(currentIndexRef)
    }

    const previousIndexCreatedAt =
      nextIndexSnapshot.data()?.createdAt

    transaction.set(nextIndexRef, {
      propertyId,
      normalizedName,
      displayName: input.name,
      createdAt:
        previousIndexCreatedAt instanceof Timestamp
          ? previousIndexCreatedAt
          : serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    // propertyCode and createdAt remain unchanged.
    transaction.update(propertyRef, {
      name: input.name,
      normalizedName,
      address: input.address,
      notes: input.notes,
      updatedAt: serverTimestamp(),
      updatedBy: getCurrentActorUid(),
    })
  })
}

export function getPropertyErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof DuplicatePropertyNameError ||
    error instanceof PropertyNotFoundError ||
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
        : 'Something went wrong while accessing properties.'
  }
}
