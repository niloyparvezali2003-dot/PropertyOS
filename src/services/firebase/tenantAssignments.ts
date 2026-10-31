import { getCachedList, invalidateOwnerDataCache } from './listCache'

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

import { getCurrentActorUid, getFirebaseServices } from './client'
import { parseIdentifierNumber } from './identifiers'
import {
  tenantAssignmentFormSchema,
  tenantMoveOutSchema,
  type TenantAssignmentFormValues,
  type TenantAssignmentStatus,
  type TenantMoveOutFormValues,
} from '../../schemas/tenantAssignment'

export type TenantAssignmentRecord = {
  id: string
  tenantId: string
  tenantCode: string
  tenantName: string
  roomId: string
  roomCode: string
  roomNumber: string
  floorName: string
  propertyId: string
  propertyCode: string
  moveInDate: string
  moveOutDate: string | null
  status: TenantAssignmentStatus
  notes: string
  moveOutNotes: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export class TenantAssignmentConflictError extends Error {
  constructor(message = 'The selected room already has a current tenant, or the saved assignment indexes are inconsistent.') {
    super(message)
    this.name = 'TenantAssignmentConflictError'
  }
}

export class TenantAssignmentNotFoundError extends Error {
  constructor() {
    super('This tenant assignment no longer exists. Refresh and try again.')
    this.name = 'TenantAssignmentNotFoundError'
  }
}

export class TenantAssignmentAlreadyEndedError extends Error {
  constructor() {
    super('This assignment has already ended. Refresh the list and try again.')
    this.name = 'TenantAssignmentAlreadyEndedError'
  }
}

export class TenantUnavailableForAssignmentError extends Error {
  constructor() {
    super('The selected tenant is missing or archived. Choose an active tenant.')
    this.name = 'TenantUnavailableForAssignmentError'
  }
}

export class RoomUnavailableForAssignmentError extends Error {
  constructor() {
    super('The selected room is missing, not vacant, or its property is inactive.')
    this.name = 'RoomUnavailableForAssignmentError'
  }
}

export class InvalidTenantAssignmentDataError extends Error {
  constructor(message = 'Saved assignment data is invalid. No changes were made.') {
    super(message)
    this.name = 'InvalidTenantAssignmentDataError'
  }
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function getAssignmentRef(ownerUid: string, assignmentId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'tenantAssignments', assignmentId)
}

function getRoomCurrentIndexRef(ownerUid: string, roomId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'currentTenantByRoom', roomId)
}

function getTenantCurrentIndexRef(ownerUid: string, tenantId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'currentRoomByTenant', tenantId)
}

function validateAssignmentRecord(
  assignmentId: string,
  data: Record<string, unknown>,
): TenantAssignmentRecord {

  if (
    typeof data.tenantId !== 'string' ||
    !data.tenantId ||
    typeof data.tenantCode !== 'string' ||
    parseIdentifierNumber('tenant', data.tenantCode) === null ||
    typeof data.tenantName !== 'string' ||
    typeof data.roomId !== 'string' ||
    !data.roomId ||
    typeof data.roomCode !== 'string' ||
    parseIdentifierNumber('room', data.roomCode) === null ||
    typeof data.roomNumber !== 'string' ||
    typeof data.floorName !== 'string' ||
    typeof data.propertyId !== 'string' ||
    typeof data.propertyCode !== 'string' ||
    parseIdentifierNumber('property', data.propertyCode) === null ||
    !validIsoDate(data.moveInDate) ||
    !(data.moveOutDate === null || validIsoDate(data.moveOutDate)) ||
    (data.status !== 'current' && data.status !== 'ended') ||
    typeof data.notes !== 'string' ||
    typeof data.moveOutNotes !== 'string' ||
    typeof data.createdBy !== 'string' ||
    typeof data.updatedBy !== 'string' ||
    (data.status === 'current' && (data.moveOutDate !== null || data.moveOutNotes !== '')) ||
    (data.status === 'ended' &&
      (typeof data.moveOutDate !== 'string' || data.moveOutDate < data.moveInDate))
  ) {
    throw new InvalidTenantAssignmentDataError(
      `Tenant assignment ${assignmentId} contains invalid stored data.`,
    )
  }

  return {
    id: assignmentId,
    tenantId: data.tenantId,
    tenantCode: data.tenantCode,
    tenantName: data.tenantName,
    roomId: data.roomId,
    roomCode: data.roomCode,
    roomNumber: data.roomNumber,
    floorName: data.floorName,
    propertyId: data.propertyId,
    propertyCode: data.propertyCode,
    moveInDate: data.moveInDate,
    moveOutDate: data.moveOutDate as string | null,
    status: data.status as TenantAssignmentStatus,
    notes: data.notes,
    moveOutNotes: data.moveOutNotes,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt : null,
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : null,
    createdBy: data.createdBy,
    updatedBy: data.updatedBy,
  }
}

