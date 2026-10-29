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

import { getFirebaseServices } from './client'
import {
  commitIdentifierReservation,
  IdentifierLimitReachedError,
  InvalidIdentifierSequenceError,
  parseIdentifierNumber,
  reserveNextIdentifier,
} from './identifiers'

import {
  meterFormSchema,
  meterAssignmentFormSchema,
  meterReplacementFormSchema,
  type MeterFormValues,
  type MeterStatus,
  type MeterAssignmentStatus,
  type MeterReplacementReason,
} from '../../schemas/meter'

export type MeterRecord = {
  id: string
  meterCode: string
  serialNumber: string
  notes: string
  status: MeterStatus
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type MeterAssignmentRecord = {
  id: string
  meterId: string
  meterCode: string
  roomId: string
  roomCode: string
  propertyId: string
  propertyCode: string
  status: MeterAssignmentStatus
  assignedOn: string
  initialReading: number
  endedOn: string | null
  finalReading: number | null
  endReason: MeterReplacementReason | null
  endNotes: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

type MeterIndex = {
  meterId: string
  meterCode: string
  roomId: string
  assignmentId: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
}

export class MeterNotFoundError extends Error {
  constructor() {
    super('The selected meter could not be found.')
    this.name = 'MeterNotFoundError'
  }
}

export class RoomNotFoundForMeterError extends Error {
  constructor() {
    super('The selected room could not be found.')
    this.name = 'RoomNotFoundForMeterError'
  }
}

export class MeterUnavailableError extends Error {
  constructor() {
    super('This meter is not available for assignment.')
    this.name = 'MeterUnavailableError'
  }
}

export class RoomAlreadyHasMeterError extends Error {
  constructor() {
    super('This room already has a current meter. Use Replace Meter instead.')
    this.name = 'RoomAlreadyHasMeterError'
  }
}

export class MeterAlreadyAssignedError extends Error {
  constructor() {
    super('This meter is already assigned to a room.')
    this.name = 'MeterAlreadyAssignedError'
  }
}

export class MeterAssignmentNotFoundError extends Error {
  constructor() {
    super('The current meter assignment was not found. Refresh and try again.')
    this.name = 'MeterAssignmentNotFoundError'
  }
}

export class MeterHistoryIntegrityError extends Error {
  constructor() {
    super('Meter assignment history is inconsistent. No changes were made.')
    this.name = 'MeterHistoryIntegrityError'
  }
}

export class InvalidMeterDateError extends Error {
  constructor() {
    super('The replacement date cannot be earlier than the assignment date.')
    this.name = 'InvalidMeterDateError'
  }
}

function getMeterRef(ownerUid: string, meterId: string) {
  const { db } = getFirebaseServices()

  return doc(db, 'users', ownerUid, 'meters', meterId)
}

function getRoomRef(ownerUid: string, roomId: string) {
  const { db } = getFirebaseServices()

  return doc(db, 'users', ownerUid, 'rooms', roomId)
}

function getPropertyRef(ownerUid: string, propertyId: string) {
  const { db } = getFirebaseServices()

  return doc(db, 'users', ownerUid, 'properties', propertyId)
}

function getAssignmentRef(
  ownerUid: string,
  assignmentId: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'meterAssignments',
    assignmentId,
  )
}

function getCurrentMeterByRoomRef(
  ownerUid: string,
  roomId: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'currentMeterByRoom',
    roomId,
  )
}

function getCurrentAssignmentByMeterRef(
  ownerUid: string,
  meterId: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'currentAssignmentByMeter',
    meterId,
  )
}

function prepareMeterInput(
  rawInput: MeterFormValues,
): MeterFormValues {
  const input = meterFormSchema.parse(rawInput)

  return {
    serialNumber: input.serialNumber.trim(),
    notes: input.notes.trim(),
  }
}

function ensureValidMeterCode(value: unknown): string {
  if (
    typeof value !== 'string' ||
    parseIdentifierNumber('meter', value) === null
  ) {
    throw new MeterHistoryIntegrityError()
  }

  return value
}

function ensureValidDate(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new MeterHistoryIntegrityError()
  }

  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new MeterHistoryIntegrityError()
  }
}

function readMeterIndex(
  data: Record<string, unknown>,
): MeterIndex {
  if (
    typeof data.meterId !== 'string' ||
    typeof data.meterCode !== 'string' ||
    parseIdentifierNumber('meter', data.meterCode) === null ||
    typeof data.roomId !== 'string' ||
    typeof data.assignmentId !== 'string'
  ) {
    throw new MeterHistoryIntegrityError()
  }

  return {
    meterId: data.meterId,
    meterCode: data.meterCode,
    roomId: data.roomId,
    assignmentId: data.assignmentId,
    createdAt:
      data.createdAt instanceof Timestamp ? data.createdAt : null,
    updatedAt:
      data.updatedAt instanceof Timestamp ? data.updatedAt : null,
  }
}

