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

import { getCurrentActorUid, getFirebaseServices } from './client'
import { listMeterAssignments } from './meters'
import type { TenantAssignmentRecord } from './tenantAssignments'
import {
  electricityRateFormSchema,
  electricityReadingFormSchema,
  type ElectricityRateFormValues,
  type ElectricityReadingFormValues,
} from '../../schemas/electricity'

type UnknownRecord = Record<string, unknown>

export type ElectricityRateRecord = {
  id: string
  /** null identifies a legacy shared rate created before rates became room-specific. */
  roomId: string | null
  roomCode: string | null
  effectiveFrom: string
  pricePerUnitMinor: number
  notes: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type ElectricityReadingRecord = {
  id: string
  meterAssignmentId: string
  meterId: string
  meterCode: string
  roomId: string
  roomCode: string
  propertyId: string
  propertyCode: string
  billingMonth: string
  readingDate: string
  previousReading: number
  currentReading: number
  unitsConsumed: number
  rateId: string
  rateEffectiveFrom: string
  pricePerUnitMinor: number
  amountMinor: number
  notes: string
  /** Immutable tenant-at-issue snapshot; absent on legacy bills/readings. */
  tenantAssignmentId?: string
  tenantId?: string
  tenantCode?: string
  tenantName?: string
  tenantRoomNumber?: string
  tenantFloorName?: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type ElectricityBillRecord = ElectricityReadingRecord & {
  readingId: string
  currency: 'BDT'
  status: 'issued'
}

export class ElectricityRateAlreadyExistsError extends Error {
  constructor() {
    super('An electricity rate already exists for this room and effective date. Choose another date.')
    this.name = 'ElectricityRateAlreadyExistsError'
  }
}


export class ElectricityRateRoomNotFoundError extends Error {
  constructor() {
    super('The selected room no longer exists. Refresh the page and try again.')
    this.name = 'ElectricityRateRoomNotFoundError'
  }
}

export class ElectricityAssignmentNotFoundError extends Error {
  constructor() {
    super('The selected meter assignment was not found. Refresh and try again.')
    this.name = 'ElectricityAssignmentNotFoundError'
  }
}

export class ElectricityReadingAlreadyExistsError extends Error {
  constructor() {
    super('A meter reading already exists for this assignment and date. Existing readings and bills are never overwritten.')
    this.name = 'ElectricityReadingAlreadyExistsError'
  }
}

export class ElectricityReadingOrderError extends Error {
  constructor(message = 'Readings must be entered in chronological order for each meter assignment.') {
    super(message)
    this.name = 'ElectricityReadingOrderError'
  }
}

export class MissingElectricityRateError extends Error {
  constructor(date: string) {
    super(`No electricity rate is effective on ${date}. Add a rate effective on or before this reading date.`)
    this.name = 'MissingElectricityRateError'
  }
}

export class InvalidElectricityDataError extends Error {
  constructor(message = 'Saved electricity data is invalid. No changes were made.') {
    super(message)
    this.name = 'InvalidElectricityDataError'
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getTimestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isSafeNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function rateRef(ownerUid: string, rateId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'electricityRates', rateId)
}

function readingRef(ownerUid: string, readingId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'electricityReadings', readingId)
}

function billRef(ownerUid: string, billId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'electricityBills', billId)
}

function assignmentRef(ownerUid: string, assignmentId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'meterAssignments', assignmentId)
}

function tenantAssignmentRef(ownerUid: string, assignmentId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'tenantAssignments', assignmentId)
}

function currentTenantByRoomRef(ownerUid: string, roomId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'currentTenantByRoom', roomId)
}

function readingStateRef(ownerUid: string, assignmentId: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'electricityReadingState', assignmentId)
}