export async function listTenantAssignments(
  ownerUid: string,
): Promise<TenantAssignmentRecord[]> {
  return getCachedList(ownerUid, 'TenantAssignments', async () => {
    const { db } = getFirebaseServices()
    const assignmentsRef = collection(db, 'users', ownerUid, 'tenantAssignments')
    const snapshot = await getDocs(query(assignmentsRef, orderBy('createdAt', 'desc')))

    return snapshot.docs.map((assignmentDocument) =>
      validateAssignmentRecord(
        assignmentDocument.id,
        assignmentDocument.data() as Record<string, unknown>,
      ),
    )
  })
}

export async function createTenantAssignment(
  ownerUid: string,
  rawInput: TenantAssignmentFormValues,
): Promise<string> {
  const input = tenantAssignmentFormSchema.parse(rawInput)
  const { db } = getFirebaseServices()

  const tenantRef = doc(db, 'users', ownerUid, 'tenants', input.tenantId)
  const roomRef = doc(db, 'users', ownerUid, 'rooms', input.roomId)
  const assignmentRef = doc(collection(db, 'users', ownerUid, 'tenantAssignments'))
  const roomIndexRef = getRoomCurrentIndexRef(ownerUid, input.roomId)
  const tenantIndexRef = getTenantCurrentIndexRef(ownerUid, input.tenantId)

  await runTransaction(db, async (transaction) => {
    const [tenantSnapshot, roomSnapshot, roomIndexSnapshot, tenantIndexSnapshot] =
      await Promise.all([
        transaction.get(tenantRef),
        transaction.get(roomRef),
        transaction.get(roomIndexRef),
        transaction.get(tenantIndexRef),
      ])

    if (!tenantSnapshot.exists()) {
      throw new TenantUnavailableForAssignmentError()
    }

    const tenant = tenantSnapshot.data()

    if (
      tenant.status !== 'active' ||
      typeof tenant.tenantCode !== 'string' ||
      parseIdentifierNumber('tenant', tenant.tenantCode) === null ||
      typeof tenant.fullName !== 'string'
    ) {
      throw new TenantUnavailableForAssignmentError()
    }

    if (!roomSnapshot.exists()) {
      throw new RoomUnavailableForAssignmentError()
    }

    const room = roomSnapshot.data()

    if (
      room.status !== 'vacant' ||
      typeof room.roomCode !== 'string' ||
      parseIdentifierNumber('room', room.roomCode) === null ||
      typeof room.roomNumber !== 'string' ||
      typeof room.floorName !== 'string' ||
      typeof room.propertyId !== 'string' ||
      typeof room.propertyCode !== 'string' ||
      parseIdentifierNumber('property', room.propertyCode) === null
    ) {
      throw new RoomUnavailableForAssignmentError()
    }

    if (roomIndexSnapshot.exists()) {
      throw new TenantAssignmentConflictError(
        'This room already has a current tenant. Move that tenant out before assigning another person.',
      )
    }

    // `currentRoomByTenant/{tenantId}` is retained as a legacy reverse pointer
    // for older records. It no longer limits a tenant to one room. When it
    // exists, verify that it still points to another current assignment for
    // this same tenant; new room assignments are indexed by room only.
    if (tenantIndexSnapshot.exists()) {
      const legacyIndex = tenantIndexSnapshot.data()
      if (
        legacyIndex.tenantId !== input.tenantId ||
        typeof legacyIndex.assignmentId !== 'string' ||
        !legacyIndex.assignmentId
      ) {
        throw new TenantAssignmentConflictError(
          'The tenant’s legacy assignment index is inconsistent. Refresh and review the assignment history before adding another room.',
        )
      }

      const legacyAssignmentSnapshot = await transaction.get(
        getAssignmentRef(ownerUid, legacyIndex.assignmentId),
      )
      if (
        !legacyAssignmentSnapshot.exists() ||
        legacyAssignmentSnapshot.data().status !== 'current' ||
        legacyAssignmentSnapshot.data().tenantId !== input.tenantId
      ) {
        throw new TenantAssignmentConflictError(
          'The tenant’s legacy assignment pointer is outdated. Review the current assignments before adding another room.',
        )
      }
    }

    const propertyRef = doc(db, 'users', ownerUid, 'properties', room.propertyId)
    const propertySnapshot = await transaction.get(propertyRef)

    if (
      !propertySnapshot.exists() ||
      propertySnapshot.data().status !== 'active' ||
      propertySnapshot.data().propertyCode !== room.propertyCode
    ) {
      throw new RoomUnavailableForAssignmentError()
    }

    const assignmentData = {
      tenantId: input.tenantId,
      tenantCode: tenant.tenantCode,
      tenantName: tenant.fullName,
      roomId: input.roomId,
      roomCode: room.roomCode,
      roomNumber: room.roomNumber,
      floorName: room.floorName,
      propertyId: room.propertyId,
      propertyCode: room.propertyCode,
      moveInDate: input.moveInDate,
      moveOutDate: null,
      status: 'current',
      notes: input.notes.trim(),
      moveOutNotes: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
    }

    const indexData = {
      tenantId: input.tenantId,
      tenantCode: tenant.tenantCode,
      tenantName: tenant.fullName,
      roomId: input.roomId,
      roomCode: room.roomCode,
      roomNumber: room.roomNumber,
      floorName: room.floorName,
      propertyId: room.propertyId,
      propertyCode: room.propertyCode,
      assignmentId: assignmentRef.id,
      moveInDate: input.moveInDate,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }

    transaction.set(assignmentRef, assignmentData)
    transaction.set(roomIndexRef, indexData)

    // New assignments do not write `currentRoomByTenant`: that legacy index
    // represented only one room per tenant. All current rooms are derived from
    // tenantAssignments, while currentTenantByRoom guarantees room uniqueness.
  })

  invalidateOwnerDataCache(ownerUid)
  return assignmentRef.id
}

