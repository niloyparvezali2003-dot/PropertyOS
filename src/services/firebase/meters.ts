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
  where,
} from 'firebase/firestore'

import { getCurrentActorUid, getFirebaseServices } from './client'
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

export class MeterAssignmentHasReadingsError extends Error {
  constructor() {
    super('This meter assignment already has a saved reading or bill. Room correction is locked to protect its financial history.')
    this.name = 'MeterAssignmentHasReadingsError'
  }
}

export class MeterCancellationHasHistoryError extends Error {
  constructor() {
    super('This meter assignment already has a saved reading, bill, or reading-state record. Cancellation is blocked to protect its history.')
    this.name = 'MeterCancellationHasHistoryError'
  }
}

export class MeterCancellationNotAllowedError extends Error {
  constructor() {
    super('This meter cannot be cancelled. Refresh the page and confirm that it is still assigned and has never been used.')
    this.name = 'MeterCancellationNotAllowedError'
  }
}

export class MeterCorrectionTargetUnavailableError extends Error {
  constructor() {
    super('The selected room is no longer available. Refresh the meter list and choose another room.')
    this.name = 'MeterCorrectionTargetUnavailableError'
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
    !['available', 'assigned', 'retired', 'voided'].includes(
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
  return getCachedList(ownerUid, 'Meters', async () => {
    const { db } = getFirebaseServices()

    const metersRef = collection(db, 'users', ownerUid, 'meters')

    const snapshot = await getDocs(
      query(metersRef, orderBy('createdAt', 'desc')),
    )

    return snapshot.docs.map((item) =>
      validateMeterRecord(item.id, item.data()),
    )
  })
}

export async function listMeterAssignments(
  ownerUid: string,
): Promise<MeterAssignmentRecord[]> {
  return getCachedList(ownerUid, 'MeterAssignments', async () => {
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
  })
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
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
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
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
    })