function validateRate(id: string, raw: unknown): ElectricityRateRecord {
  if (!isRecord(raw)) throw new InvalidElectricityDataError(`Electricity rate ${id} is malformed.`)

  // Old shared rates are retained as a fallback for rooms that do not yet have
  // a room-specific rate effective on the selected reading date.
  const legacyParsed = electricityRateFormSchema.omit({ roomId: true }).safeParse({
    effectiveFrom: raw.effectiveFrom,
    pricePerUnitMinor: raw.pricePerUnitMinor,
    notes: raw.notes,
  })
  const hasRoomId = typeof raw.roomId === 'string' && raw.roomId.trim().length > 0
  const roomCode = typeof raw.roomCode === 'string' ? raw.roomCode : null
  const validRateId = hasRoomId
    ? id === `rate__${raw.roomId}__${String(raw.effectiveFrom)}` &&
      roomCode !== null && /^R[0-9]{4}$/.test(roomCode) && roomCode !== 'R0000'
    : id === `rate__${String(raw.effectiveFrom)}` && raw.roomId == null && raw.roomCode == null

  if (!legacyParsed.success || !validRateId ||
      !(raw.createdAt instanceof Timestamp) || !(raw.updatedAt instanceof Timestamp) ||
      typeof raw.createdBy !== 'string' || typeof raw.updatedBy !== 'string') {
    throw new InvalidElectricityDataError(`Electricity rate ${id} has invalid saved fields.`)
  }

  return {
    id,
    roomId: hasRoomId ? raw.roomId as string : null,
    roomCode: hasRoomId ? roomCode : null,
    effectiveFrom: legacyParsed.data.effectiveFrom,
    pricePerUnitMinor: legacyParsed.data.pricePerUnitMinor,
    notes: legacyParsed.data.notes,
    createdAt: getTimestamp(raw.createdAt),
    updatedAt: getTimestamp(raw.updatedAt),
    createdBy: raw.createdBy,
    updatedBy: raw.updatedBy,
  }
}

function validateReading(id: string, raw: unknown): ElectricityReadingRecord {
  if (!isRecord(raw)) throw new InvalidElectricityDataError(`Electricity reading ${id} is malformed.`)
  const readingMonth = raw.billingMonth
  const valid = typeof raw.meterAssignmentId === 'string' && raw.meterAssignmentId.length > 0 &&
    typeof raw.meterId === 'string' && typeof raw.meterCode === 'string' &&
    typeof raw.roomId === 'string' && typeof raw.roomCode === 'string' &&
    typeof raw.propertyId === 'string' && typeof raw.propertyCode === 'string' &&
    typeof readingMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(readingMonth) &&
    isDate(raw.readingDate) && raw.readingDate.slice(0, 7) === readingMonth &&
    isSafeNonNegativeNumber(raw.previousReading) && isSafeNonNegativeNumber(raw.currentReading) &&
    isSafeNonNegativeNumber(raw.unitsConsumed) && raw.currentReading >= raw.previousReading &&
    Math.abs(raw.unitsConsumed - (raw.currentReading - raw.previousReading)) < 0.000001 &&
    typeof raw.rateId === 'string' && typeof raw.rateEffectiveFrom === 'string' && isDate(raw.rateEffectiveFrom) &&
    Number.isSafeInteger(raw.pricePerUnitMinor) && Number(raw.pricePerUnitMinor) > 0 &&
    isSafeNonNegativeInteger(raw.amountMinor) && typeof raw.notes === 'string' &&
    raw.notes.length <= 1000 && raw.createdAt instanceof Timestamp && raw.updatedAt instanceof Timestamp &&
    typeof raw.createdBy === 'string' && typeof raw.updatedBy === 'string' &&
    (raw.tenantAssignmentId === undefined || typeof raw.tenantAssignmentId === 'string') &&
    (raw.tenantId === undefined || typeof raw.tenantId === 'string') &&
    (raw.tenantCode === undefined || typeof raw.tenantCode === 'string') &&
    (raw.tenantName === undefined || typeof raw.tenantName === 'string') &&
    (raw.tenantRoomNumber === undefined || typeof raw.tenantRoomNumber === 'string') &&
    (raw.tenantFloorName === undefined || typeof raw.tenantFloorName === 'string') &&
    ((raw.tenantAssignmentId === undefined && raw.tenantId === undefined && raw.tenantCode === undefined &&
      raw.tenantName === undefined && raw.tenantRoomNumber === undefined && raw.tenantFloorName === undefined) ||
      (typeof raw.tenantAssignmentId === 'string' && typeof raw.tenantId === 'string' &&
       typeof raw.tenantCode === 'string' && typeof raw.tenantName === 'string' &&
       typeof raw.tenantRoomNumber === 'string' && typeof raw.tenantFloorName === 'string')) &&
    (id === `${raw.meterAssignmentId}__${readingMonth}` || id === `${raw.meterAssignmentId}__${raw.readingDate}`) &&
    (raw.rateId === `rate__${raw.rateEffectiveFrom}` ||
      raw.rateId === `rate__${raw.roomId}__${raw.rateEffectiveFrom}`)
  if (!valid) throw new InvalidElectricityDataError(`Electricity reading ${id} has invalid saved fields.`)
  return {
    id,
    meterAssignmentId: raw.meterAssignmentId as string,
    meterId: raw.meterId as string,
    meterCode: raw.meterCode as string,
    roomId: raw.roomId as string,
    roomCode: raw.roomCode as string,
    propertyId: raw.propertyId as string,
    propertyCode: raw.propertyCode as string,
    billingMonth: readingMonth as string,
    readingDate: raw.readingDate as string,
    previousReading: raw.previousReading as number,
    currentReading: raw.currentReading as number,
    unitsConsumed: raw.unitsConsumed as number,
    rateId: raw.rateId as string,
    rateEffectiveFrom: raw.rateEffectiveFrom as string,
    pricePerUnitMinor: raw.pricePerUnitMinor as number,
    amountMinor: raw.amountMinor as number,
    notes: raw.notes as string,
    ...(typeof raw.tenantAssignmentId === 'string' ? {
      tenantAssignmentId: raw.tenantAssignmentId,
      tenantId: raw.tenantId as string,
      tenantCode: raw.tenantCode as string,
      tenantName: raw.tenantName as string,
      tenantRoomNumber: raw.tenantRoomNumber as string,
      tenantFloorName: raw.tenantFloorName as string,
    } : {}),
    createdAt: getTimestamp(raw.createdAt),
    updatedAt: getTimestamp(raw.updatedAt),
    createdBy: raw.createdBy as string,
    updatedBy: raw.updatedBy as string,
  }
}