export async function endTenantAssignment(
  ownerUid: string,
  assignmentId: string,
  rawInput: TenantMoveOutFormValues,
): Promise<void> {
  const input = tenantMoveOutSchema.parse(rawInput)
  const { db } = getFirebaseServices()

  const assignmentRef = getAssignmentRef(ownerUid, assignmentId)

  await runTransaction(db, async (transaction) => {
    const assignmentSnapshot = await transaction.get(assignmentRef)

    if (!assignmentSnapshot.exists()) {
      throw new TenantAssignmentNotFoundError()
    }

    const assignment = validateAssignmentRecord(
      assignmentSnapshot.id,
      assignmentSnapshot.data() as Record<string, unknown>,
    )

    if (assignment.status !== 'current') {
      throw new TenantAssignmentAlreadyEndedError()
    }

    if (input.moveOutDate < assignment.moveInDate) {
      throw new InvalidTenantAssignmentDataError(
        'Move-out date cannot be earlier than the move-in date.',
      )
    }

    const roomIndexRef = getRoomCurrentIndexRef(ownerUid, assignment.roomId)
    const tenantIndexRef = getTenantCurrentIndexRef(ownerUid, assignment.tenantId)
    const [roomIndexSnapshot, tenantIndexSnapshot] = await Promise.all([
      transaction.get(roomIndexRef),
      transaction.get(tenantIndexRef),
    ])

    if (
      !roomIndexSnapshot.exists() ||
      roomIndexSnapshot.data().assignmentId !== assignmentId
    ) {
      throw new TenantAssignmentConflictError(
        'The room’s current assignment index does not match this record. No changes were made.',
      )
    }

    let shouldRemoveLegacyTenantIndex = false
    if (tenantIndexSnapshot.exists()) {
      const legacyIndex = tenantIndexSnapshot.data()
      if (
        legacyIndex.tenantId !== assignment.tenantId ||
        typeof legacyIndex.assignmentId !== 'string'
      ) {
        throw new TenantAssignmentConflictError(
          'The tenant’s legacy assignment index is invalid. No changes were made.',
        )
      }

      if (legacyIndex.assignmentId === assignmentId) {
        shouldRemoveLegacyTenantIndex = true
      } else {
        // Another room remains linked to the same tenant. Keep its legacy
        // pointer intact while ending only this room’s assignment.
        const otherAssignmentSnapshot = await transaction.get(
          getAssignmentRef(ownerUid, legacyIndex.assignmentId),
        )
        if (
          !otherAssignmentSnapshot.exists() ||
          otherAssignmentSnapshot.data().status !== 'current' ||
          otherAssignmentSnapshot.data().tenantId !== assignment.tenantId
        ) {
          throw new TenantAssignmentConflictError(
            'The tenant’s remaining room assignment could not be verified. No changes were made.',
          )
        }
      }
    }

    transaction.update(assignmentRef, {
      moveOutDate: input.moveOutDate,
      status: 'ended',
      moveOutNotes: input.moveOutNotes.trim(),
      updatedAt: serverTimestamp(),
      updatedBy: getCurrentActorUid(),
    })

    transaction.delete(roomIndexRef)
    if (shouldRemoveLegacyTenantIndex) {
      transaction.delete(tenantIndexRef)
    }
  })

  invalidateOwnerDataCache(ownerUid)
}

export function getTenantAssignmentErrorMessage(error: unknown): string {
  if (
    error instanceof TenantAssignmentConflictError ||
    error instanceof TenantAssignmentNotFoundError ||
    error instanceof TenantAssignmentAlreadyEndedError ||
    error instanceof TenantUnavailableForAssignmentError ||
    error instanceof RoomUnavailableForAssignmentError ||
    error instanceof InvalidTenantAssignmentDataError
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
        : 'Something went wrong while accessing tenant assignments.'
  }
}