function validateMeterRecord(
  id: string,
  data: Record<string, unknown>,
): MeterRecord {
  const meterCode = ensureValidMeterCode(data.meterCode)

  if (
    typeof data.serialNumber !== 'string' ||
    typeof data.notes !== 'string' ||
    typeof data.createdBy !== 'string' ||
    typeof data.updatedBy !== 'string' ||
    !['available', 'assigned', 'retired'].includes(
      String(data.status),
    )
  ) {
    throw new Error(`Meter ${id} contains invalid stored data.`)
  }

  return {
    id,
    meterCode,
    serialNumber: data.serialNumber,
    notes: data.notes,
    status: data.status as MeterStatus,
    createdAt:
      data.createdAt instanceof Timestamp ? data.createdAt : null,
    updatedAt:
      data.updatedAt instanceof Timestamp ? data.updatedAt : null,
    createdBy: data.createdBy,
    updatedBy: data.updatedBy,
  }
}

function validateAssignmentRecord(
  id: string,
  data: Record<string, unknown>,
): MeterAssignmentRecord {
  if (
    typeof data.meterId !== 'string' ||
    typeof data.roomId !== 'string' ||
    typeof data.roomCode !== 'string' ||
    typeof data.propertyId !== 'string' ||
    typeof data.propertyCode !== 'string' ||
    typeof data.assignedOn !== 'string' ||
    typeof data.initialReading !== 'number' ||
    !Number.isFinite(data.initialReading) ||
    data.initialReading < 0 ||
    !['current', 'ended'].includes(String(data.status)) ||
    typeof data.createdBy !== 'string' ||
    typeof data.updatedBy !== 'string' ||
    (data.endedOn !== null && typeof data.endedOn !== 'string') ||
    (data.finalReading !== null &&
      (typeof data.finalReading !== 'number' ||
        !Number.isFinite(data.finalReading) ||
        data.finalReading < 0)) ||
    (data.endReason !== null &&
      !['damaged', 'overreading', 'slow_reading', 'other'].includes(
        String(data.endReason),
      )) ||
    typeof data.endNotes !== 'string'
  ) {
    throw new Error(`Meter assignment ${id} contains invalid stored data.`)
  }

  ensureValidDate(data.assignedOn)

  if (data.endedOn !== null) {
    ensureValidDate(data.endedOn)
  }

  return {
    id,
    meterId: data.meterId,
    meterCode: ensureValidMeterCode(data.meterCode),
    roomId: data.roomId,
    roomCode: data.roomCode,
    propertyId: data.propertyId,
    propertyCode: data.propertyCode,
    status: data.status as MeterAssignmentStatus,
    assignedOn: data.assignedOn,
    initialReading: data.initialReading,
    endedOn: data.endedOn,
    finalReading: data.finalReading,
    endReason: data.endReason as MeterReplacementReason | null,
    endNotes: data.endNotes,
    createdAt:
      data.createdAt instanceof Timestamp ? data.createdAt : null,
    updatedAt:
      data.updatedAt instanceof Timestamp ? data.updatedAt : null,
    createdBy: data.createdBy,
    updatedBy: data.updatedBy,
  }
}

export async function listMeters(
  ownerUid: string,
): Promise<MeterRecord[]> {
  const { db } = getFirebaseServices()

  const metersRef = collection(db, 'users', ownerUid, 'meters')

  const snapshot = await getDocs(
    query(metersRef, orderBy('createdAt', 'desc')),
  )

  return snapshot.docs.map((item) =>
    validateMeterRecord(item.id, item.data()),
  )
}

export async function listMeterAssignments(
  ownerUid: string,
): Promise<MeterAssignmentRecord[]> {
  const { db } = getFirebaseServices()

  const assignmentsRef = collection(
    db,
    'users',
    ownerUid,
    'meterAssignments',
  )

  const snapshot = await getDocs(
    query(assignmentsRef, orderBy('createdAt', 'desc')),
  )

  return snapshot.docs.map((item) =>
    validateAssignmentRecord(item.id, item.data()),
  )
}

export async function createMeter(
  ownerUid: string,
  rawInput: MeterFormValues,
): Promise<string> {
  const input = prepareMeterInput(rawInput)
  const { db } = getFirebaseServices()

  const metersRef = collection(db, 'users', ownerUid, 'meters')
  const meterRef = doc(metersRef)

  await runTransaction(db, async (transaction) => {
    const reservation = await reserveNextIdentifier(
      transaction,
      ownerUid,
      'meter',
    )

    transaction.set(meterRef, {
      meterCode: reservation.code,
      serialNumber: input.serialNumber,
      notes: input.notes,
      status: 'available',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ownerUid,
      updatedBy: ownerUid,
    })

    commitIdentifierReservation(transaction, reservation)
  })

  return meterRef.id
}