function validateBill(id: string, raw: unknown): ElectricityBillRecord {
  if (!isRecord(raw) || raw.currency !== 'BDT' || raw.status !== 'issued' ||
      typeof raw.readingId !== 'string') {
    throw new InvalidElectricityDataError(`Electricity bill ${id} has invalid saved fields.`)
  }
  const reading = validateReading(id, raw)
  if (raw.readingId !== id) throw new InvalidElectricityDataError(`Electricity bill ${id} has a mismatched reading reference.`)
  return { ...reading, readingId: raw.readingId, currency: 'BDT', status: 'issued' }
}

export async function listElectricityRates(ownerUid: string): Promise<ElectricityRateRecord[]> {
  return getCachedList(ownerUid, 'ElectricityRates', async () => {
    const { db } = getFirebaseServices()
    const ref = collection(db, 'users', ownerUid, 'electricityRates')
    const snapshot = await getDocs(query(ref, orderBy('effectiveFrom', 'desc')))
    return snapshot.docs.map((item) => validateRate(item.id, item.data()))
  })
}

export async function listElectricityReadings(ownerUid: string): Promise<ElectricityReadingRecord[]> {
  return getCachedList(ownerUid, 'ElectricityReadings', async () => {
    const { db } = getFirebaseServices()
    const ref = collection(db, 'users', ownerUid, 'electricityReadings')
    const snapshot = await getDocs(query(ref, orderBy('readingDate', 'desc')))
    return snapshot.docs.map((item) => validateReading(item.id, item.data()))
  })
}

export async function listElectricityBills(ownerUid: string): Promise<ElectricityBillRecord[]> {
  return getCachedList(ownerUid, 'ElectricityBills', async () => {
    const { db } = getFirebaseServices()
    const ref = collection(db, 'users', ownerUid, 'electricityBills')
    const snapshot = await getDocs(query(ref, orderBy('billingMonth', 'desc')))
    return snapshot.docs.map((item) => validateBill(item.id, item.data()))
      .sort((left, right) => right.readingDate.localeCompare(left.readingDate) || right.id.localeCompare(left.id))
  })
}

/**
 * Resolve the tenant responsible for an electricity bill.
 * New bills carry an immutable tenant-assignment snapshot. Legacy bills first
 * use the historical reading-date match, then fall back to a single current
 * tenant in the room when no historical assignment covers that date.
 */