    transaction.update(meterRef, {
      status: 'assigned',
      updatedAt: serverTimestamp(),
      updatedBy: getCurrentActorUid(),
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

/**
 * Corrects a mistaken room link without replacing the physical meter.
 * This action is intentionally limited to assignments with no readings or
 * issued bills. The old assignment is ended and a new assignment is created
 * with the same meter ID, original assignment date, and initial reading.
 */
export async function correctMeterRoomAssignment(
  ownerUid: string,
  meterId: string,
  currentAssignment: MeterAssignmentRecord,
  targetRoomId: string,
  reason: string,
): Promise<string> {
  const correctionReason = reason.trim()
  if (!ownerUid.trim() || !meterId.trim() || !targetRoomId.trim()) {
    throw new MeterCorrectionTargetUnavailableError()
  }
  if (correctionReason.length < 10 || correctionReason.length > 700) {
    throw new MeterCorrectionTargetUnavailableError()
  }
  if (currentAssignment.meterId !== meterId || currentAssignment.status !== 'current') {
    throw new MeterAssignmentNotFoundError()
  }
  if (currentAssignment.roomId === targetRoomId) {
    throw new MeterCorrectionTargetUnavailableError()
  }

  const { db } = getFirebaseServices()
  const readingCollection = collection(db, 'users', ownerUid, 'electricityReadings')
  const billCollection = collection(db, 'users', ownerUid, 'electricityBills')
  const [readingMatches, billMatches] = await Promise.all([
    getDocs(query(readingCollection, where('meterAssignmentId', '==', currentAssignment.id))),
    getDocs(query(billCollection, where('meterAssignmentId', '==', currentAssignment.id))),
  ])

  if (!readingMatches.empty || !billMatches.empty) {
    throw new MeterAssignmentHasReadingsError()
  }

  const meterRef = getMeterRef(ownerUid, meterId)
  const oldAssignmentRef = getAssignmentRef(ownerUid, currentAssignment.id)
  const oldRoomIndexRef = getCurrentMeterByRoomRef(ownerUid, currentAssignment.roomId)
  const targetRoomRef = getRoomRef(ownerUid, targetRoomId)
  const targetRoomIndexRef = getCurrentMeterByRoomRef(ownerUid, targetRoomId)
  const meterIndexRef = getCurrentAssignmentByMeterRef(ownerUid, meterId)
  const readingStateRef = doc(db, 'users', ownerUid, 'electricityReadingState', currentAssignment.id)
  const newAssignmentRef = doc(collection(db, 'users', ownerUid, 'meterAssignments'))
  const actorUid = getCurrentActorUid()

  await runTransaction(db, async (transaction) => {
    const [
      meterSnapshot,
      oldAssignmentSnapshot,
      oldRoomIndexSnapshot,
      targetRoomSnapshot,
      targetRoomIndexSnapshot,
      meterIndexSnapshot,
      readingStateSnapshot,
    ] = await Promise.all([
      transaction.get(meterRef),
      transaction.get(oldAssignmentRef),
      transaction.get(oldRoomIndexRef),
      transaction.get(targetRoomRef),
      transaction.get(targetRoomIndexRef),
      transaction.get(meterIndexRef),
      transaction.get(readingStateRef),
    ])

    if (
      !meterSnapshot.exists() ||
      !oldAssignmentSnapshot.exists() ||
      !oldRoomIndexSnapshot.exists() ||
      !targetRoomSnapshot.exists() ||
      !meterIndexSnapshot.exists()
    ) {
      throw new MeterAssignmentNotFoundError()
    }

    // The reading writer also reads/writes this state document in its
    // transaction. This prevents a concurrent reading from racing a correction.
    if (readingStateSnapshot.exists()) {
      throw new MeterAssignmentHasReadingsError()
    }

    if (targetRoomIndexSnapshot.exists()) {
      throw new RoomAlreadyHasMeterError()
    }

    const meterData = meterSnapshot.data()
    const oldAssignmentData = oldAssignmentSnapshot.data()
    const oldRoomIndex = readMeterIndex(oldRoomIndexSnapshot.data())
    const meterIndex = readMeterIndex(meterIndexSnapshot.data())
    const targetRoomData = targetRoomSnapshot.data()

    if (
      meterData.status !== 'assigned' ||
      meterData.meterCode !== currentAssignment.meterCode ||
      oldAssignmentData.status !== 'current' ||
      oldAssignmentData.meterId !== meterId ||
      oldAssignmentData.roomId !== currentAssignment.roomId ||
      oldAssignmentData.meterCode !== currentAssignment.meterCode ||
      oldAssignmentData.assignedOn !== currentAssignment.assignedOn ||
      oldAssignmentData.initialReading !== currentAssignment.initialReading ||
      oldRoomIndex.assignmentId !== currentAssignment.id ||
      oldRoomIndex.meterId !== meterId ||
      oldRoomIndex.roomId !== currentAssignment.roomId ||
      meterIndex.assignmentId !== currentAssignment.id ||
      meterIndex.meterId !== meterId ||
      meterIndex.roomId !== currentAssignment.roomId
    ) {
      throw new MeterHistoryIntegrityError()
    }

    if (
      targetRoomData.status === 'inactive' ||
      typeof targetRoomData.roomCode !== 'string' ||
      typeof targetRoomData.propertyId !== 'string' ||
      typeof targetRoomData.propertyCode !== 'string'
    ) {
      throw new MeterCorrectionTargetUnavailableError()
    }

    const targetPropertySnapshot = await transaction.get(
      getPropertyRef(ownerUid, targetRoomData.propertyId),
    )
    if (
      !targetPropertySnapshot.exists() ||
      targetPropertySnapshot.data().status !== 'active' ||
      targetPropertySnapshot.data().propertyCode !== targetRoomData.propertyCode
    ) {
      throw new MeterCorrectionTargetUnavailableError()
    }

    const meterCode = ensureValidMeterCode(meterData.meterCode)
    const endNotes = `Room assignment corrected before the first meter reading. Original room: ${currentAssignment.roomCode}; corrected room: ${targetRoomData.roomCode}. Reason: ${correctionReason}`

    transaction.update(oldAssignmentRef, {
      status: 'ended',
      endedOn: currentAssignment.assignedOn,
      finalReading: currentAssignment.initialReading,
      endReason: 'other',
      endNotes,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    })

    transaction.set(newAssignmentRef, {
      meterId,
      meterCode,
      roomId: targetRoomId,
      roomCode: targetRoomData.roomCode,
      propertyId: targetRoomData.propertyId,
      propertyCode: targetRoomData.propertyCode,
      status: 'current',
      assignedOn: currentAssignment.assignedOn,
      initialReading: currentAssignment.initialReading,
      endedOn: null,
      finalReading: null,
      endReason: null,
      endNotes: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: actorUid,
      updatedBy: actorUid,
    })

    transaction.delete(oldRoomIndexRef)
    transaction.set(targetRoomIndexRef, {
      meterId,
      meterCode,
      roomId: targetRoomId,
      assignmentId: newAssignmentRef.id,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    transaction.update(meterIndexRef, {
      meterId,
      meterCode,
      roomId: targetRoomId,
      assignmentId: newAssignmentRef.id,
      updatedAt: serverTimestamp(),
    })
  })

  invalidateOwnerDataCache(ownerUid)
  return newAssignmentRef.id
}

/**
 * Cancels a meter that was created and assigned by mistake but never physically
 * existed. The permanent meter record is retained as `voided`; its current
 * assignment is ended and both active indexes are removed. Readings and bills
 * are checked before the transaction, and the reading-state document is
 * checked inside the transaction to prevent a concurrent reading save.
 */
export async function cancelMistakenMeter(
  ownerUid: string,
  meterId: string,
  currentAssignment: MeterAssignmentRecord,
  reason: string,
): Promise<void> {
  const normalizedReason = reason.trim()
  if (!ownerUid.trim() || !meterId.trim() || currentAssignment.meterId !== meterId || currentAssignment.status !== 'current') {
    throw new MeterCancellationNotAllowedError()
  }
  if (normalizedReason.length < 10 || normalizedReason.length > 700) {
    throw new MeterCancellationNotAllowedError()
  }

  const { db } = getFirebaseServices()
  const readingCollection = collection(db, 'users', ownerUid, 'electricityReadings')
  const billCollection = collection(db, 'users', ownerUid, 'electricityBills')
  const [readingMatches, billMatches] = await Promise.all([
    getDocs(query(readingCollection, where('meterAssignmentId', '==', currentAssignment.id))),
    getDocs(query(billCollection, where('meterAssignmentId', '==', currentAssignment.id))),
  ])
  if (!readingMatches.empty || !billMatches.empty) {
    throw new MeterCancellationHasHistoryError()
  }

  const meterRef = getMeterRef(ownerUid, meterId)
  const assignmentRef = getAssignmentRef(ownerUid, currentAssignment.id)
  const roomIndexRef = getCurrentMeterByRoomRef(ownerUid, currentAssignment.roomId)
  const meterIndexRef = getCurrentAssignmentByMeterRef(ownerUid, meterId)
  const readingStateRef = doc(db, 'users', ownerUid, 'electricityReadingState', currentAssignment.id)
  const actorUid = getCurrentActorUid()
  const today = new Date()
  const cancellationDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  await runTransaction(db, async (transaction) => {
    const [
      meterSnapshot,
      assignmentSnapshot,
      roomIndexSnapshot,
      meterIndexSnapshot,
      readingStateSnapshot,
    ] = await Promise.all([
      transaction.get(meterRef),
      transaction.get(assignmentRef),
      transaction.get(roomIndexRef),
      transaction.get(meterIndexRef),
      transaction.get(readingStateRef),
    ])

    if (readingStateSnapshot.exists()) {
      throw new MeterCancellationHasHistoryError()
    }
    if (
      !meterSnapshot.exists() ||
      !assignmentSnapshot.exists() ||
      !roomIndexSnapshot.exists() ||
      !meterIndexSnapshot.exists()
    ) {
      throw new MeterCancellationNotAllowedError()
    }

    const meterData = meterSnapshot.data()
    const assignmentData = assignmentSnapshot.data()
    const roomIndex = readMeterIndex(roomIndexSnapshot.data())
    const meterIndex = readMeterIndex(meterIndexSnapshot.data())

    if (
      meterData.status !== 'assigned' ||
      meterData.meterCode !== currentAssignment.meterCode ||
      assignmentData.status !== 'current' ||
      assignmentData.meterId !== meterId ||
      assignmentData.meterCode !== currentAssignment.meterCode ||
      assignmentData.roomId !== currentAssignment.roomId ||
      assignmentData.assignedOn !== currentAssignment.assignedOn ||
      assignmentData.initialReading !== currentAssignment.initialReading ||
      roomIndex.assignmentId !== currentAssignment.id ||
      roomIndex.meterId !== meterId ||
      roomIndex.roomId !== currentAssignment.roomId ||
      meterIndex.assignmentId !== currentAssignment.id ||
      meterIndex.meterId !== meterId ||
      meterIndex.roomId !== currentAssignment.roomId
    ) {
      throw new MeterHistoryIntegrityError()
    }

    const endNotes = `Mistaken meter cancellation. Reason: ${normalizedReason}`
    transaction.update(assignmentRef, {
      status: 'ended',
      endedOn: cancellationDate < currentAssignment.assignedOn ? currentAssignment.assignedOn : cancellationDate,
      finalReading: currentAssignment.initialReading,
      endReason: 'other',
      endNotes,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    })
    transaction.update(meterRef, {
      status: 'voided',
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    })
    transaction.delete(roomIndexRef)
    transaction.delete(meterIndexRef)
  })

  invalidateOwnerDataCache(ownerUid)
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
      updatedBy: getCurrentActorUid(),
    })

    transaction.update(oldMeterRef, {
      status: 'retired',
      updatedAt: serverTimestamp(),
      updatedBy: getCurrentActorUid(),
    })

    // Create a brand-new meter with a separate permanent ID.
    transaction.set(newMeterRef, {
      meterCode: newMeterCode,
      serialNumber: input.newSerialNumber.trim(),
      notes: input.notes.trim(),
      status: 'assigned',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
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
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
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
    error instanceof MeterAssignmentHasReadingsError ||
    error instanceof MeterCancellationHasHistoryError ||
    error instanceof MeterCancellationNotAllowedError ||
    error instanceof MeterCorrectionTargetUnavailableError ||
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