export async function assignMeter(
  ownerUid: string,
  meterId: string,
  rawInput: unknown,
): Promise<string> {
  const input = meterAssignmentFormSchema.parse(rawInput)
  const { db } = getFirebaseServices()

  const meterRef = getMeterRef(ownerUid, meterId)
  const roomRef = getRoomRef(ownerUid, input.roomId)

  const roomIndexRef = getCurrentMeterByRoomRef(
    ownerUid,
    input.roomId,
  )

  const meterIndexRef = getCurrentAssignmentByMeterRef(
    ownerUid,
    meterId,
  )

  const assignmentRef = doc(
    collection(db, 'users', ownerUid, 'meterAssignments'),
  )

  await runTransaction(db, async (transaction) => {
    const [
      meterSnapshot,
      roomSnapshot,
      roomIndexSnapshot,
      meterIndexSnapshot,
    ] = await Promise.all([
      transaction.get(meterRef),
      transaction.get(roomRef),
      transaction.get(roomIndexRef),
      transaction.get(meterIndexRef),
    ])

    if (!meterSnapshot.exists()) {
      throw new MeterNotFoundError()
    }

    if (!roomSnapshot.exists()) {
      throw new RoomNotFoundForMeterError()
    }

    if (roomIndexSnapshot.exists()) {
      throw new RoomAlreadyHasMeterError()
    }

    if (meterIndexSnapshot.exists()) {
      throw new MeterAlreadyAssignedError()
    }

    const meterData = meterSnapshot.data()
    const roomData = roomSnapshot.data()

    if (
      meterData.status !== 'available' ||
      typeof meterData.meterCode !== 'string'
    ) {
      throw new MeterUnavailableError()
    }

    if (
      roomData.status === 'inactive' ||
      typeof roomData.roomCode !== 'string' ||
      typeof roomData.propertyId !== 'string' ||
      typeof roomData.propertyCode !== 'string'
    ) {
      throw new RoomNotFoundForMeterError()
    }

    const propertyRef = getPropertyRef(
      ownerUid,
      roomData.propertyId,
    )

    const propertySnapshot = await transaction.get(propertyRef)

    if (
      !propertySnapshot.exists() ||
      propertySnapshot.data().status !== 'active' ||
      propertySnapshot.data().propertyCode !== roomData.propertyCode
    ) {
      throw new RoomNotFoundForMeterError()
    }

    const meterCode = ensureValidMeterCode(meterData.meterCode)

    transaction.set(assignmentRef, {
      meterId,
      meterCode,
      roomId: input.roomId,
      roomCode: roomData.roomCode,
      propertyId: roomData.propertyId,
      propertyCode: roomData.propertyCode,
      status: 'current',
      assignedOn: input.assignedOn,
      initialReading: input.initialReading,
      endedOn: null,
      finalReading: null,
      endReason: null,
      endNotes: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ownerUid,
      updatedBy: ownerUid,
    })

    transaction.update(meterRef, {
      status: 'assigned',
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    })

    transaction.set(roomIndexRef, {
      meterId,
      meterCode,
      roomId: input.roomId,
      assignmentId: assignmentRef.id,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    transaction.set(meterIndexRef, {
      meterId,
      meterCode,
      roomId: input.roomId,
      assignmentId: assignmentRef.id,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  })

  return assignmentRef.id
}

export async function replaceMeter(
  ownerUid: string,
  oldMeterId: string,
  rawInput: unknown,
): Promise<string> {
  const input = meterReplacementFormSchema.parse(rawInput)
  const { db } = getFirebaseServices()

  const oldMeterRef = getMeterRef(ownerUid, oldMeterId)
  const oldMeterIndexRef = getCurrentAssignmentByMeterRef(
    ownerUid,
    oldMeterId,
  )

  const newMeterRef = doc(
    collection(db, 'users', ownerUid, 'meters'),
  )

  const newAssignmentRef = doc(
    collection(db, 'users', ownerUid, 'meterAssignments'),
  )

  await runTransaction(db, async (transaction) => {
    const [oldMeterSnapshot, oldIndexSnapshot] =
      await Promise.all([
        transaction.get(oldMeterRef),
        transaction.get(oldMeterIndexRef),
      ])

    if (!oldMeterSnapshot.exists()) {
      throw new MeterNotFoundError()
    }

    if (!oldIndexSnapshot.exists()) {
      throw new MeterAssignmentNotFoundError()
    }

    const oldIndex = readMeterIndex(oldIndexSnapshot.data())
    const oldAssignmentRef = getAssignmentRef(
      ownerUid,
      oldIndex.assignmentId,
    )

    const roomRef = getRoomRef(ownerUid, oldIndex.roomId)
    const roomIndexRef = getCurrentMeterByRoomRef(
      ownerUid,
      oldIndex.roomId,
    )

    const [
      oldAssignmentSnapshot,
      roomSnapshot,
      roomIndexSnapshot,
    ] = await Promise.all([
      transaction.get(oldAssignmentRef),
      transaction.get(roomRef),
      transaction.get(roomIndexRef),
    ])

    if (
      !oldAssignmentSnapshot.exists() ||
      !roomSnapshot.exists() ||
      !roomIndexSnapshot.exists()
    ) {
      throw new MeterAssignmentNotFoundError()
    }

    const oldAssignment = oldAssignmentSnapshot.data()
    const roomData = roomSnapshot.data()
    const roomIndex = roomIndexSnapshot.data()
    const oldMeterData = oldMeterSnapshot.data()

    if (
      oldAssignment.status !== 'current' ||
      oldAssignment.meterId !== oldMeterId ||
      oldAssignment.roomId !== oldIndex.roomId ||
      roomIndex.assignmentId !== oldIndex.assignmentId ||
      roomIndex.meterId !== oldMeterId ||
      oldMeterData.status !== 'assigned'
    ) {
      throw new MeterHistoryIntegrityError()
    }

    if (input.replacementDate < oldAssignment.assignedOn) {
      throw new InvalidMeterDateError()
    }

    if (
      typeof roomData.roomCode !== 'string' ||
      typeof roomData.propertyId !== 'string' ||
      typeof roomData.propertyCode !== 'string'
    ) {
      throw new MeterHistoryIntegrityError()
    }

    const reservation = await reserveNextIdentifier(
      transaction,
      ownerUid,
      'meter',
    )

    const newMeterCode = reservation.code
    const oldMeterCode = ensureValidMeterCode(
      oldMeterData.meterCode,
    )

    // End the old assignment; never delete it.
    transaction.update(oldAssignmentRef, {
      status: 'ended',
      endedOn: input.replacementDate,
      finalReading: input.finalReading,
      endReason: input.reason,
      endNotes: input.notes,
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    })

    transaction.update(oldMeterRef, {
      status: 'retired',
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    })

    // Create a brand-new meter with a separate permanent ID.
    transaction.set(newMeterRef, {
      meterCode: newMeterCode,
      serialNumber: input.newSerialNumber.trim(),
      notes: input.notes.trim(),
      status: 'assigned',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ownerUid,
      updatedBy: ownerUid,
    })

    // Preserve the history of the room-to-meter relationship.
    transaction.set(newAssignmentRef, {
      meterId: newMeterRef.id,
      meterCode: newMeterCode,
      roomId: oldIndex.roomId,
      roomCode: roomData.roomCode,
      propertyId: roomData.propertyId,
      propertyCode: roomData.propertyCode,
      status: 'current',
      assignedOn: input.replacementDate,
      initialReading: input.newInitialReading,
      endedOn: null,
      finalReading: null,
      endReason: null,
      endNotes: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ownerUid,
      updatedBy: ownerUid,
    })

    // The old meter is no longer current.
    transaction.delete(oldMeterIndexRef)

    // Point the new meter to its new current assignment.
    transaction.set(
      getCurrentAssignmentByMeterRef(ownerUid, newMeterRef.id),
      {
        meterId: newMeterRef.id,
        meterCode: newMeterCode,
        roomId: oldIndex.roomId,
        assignmentId: newAssignmentRef.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    )

    // Update the existing room index to use the new meter.
    transaction.update(roomIndexRef, {
      meterId: newMeterRef.id,
      meterCode: newMeterCode,
      roomId: oldIndex.roomId,
      assignmentId: newAssignmentRef.id,
      updatedAt: serverTimestamp(),
    })

    commitIdentifierReservation(transaction, reservation)

    // Defensive check that the replacement is for the meter
    // recorded in the current assignment index.
    if (oldIndex.meterCode !== oldMeterCode) {
      throw new MeterHistoryIntegrityError()
    }
  })

  return newMeterRef.id
}

export function getMeterErrorMessage(error: unknown): string {
  if (
    error instanceof MeterNotFoundError ||
    error instanceof RoomNotFoundForMeterError ||
    error instanceof MeterUnavailableError ||
    error instanceof RoomAlreadyHasMeterError ||
    error instanceof MeterAlreadyAssignedError ||
    error instanceof MeterAssignmentNotFoundError ||
    error instanceof MeterHistoryIntegrityError ||
    error instanceof InvalidMeterDateError ||
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
        : 'Something went wrong while accessing meters.'
  }
}