export function resolveElectricityBillTenantAssignment(
  bill: ElectricityBillRecord,
  assignments: TenantAssignmentRecord[],
): TenantAssignmentRecord | null {
  if (bill.tenantAssignmentId) {
    return assignments.find((assignment) =>
      assignment.id === bill.tenantAssignmentId &&
      (!bill.tenantId || assignment.tenantId === bill.tenantId),
    ) ?? null
  }

  const candidates = assignments.filter((assignment) =>
    assignment.roomId === bill.roomId &&
    assignment.moveInDate <= bill.readingDate &&
    (assignment.moveOutDate === null || assignment.moveOutDate >= bill.readingDate),
  )

  if (candidates.length === 1) return candidates[0] ?? null

  if (candidates.length > 1) {
    const currentCandidates = candidates.filter((assignment) =>
      assignment.status === 'current' && assignment.moveOutDate === null,
    )
    if (currentCandidates.length === 1) return currentCandidates[0] ?? null
    if (currentCandidates.length > 1) return null

    const latestMoveInDate = candidates.reduce(
      (latest, assignment) => assignment.moveInDate > latest ? assignment.moveInDate : latest,
      candidates[0].moveInDate,
    )
    const latestCandidates = candidates.filter((assignment) => assignment.moveInDate === latestMoveInDate)
    return latestCandidates.length === 1 ? latestCandidates[0] ?? null : null
  }

  // Older electricity bills were not saved with tenant details. When their
  // reading date predates the recorded move-in date, use a unique current
  // room assignment rather than leaving the room's current bill unassigned.
  const currentRoomAssignments = assignments.filter((assignment) =>
    assignment.roomId === bill.roomId &&
    assignment.status === 'current' &&
    assignment.moveOutDate === null,
  )
  return currentRoomAssignments.length === 1 ? currentRoomAssignments[0] ?? null : null
}

export async function createElectricityRate(ownerUid: string, rawInput: ElectricityRateFormValues): Promise<string> {
  const input = electricityRateFormSchema.parse(rawInput)
  const { db } = getFirebaseServices()
  const id = `rate__${input.roomId}__${input.effectiveFrom}`
  const ref = rateRef(ownerUid, id)
  const selectedRoomRef = doc(db, 'users', ownerUid, 'rooms', input.roomId)
  const actorUid = getCurrentActorUid()

  await runTransaction(db, async (transaction) => {
    const [existing, roomSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(selectedRoomRef),
    ])
    if (existing.exists()) throw new ElectricityRateAlreadyExistsError()
    if (!roomSnapshot.exists()) throw new ElectricityRateRoomNotFoundError()

    const roomData = roomSnapshot.data()
    if (!isRecord(roomData) || typeof roomData.roomCode !== 'string' ||
        !/^R[0-9]{4}$/.test(roomData.roomCode) || roomData.roomCode === 'R0000') {
      throw new InvalidElectricityDataError('The selected room has invalid saved details. No rate was created.')
    }

    transaction.set(ref, {
      roomId: input.roomId,
      roomCode: roomData.roomCode,
      effectiveFrom: input.effectiveFrom,
      pricePerUnitMinor: input.pricePerUnitMinor,
      notes: input.notes,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: actorUid,
      updatedBy: actorUid,
    })
  })
  return id
}

export async function createElectricityBillFromReading(
  ownerUid: string,
  rawInput: ElectricityReadingFormValues,
): Promise<string> {
  const input = electricityReadingFormSchema.parse(rawInput)
  const readingMonth = input.readingDate.slice(0, 7)
  const assignments = await listMeterAssignments(ownerUid)
  const assignment = assignments.find((item) => item.id === input.meterAssignmentId)
  if (!assignment) throw new ElectricityAssignmentNotFoundError()
  if (input.readingDate < assignment.assignedOn ||
      (assignment.endedOn !== null && input.readingDate > assignment.endedOn)) {
    throw new ElectricityReadingOrderError('The reading date must fall within this meter assignment period.')
  }
  if (assignment.status === 'ended' && assignment.finalReading !== null && input.currentReading > assignment.finalReading) {
    throw new ElectricityReadingOrderError('The current reading cannot exceed the saved final reading for an ended meter assignment.')
  }
  if (assignment.status === 'ended' && assignment.endedOn === input.readingDate &&
      assignment.finalReading !== null && input.currentReading !== assignment.finalReading) {
    throw new ElectricityReadingOrderError('The current reading must match the saved final reading for a replaced or ended meter.')
  }

  const rates = await listElectricityRates(ownerUid)
  const ratesEffectiveByDate = (candidates: ElectricityRateRecord[]) => candidates
    .filter((rate) => rate.effectiveFrom <= input.readingDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
  // Room-specific rates always take precedence and remain in force until a
  // later rate is recorded for that same room. Legacy shared rates are used
  // only for a room that has no applicable room-specific rate yet.
  const roomRate = ratesEffectiveByDate(
    rates.filter((rate) => rate.roomId === assignment.roomId),
  )[0]
  const legacyFallbackRate = ratesEffectiveByDate(
    rates.filter((rate) => rate.roomId === null),
  )[0]
  const applicableRate = roomRate ?? legacyFallbackRate
  if (!applicableRate) throw new MissingElectricityRateError(input.readingDate)

  // Date-based IDs allow multiple immutable readings/bills within one billing month.
  // The legacy month-based IDs remain readable and are never overwritten.
  const readingId = `${assignment.id}__${input.readingDate}`
  const billId = readingId
  const { db } = getFirebaseServices()
  const targetReadingRef = readingRef(ownerUid, readingId)
  const targetBillRef = billRef(ownerUid, billId)
  const meterAssignmentDocument = assignmentRef(ownerUid, assignment.id)
  const rateDocument = rateRef(ownerUid, applicableRate.id)
  const stateRef = readingStateRef(ownerUid, assignment.id)
  const actorUid = getCurrentActorUid()

  await runTransaction(db, async (transaction) => {
    const [assignmentSnapshot, rateSnapshot, savedReading, savedBill, stateSnapshot, currentTenantIndexSnapshot] = await Promise.all([
      transaction.get(meterAssignmentDocument),
      transaction.get(rateDocument),
      transaction.get(targetReadingRef),
      transaction.get(targetBillRef),
      transaction.get(stateRef),
      transaction.get(currentTenantByRoomRef(ownerUid, assignment.roomId)),
    ])

    if (!assignmentSnapshot.exists()) throw new ElectricityAssignmentNotFoundError()
    if (!rateSnapshot.exists()) throw new MissingElectricityRateError(input.readingDate)
    if (savedReading.exists() || savedBill.exists()) throw new ElectricityReadingAlreadyExistsError()

    const assignmentData = assignmentSnapshot.data()
    if (!isRecord(assignmentData) || assignmentData.meterId !== assignment.meterId ||
        assignmentData.meterCode !== assignment.meterCode || assignmentData.roomId !== assignment.roomId ||
        assignmentData.roomCode !== assignment.roomCode || assignmentData.propertyId !== assignment.propertyId ||
        assignmentData.propertyCode !== assignment.propertyCode) {
      throw new InvalidElectricityDataError('The meter assignment changed while the form was open. Refresh and try again.')
    }
    if (assignmentData.status !== 'current' && assignmentData.status !== 'ended') {
      throw new InvalidElectricityDataError('The meter assignment has an invalid status.')
    }

    const persistedRate = validateRate(applicableRate.id, rateSnapshot.data())
    if (persistedRate.effectiveFrom > input.readingDate) throw new MissingElectricityRateError(input.readingDate)
    if (persistedRate.roomId !== null &&
        (persistedRate.roomId !== assignment.roomId || persistedRate.roomCode !== assignment.roomCode)) {
      throw new InvalidElectricityDataError('The selected electricity rate belongs to a different room. No bill was issued.')
    }

    // Link the electricity bill to the tenant currently assigned to this room
    // at issue time. This immutable snapshot keeps the charge on the correct
    // tenant ledger even if the tenant later moves out or another tenant moves in.
    let tenantSnapshot: {
      tenantAssignmentId: string
      tenantId: string
      tenantCode: string
      tenantName: string
      tenantRoomNumber: string
      tenantFloorName: string
    } | null = null

    if (currentTenantIndexSnapshot.exists()) {
      const indexData = currentTenantIndexSnapshot.data()
      if (!isRecord(indexData) || typeof indexData.assignmentId !== 'string' ||
          indexData.roomId !== assignment.roomId || indexData.roomCode !== assignment.roomCode ||
          indexData.propertyId !== assignment.propertyId || indexData.propertyCode !== assignment.propertyCode) {
        throw new InvalidElectricityDataError('The room’s current tenant index is invalid. No electricity bill was issued.')
      }

      const tenantAssignmentDocument = tenantAssignmentRef(ownerUid, indexData.assignmentId)
      const tenantAssignmentSnapshot = await transaction.get(tenantAssignmentDocument)
      if (!tenantAssignmentSnapshot.exists()) {
        throw new InvalidElectricityDataError('The room’s current tenant assignment could not be found. No electricity bill was issued.')
      }

      const tenantAssignment = tenantAssignmentSnapshot.data()
      if (!isRecord(tenantAssignment) || tenantAssignment.status !== 'current' ||
          tenantAssignment.moveOutDate !== null || tenantAssignment.roomId !== assignment.roomId ||
          typeof tenantAssignment.tenantId !== 'string' || typeof tenantAssignment.tenantCode !== 'string' ||
          typeof tenantAssignment.tenantName !== 'string' || typeof tenantAssignment.roomNumber !== 'string' ||
          typeof tenantAssignment.floorName !== 'string' ||
          indexData.tenantId !== tenantAssignment.tenantId ||
          indexData.tenantCode !== tenantAssignment.tenantCode ||
          indexData.tenantName !== tenantAssignment.tenantName ||
          indexData.roomNumber !== tenantAssignment.roomNumber ||
          indexData.floorName !== tenantAssignment.floorName) {
        throw new InvalidElectricityDataError('The room’s current tenant assignment does not match its saved index. No electricity bill was issued.')
      }

      tenantSnapshot = {
        tenantAssignmentId: tenantAssignmentSnapshot.id,
        tenantId: tenantAssignment.tenantId,
        tenantCode: tenantAssignment.tenantCode,
        tenantName: tenantAssignment.tenantName,
        tenantRoomNumber: tenantAssignment.roomNumber,
        tenantFloorName: tenantAssignment.floorName,
      }
    }

    let previousReading = assignment.initialReading
    if (stateSnapshot.exists()) {
      const state = stateSnapshot.data()
      if (!isRecord(state) || state.meterAssignmentId !== assignment.id ||
          !isDate(state.lastReadingDate) || !isSafeNonNegativeNumber(state.lastReadingValue) ||
          typeof state.lastReadingId !== 'string') {
        throw new InvalidElectricityDataError('The saved meter reading state is invalid. No changes were made.')
      }
      if (input.readingDate <= state.lastReadingDate) {
        throw new ElectricityReadingOrderError()
      }
      previousReading = state.lastReadingValue
    }

    if (input.currentReading <= previousReading) {
      throw new ElectricityReadingOrderError('The current reading must be higher than the previous reading. For a replaced meter, select its separate assignment and saved final reading.')
    }

    const unitsConsumed = Math.round((input.currentReading - previousReading) * 1_000_000) / 1_000_000
    const amountMinor = Math.round(unitsConsumed * persistedRate.pricePerUnitMinor)
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new InvalidElectricityDataError('The calculated electricity amount is outside the permitted range.')
    }

    const snapshot = {
      meterAssignmentId: assignment.id,
      meterId: assignment.meterId,
      meterCode: assignment.meterCode,
      roomId: assignment.roomId,
      roomCode: assignment.roomCode,
      propertyId: assignment.propertyId,
      propertyCode: assignment.propertyCode,
      billingMonth: readingMonth,
      readingDate: input.readingDate,
      previousReading,
      currentReading: input.currentReading,
      unitsConsumed,
      rateId: persistedRate.id,
      rateEffectiveFrom: persistedRate.effectiveFrom,
      pricePerUnitMinor: persistedRate.pricePerUnitMinor,
      amountMinor,
      notes: input.notes,
      ...(tenantSnapshot ?? {}),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: actorUid,
      updatedBy: actorUid,
    }

    transaction.set(targetReadingRef, snapshot)
    transaction.set(targetBillRef, {
      ...snapshot,
      readingId,
      currency: 'BDT',
      status: 'issued',
    })
    transaction.set(stateRef, {
      meterAssignmentId: assignment.id,
      lastReadingId: readingId,
      lastReadingDate: input.readingDate,
      lastReadingValue: input.currentReading,
      createdAt: stateSnapshot.exists() ? stateSnapshot.data().createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: stateSnapshot.exists() ? stateSnapshot.data().createdBy : actorUid,
      updatedBy: actorUid,
    })
  })
  return billId
}

export function getElectricityErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'The electricity operation failed. Check your connection and Firestore permissions, then try again.'
}
