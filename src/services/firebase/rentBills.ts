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
import { listTenantAssignments } from './tenantAssignments'

import type { TenantAssignmentRecord } from './tenantAssignments'

import {
  rentBillingMonthSchema,
  rentIsoDateSchema,
  roomRentRateFormSchema,
  type RentBillRateSnapshot,
  type RentBillStatus,
  type RoomRentRateFormValues,
} from '../../schemas/rentBill'

const MAX_MONTHLY_RENT_MINOR = 10_000_000_000

type UnknownRecord = Record<string, unknown>

type BillingAssignment = {
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
  status: 'current' | 'ended'
}

type AssignmentSnapshotRecord = {
  id: string
  data: UnknownRecord
}

type BillCreationResult = 'created' | 'exists' | 'skipped'

export type RoomRentRateRecord = {
  id: string
  roomId: string
  roomCode: string
  propertyId: string
  propertyCode: string
  effectiveFrom: string
  monthlyRentMinor: number
  notes: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type RentBillRecord = {
  id: string
  assignmentId: string
  tenantId: string
  tenantCode: string
  tenantName: string
  roomId: string
  roomCode: string
  roomNumber: string
  floorName: string
  propertyId: string
  propertyCode: string
  billingMonth: string
  occupancyStartDate: string
  occupancyEndDate: string
  chargedDays: number
  daysInMonth: number
  rateBreakdown: RentBillRateSnapshot[]
  totalMinor: number
  currency: 'BDT'
  status: RentBillStatus
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type RentBillGenerationError = {
  assignmentId: string
  tenantCode: string
  tenantName: string
  roomCode: string
  roomNumber: string
  message: string
}

export type RentBillGenerationResult = {
  billingMonth: string
  created: number
  alreadyExisted: number
  skipped: number
  errors: RentBillGenerationError[]
}

export class RentRateAlreadyExistsError extends Error {
  constructor() {
    super(
      'A rent rate already exists for this room and effective date. Choose a different date.',
    )
    this.name = 'RentRateAlreadyExistsError'
  }
}

export class RentRateInUseError extends Error {
  constructor() {
    super(
      'This rent rate is already used by an issued rent bill and cannot be deleted. Add a new rate with a different effective date to correct future bills.',
    )
    this.name = 'RentRateInUseError'
  }
}

export class RentRateNotFoundError extends Error {
  constructor() {
    super('This rent rate no longer exists. Refresh the page and try again.')
    this.name = 'RentRateNotFoundError'
  }
}

export class RentRoomNotFoundError extends Error {
  constructor() {
    super(
      'The selected room no longer exists. Refresh the page and try again.',
    )
    this.name = 'RentRoomNotFoundError'
  }
}

export class MissingRentRateError extends Error {
  constructor(roomCode: string, date: string) {
    super(
      `Room ${roomCode} has no rent rate effective on ${date}. Add a rent rate before generating this bill.`,
    )
    this.name = 'MissingRentRateError'
  }
}

export class RentAssignmentOverlapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RentAssignmentOverlapError'
  }
}

export class InvalidRentBillingDataError extends Error {
  constructor(
    message = 'Saved rent data is invalid. No changes were made.',
  ) {
    super(message)
    this.name = 'InvalidRentBillingDataError'
  }
}

/* =========================================================
   VALIDATION HELPERS
========================================================= */

function isRecord(value: unknown): value is UnknownRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function isValidStoredDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    rentIsoDateSchema.safeParse(value).success
  )
}

function isSafeNonNegativeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

function getTimestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null
}

function getRoomRentRateRef(
  ownerUid: string,
  rateId: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'roomRentRates',
    rateId,
  )
}

function getRoomRentRateUsageLockRef(
  ownerUid: string,
  rateId: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'roomRentRateUsageLocks',
    rateId,
  )
}

function getRentBillRef(
  ownerUid: string,
  billId: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'rentBills',
    billId,
  )
}

function getRentBillRoomMonthLockRef(
  ownerUid: string,
  roomId: string,
  billingMonth: string,
) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'rentBillRoomMonthLocks',
    `${roomId}__${billingMonth}`,
  )
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
    'tenantAssignments',
    assignmentId,
  )
}

function validateRoomRentRate(
  id: string,
  data: UnknownRecord,
): RoomRentRateRecord {
  if (
    typeof data.roomId !== 'string' ||
    data.roomId.length === 0 ||
    typeof data.roomCode !== 'string' ||
    parseIdentifierNumber('room', data.roomCode) === null ||
    typeof data.propertyId !== 'string' ||
    typeof data.propertyCode !== 'string' ||
    parseIdentifierNumber('property', data.propertyCode) === null ||
    !isValidStoredDate(data.effectiveFrom) ||
    !isSafeNonNegativeInteger(data.monthlyRentMinor) ||
    data.monthlyRentMinor === 0 ||
    data.monthlyRentMinor > MAX_MONTHLY_RENT_MINOR ||
    typeof data.notes !== 'string' ||
    typeof data.createdBy !== 'string' ||
    typeof data.updatedBy !== 'string'
  ) {
    throw new InvalidRentBillingDataError(
      `Rent rate ${id} contains invalid stored data.`,
    )
  }

  return {
    id,
    roomId: data.roomId,
    roomCode: data.roomCode,
    propertyId: data.propertyId,
    propertyCode: data.propertyCode,
    effectiveFrom: data.effectiveFrom,
    monthlyRentMinor: data.monthlyRentMinor,
    notes: data.notes,
    createdAt: getTimestamp(data.createdAt),
    updatedAt: getTimestamp(data.updatedAt),
    createdBy: data.createdBy,
    updatedBy: data.updatedBy,
  }
}

function validateBillingAssignment(
  id: string,
  data: UnknownRecord,
): BillingAssignment {
  if (
    typeof data.tenantId !== 'string' ||
    data.tenantId.length === 0 ||
    typeof data.tenantCode !== 'string' ||
    parseIdentifierNumber('tenant', data.tenantCode) === null ||
    typeof data.tenantName !== 'string' ||
    typeof data.roomId !== 'string' ||
    data.roomId.length === 0 ||
    typeof data.roomCode !== 'string' ||
    parseIdentifierNumber('room', data.roomCode) === null ||
    typeof data.roomNumber !== 'string' ||
    typeof data.floorName !== 'string' ||
    typeof data.propertyId !== 'string' ||
    typeof data.propertyCode !== 'string' ||
    parseIdentifierNumber('property', data.propertyCode) === null ||
    !isValidStoredDate(data.moveInDate) ||
    !(
      data.moveOutDate === null ||
      isValidStoredDate(data.moveOutDate)
    ) ||
    (data.status !== 'current' && data.status !== 'ended') ||
    (
      data.status === 'current' &&
      data.moveOutDate !== null
    ) ||
    (
      data.status === 'ended' &&
      (
        typeof data.moveOutDate !== 'string' ||
        data.moveOutDate < data.moveInDate
      )
    )
  ) {
    throw new InvalidRentBillingDataError(
      `Tenant assignment ${id} contains invalid data for billing.`,
    )
  }

  return {
    id,
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
    moveOutDate: data.moveOutDate,
    status: data.status,
  }
}

function validateRateSnapshot(
  value: unknown,
): value is RentBillRateSnapshot {
  if (!isRecord(value)) return false

  return (
    typeof value.rateId === 'string' &&
    value.rateId.length > 0 &&
    isValidStoredDate(value.effectiveFrom) &&
    isSafeNonNegativeInteger(value.monthlyRentMinor) &&
    value.monthlyRentMinor > 0 &&
    isValidStoredDate(value.segmentStartDate) &&
    isValidStoredDate(value.segmentEndDate) &&
    value.segmentStartDate <= value.segmentEndDate &&
    isSafeNonNegativeInteger(value.chargedDays) &&
    value.chargedDays > 0 &&
    isSafeNonNegativeInteger(value.amountMinor)
  )
}

function validateRentBill(
  id: string,
  data: UnknownRecord,
): RentBillRecord {
  const billingMonthResult =
    rentBillingMonthSchema.safeParse(data.billingMonth)

  if (!billingMonthResult.success) {
    throw new InvalidRentBillingDataError(
      `Rent bill ${id} contains an invalid billing month.`,
    )
  }

  const billingMonth = billingMonthResult.data

  const breakdown = data.rateBreakdown

  if (
    typeof data.assignmentId !== 'string' ||
    data.assignmentId.length === 0 ||
    typeof data.tenantId !== 'string' ||
    typeof data.tenantCode !== 'string' ||
    parseIdentifierNumber('tenant', data.tenantCode) === null ||
    typeof data.tenantName !== 'string' ||
    typeof data.roomId !== 'string' ||
    typeof data.roomCode !== 'string' ||
    parseIdentifierNumber('room', data.roomCode) === null ||
    typeof data.roomNumber !== 'string' ||
    typeof data.floorName !== 'string' ||
    typeof data.propertyId !== 'string' ||
    typeof data.propertyCode !== 'string' ||
    parseIdentifierNumber('property', data.propertyCode) === null ||
    !isValidStoredDate(data.occupancyStartDate) ||
    !isValidStoredDate(data.occupancyEndDate) ||
    data.occupancyEndDate < data.occupancyStartDate ||
    !isSafeNonNegativeInteger(data.chargedDays) ||
    data.chargedDays === 0 ||
    !isSafeNonNegativeInteger(data.daysInMonth) ||
    data.daysInMonth < 28 ||
    data.daysInMonth > 31 ||
    !Array.isArray(breakdown) ||
    breakdown.length === 0 ||
    !breakdown.every(validateRateSnapshot) ||
    !isSafeNonNegativeInteger(data.totalMinor) ||
    data.currency !== 'BDT' ||
    data.status !== 'issued' ||
    typeof data.createdBy !== 'string' ||
    typeof data.updatedBy !== 'string'
  ) {
    throw new InvalidRentBillingDataError(
      `Rent bill ${id} contains invalid stored data.`,
    )
  }

  const rateBreakdown =
    breakdown as RentBillRateSnapshot[]

  const calculatedTotal = rateBreakdown.reduce(
    (sum, item) => sum + item.amountMinor,
    0,
  )

  const calculatedDays = rateBreakdown.reduce(
    (sum, item) => sum + item.chargedDays,
    0,
  )

  if (
    !Number.isSafeInteger(calculatedTotal) ||
    calculatedTotal !== data.totalMinor ||
    calculatedDays !== data.chargedDays
  ) {
    throw new InvalidRentBillingDataError(
      `Rent bill ${id} has an inconsistent total or day count.`,
    )
  }

  return {
    id,
    assignmentId: data.assignmentId,
    tenantId: data.tenantId,
    tenantCode: data.tenantCode,
    tenantName: data.tenantName,
    roomId: data.roomId,
    roomCode: data.roomCode,
    roomNumber: data.roomNumber,
    floorName: data.floorName,
    propertyId: data.propertyId,
    propertyCode: data.propertyCode,
    billingMonth,
    occupancyStartDate: data.occupancyStartDate,
    occupancyEndDate: data.occupancyEndDate,
    chargedDays: data.chargedDays,
    daysInMonth: data.daysInMonth,
    rateBreakdown,
    totalMinor: data.totalMinor,
    currency: 'BDT',
    status: 'issued',
    createdAt: getTimestamp(data.createdAt),
    updatedAt: getTimestamp(data.updatedAt),
    createdBy: data.createdBy,
    updatedBy: data.updatedBy,
  }
}

/* =========================================================
   DATE HELPERS
========================================================= */

function monthStartDate(billingMonth: string): string {
  return `${billingMonth}-01`
}

function monthEndDate(billingMonth: string): string {
  const [year, month] = billingMonth.split('-').map(Number)
  const date = new Date(Date.UTC(year, month, 0))

  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function daysInBillingMonth(billingMonth: string): number {
  const [year, month] = billingMonth.split('-').map(Number)

  return new Date(
    Date.UTC(year, month, 0),
  ).getUTCDate()
}

function addDays(
  isoDate: string,
  offset: number,
): string {
  const [year, month, day] = isoDate.split('-').map(Number)

  const date = new Date(
    Date.UTC(year, month - 1, day + offset),
  )

  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function inclusiveDayCount(
  startDate: string,
  endDate: string,
): number {
  const start = Date.parse(
    `${startDate}T00:00:00.000Z`,
  )

  const end = Date.parse(
    `${endDate}T00:00:00.000Z`,
  )

  return Math.round((end - start) / 86_400_000) + 1
}

function assignmentOverlapsMonth(
  assignment: Pick<
    TenantAssignmentRecord,
    'moveInDate' | 'moveOutDate'
  >,
  billingMonth: string,
): boolean {
  const start = monthStartDate(billingMonth)
  const end = monthEndDate(billingMonth)

  return (
    assignment.moveInDate <= end &&
    (
      assignment.moveOutDate === null ||
      assignment.moveOutDate >= start
    )
  )
}

/* =========================================================
   OVERLAP PROTECTION
========================================================= */

function assertNoOverlappingAssignment(
  target: BillingAssignment,
  records: AssignmentSnapshotRecord[],
  startDate: string,
  endDate: string,
  type: 'room' | 'tenant',
): void {
  for (const record of records) {
    if (record.id === target.id) continue

    const otherStart = record.data.moveInDate
    const otherEnd = record.data.moveOutDate

    if (
      !isValidStoredDate(otherStart) ||
      !(
        otherEnd === null ||
        isValidStoredDate(otherEnd)
      )
    ) {
      throw new InvalidRentBillingDataError(
        `Assignment ${record.id} has invalid occupancy dates. Resolve this record before generating bills.`,
      )
    }

    const effectiveOtherEnd =
      otherEnd === null ? '9999-12-31' : otherEnd

    const overlaps =
      otherStart <= endDate &&
      effectiveOtherEnd >= startDate

    if (overlaps) {
      const message =
        type === 'room'
          ? `Room ${target.roomCode} has overlapping tenant assignments during ${startDate} to ${endDate}. No bill was generated for this assignment.`
          : `Tenant ${target.tenantCode} has overlapping assignments during ${startDate} to ${endDate}. No bill was generated for this assignment.`

      throw new RentAssignmentOverlapError(message)
    }
  }
}

function convertAssignmentsToSnapshotRecords(
  assignments: TenantAssignmentRecord[],
): AssignmentSnapshotRecord[] {
  return assignments.map((assignment) => ({
    id: assignment.id,
    data: {
      moveInDate: assignment.moveInDate,
      moveOutDate: assignment.moveOutDate,
      status: assignment.status,
      tenantId: assignment.tenantId,
      roomId: assignment.roomId,
    },
  }))
}

/* =========================================================
   RENT RATE CALCULATION
========================================================= */

function calculateRateBreakdown(
  roomCode: string,
  startDate: string,
  endDate: string,
  monthDayCount: number,
  rates: RoomRentRateRecord[],
): RentBillRateSnapshot[] {
  const applicableRates = rates
    .filter((rate) => rate.effectiveFrom <= endDate)
    .sort((a, b) =>
      a.effectiveFrom.localeCompare(b.effectiveFrom),
    )

  for (
    let index = 1;
    index < applicableRates.length;
    index += 1
  ) {
    if (
      applicableRates[index - 1].effectiveFrom ===
      applicableRates[index].effectiveFrom
    ) {
      throw new InvalidRentBillingDataError(
        `Room ${roomCode} has more than one rent rate for ${applicableRates[index].effectiveFrom}.`,
      )
    }
  }

  const boundaries = new Set<string>([
    startDate,
    addDays(endDate, 1),
  ])

  for (const rate of applicableRates) {
    if (
      rate.effectiveFrom > startDate &&
      rate.effectiveFrom <= endDate
    ) {
      boundaries.add(rate.effectiveFrom)
    }
  }

  const orderedBoundaries = [...boundaries].sort()
  const result: RentBillRateSnapshot[] = []

  for (
    let index = 0;
    index < orderedBoundaries.length - 1;
    index += 1
  ) {
    const segmentStartDate = orderedBoundaries[index]
    const segmentEndDate = addDays(
      orderedBoundaries[index + 1],
      -1,
    )

    let effectiveRate: RoomRentRateRecord | undefined

    for (const rate of applicableRates) {
      if (rate.effectiveFrom <= segmentStartDate) {
        effectiveRate = rate
      } else {
        break
      }
    }

    if (!effectiveRate) {
      throw new MissingRentRateError(
        roomCode,
        segmentStartDate,
      )
    }

    const chargedDays = inclusiveDayCount(
      segmentStartDate,
      segmentEndDate,
    )

    const amountMinor = Math.round(
      (
        effectiveRate.monthlyRentMinor *
        chargedDays
      ) / monthDayCount,
    )

    if (!Number.isSafeInteger(amountMinor)) {
      throw new InvalidRentBillingDataError(
        'A calculated rent segment exceeds the safe financial limit.',
      )
    }

    result.push({
      rateId: effectiveRate.id,
      effectiveFrom: effectiveRate.effectiveFrom,
      monthlyRentMinor: effectiveRate.monthlyRentMinor,
      segmentStartDate,
      segmentEndDate,
      chargedDays,
      amountMinor,
    })
  }

  if (result.length === 0) {
    throw new InvalidRentBillingDataError(
      `No chargeable period was calculated for room ${roomCode}.`,
    )
  }

  return result
}

/* =========================================================
   READ SERVICES
========================================================= */

export async function listRoomRentRates(
  ownerUid: string,
): Promise<RoomRentRateRecord[]> {
  return getCachedList(ownerUid, 'RoomRentRates', async () => {
    const { db } = getFirebaseServices()

    const ratesRef = collection(
      db,
      'users',
      ownerUid,
      'roomRentRates',
    )

    const snapshot = await getDocs(
      query(ratesRef, orderBy('effectiveFrom', 'desc')),
    )

    return snapshot.docs.map((rateDocument) =>
      validateRoomRentRate(
        rateDocument.id,
        rateDocument.data() as UnknownRecord,
      ),
    )
  })
}

export async function listRentBills(
  ownerUid: string,
): Promise<RentBillRecord[]> {
  return getCachedList(ownerUid, 'RentBills', async () => {
    const { db } = getFirebaseServices()

    const billsRef = collection(
      db,
      'users',
      ownerUid,
      'rentBills',
    )

    const snapshot = await getDocs(
      query(billsRef, orderBy('billingMonth', 'desc')),
    )

    return snapshot.docs.map((billDocument) =>
      validateRentBill(
        billDocument.id,
        billDocument.data() as UnknownRecord,
      ),
    )
  })
}

/**
 * Backfill permanent usage locks for existing rates already referenced by
 * issued bills. This makes old bills protected before the Delete action is
 * offered in the Rent & Bills page.
 */
export async function ensureRentRateUsageLocks(
  ownerUid: string,
  bills: RentBillRecord[],
): Promise<void> {
  const usageByRateId = new Map<
    string,
    { billId: string; roomId: string; rateSnapshot: RentBillRateSnapshot }
  >()

  for (const bill of bills) {
    for (const rateSnapshot of bill.rateBreakdown) {
      if (!usageByRateId.has(rateSnapshot.rateId)) {
        usageByRateId.set(rateSnapshot.rateId, {
          billId: bill.id,
          roomId: bill.roomId,
          rateSnapshot,
        })
      }
    }
  }

  if (usageByRateId.size === 0) return

  const { db } = getFirebaseServices()
  const actorUid = getCurrentActorUid()
  const existingLocks = await getDocs(
    collection(db, 'users', ownerUid, 'roomRentRateUsageLocks'),
  )
  const lockedRateIds = new Set(existingLocks.docs.map((item) => item.id))
  const missing = [...usageByRateId.entries()].filter(
    ([rateId]) => !lockedRateIds.has(rateId),
  )

  for (let offset = 0; offset < missing.length; offset += 8) {
    const batch = missing.slice(offset, offset + 8)
    await Promise.all(batch.map(async ([rateId, usage]) => {
      const rateRef = getRoomRentRateRef(ownerUid, rateId)
      const usageLockRef = getRoomRentRateUsageLockRef(ownerUid, rateId)
      const billRef = getRentBillRef(ownerUid, usage.billId)

      await runTransaction(db, async (transaction) => {
        const [lockSnapshot, billSnapshot, rateSnapshot] = await Promise.all([
          transaction.get(usageLockRef),
          transaction.get(billRef),
          transaction.get(rateRef),
        ])

        if (lockSnapshot.exists()) return
        if (!billSnapshot.exists() || !rateSnapshot.exists()) return

        const billData = billSnapshot.data() as UnknownRecord
        const rateData = rateSnapshot.data() as UnknownRecord
        const storedBreakdown = billData.rateBreakdown
        const storedSnapshot = Array.isArray(storedBreakdown)
          ? storedBreakdown.find(
            (item) => isRecord(item) && item.rateId === rateId,
          )
          : undefined

        if (
          !storedSnapshot ||
          billData.roomId !== usage.roomId ||
          rateData.roomId !== usage.roomId
        ) {
          throw new InvalidRentBillingDataError(
            `Rent rate ${rateId} does not match the issued bill that references it.`,
          )
        }

        transaction.set(usageLockRef, {
          rateId,
          billId: usage.billId,
          roomId: usage.roomId,
          rateSnapshot: storedSnapshot,
          createdAt: serverTimestamp(),
          createdBy: actorUid,
        })
      })
    }))
  }
}

/**
 * Backfill one permanent room/month lock for every previously issued bill.
 * If legacy data already contains duplicate bills for a room/month, retain all
 * bills unchanged and let the first deterministic bill reserve the lock so no
 * additional duplicate can be created.
 */
export async function ensureRentBillRoomMonthLocks(
  ownerUid: string,
  bills: RentBillRecord[],
): Promise<void> {
  if (bills.length === 0) return

  const { db } = getFirebaseServices()
  const actorUid = getCurrentActorUid()
  const firstBillByRoomMonth = new Map<string, RentBillRecord>()

  const orderedBills = [...bills].sort((a, b) =>
    a.billingMonth.localeCompare(b.billingMonth) ||
    (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0) ||
    a.id.localeCompare(b.id),
  )

  for (const bill of orderedBills) {
    const lockId = `${bill.roomId}__${bill.billingMonth}`
    if (!firstBillByRoomMonth.has(lockId)) {
      firstBillByRoomMonth.set(lockId, bill)
    }
  }

  const existingLocks = await getDocs(
    collection(db, 'users', ownerUid, 'rentBillRoomMonthLocks'),
  )
  const lockedIds = new Set(existingLocks.docs.map((item) => item.id))
  const missing = [...firstBillByRoomMonth.entries()].filter(
    ([lockId]) => !lockedIds.has(lockId),
  )

  for (let offset = 0; offset < missing.length; offset += 8) {
    const batch = missing.slice(offset, offset + 8)
    await Promise.all(batch.map(async ([lockId, bill]) => {
      const lockRef = doc(db, 'users', ownerUid, 'rentBillRoomMonthLocks', lockId)
      const billRef = getRentBillRef(ownerUid, bill.id)

      await runTransaction(db, async (transaction) => {
        const [lockSnapshot, billSnapshot] = await Promise.all([
          transaction.get(lockRef),
          transaction.get(billRef),
        ])

        if (lockSnapshot.exists() || !billSnapshot.exists()) return

        const stored = billSnapshot.data() as UnknownRecord
        if (
          stored.roomId !== bill.roomId ||
          stored.roomCode !== bill.roomCode ||
          stored.billingMonth !== bill.billingMonth ||
          stored.assignmentId !== bill.assignmentId ||
          stored.tenantId !== bill.tenantId ||
          stored.tenantCode !== bill.tenantCode ||
          stored.tenantName !== bill.tenantName ||
          stored.status !== 'issued'
        ) {
          throw new InvalidRentBillingDataError(
            `Rent bill ${bill.id} does not match its room/month lock data.`,
          )
        }

        transaction.set(lockRef, {
          roomId: bill.roomId,
          roomCode: bill.roomCode,
          billingMonth: bill.billingMonth,
          billId: bill.id,
          assignmentId: bill.assignmentId,
          tenantId: bill.tenantId,
          tenantCode: bill.tenantCode,
          tenantName: bill.tenantName,
          createdAt: serverTimestamp(),
          createdBy: actorUid,
        })
      })
    }))
  }
}

/**
 * Delete a mistaken rent rate only when no issued bill has ever used it.
 * Reading the append-only lock in the same transaction as deleting the rate
 * prevents a race with monthly bill generation.
 */
export async function deleteRoomRentRate(
  ownerUid: string,
  rateId: string,
): Promise<void> {
  const { db } = getFirebaseServices()
  const rentBillsSnapshot = await getDocs(
    collection(db, 'users', ownerUid, 'rentBills'),
  )

  const isReferencedByIssuedBill = rentBillsSnapshot.docs.some((billDocument) => {
    const data = billDocument.data() as UnknownRecord
    const breakdown = data.rateBreakdown
    return Array.isArray(breakdown) && breakdown.some(
      (item) => isRecord(item) && item.rateId === rateId,
    )
  })

  if (isReferencedByIssuedBill) throw new RentRateInUseError()

  const rateRef = getRoomRentRateRef(ownerUid, rateId)
  const usageLockRef = getRoomRentRateUsageLockRef(ownerUid, rateId)

  await runTransaction(db, async (transaction) => {
    const [rateSnapshot, usageLockSnapshot] = await Promise.all([
      transaction.get(rateRef),
      transaction.get(usageLockRef),
    ])

    if (!rateSnapshot.exists()) throw new RentRateNotFoundError()
    if (usageLockSnapshot.exists()) throw new RentRateInUseError()

    transaction.delete(rateRef)
  })

  invalidateOwnerDataCache(ownerUid)
}

/* =========================================================
   CREATE A ROOM RENT RATE
========================================================= */

export async function createRoomRentRate(
  ownerUid: string,
  rawInput: RoomRentRateFormValues,
): Promise<string> {
  const input = roomRentRateFormSchema.parse(rawInput)
  const { db } = getFirebaseServices()
  const actorUid = getCurrentActorUid()

  const roomRef = doc(
    db,
    'users',
    ownerUid,
    'rooms',
    input.roomId,
  )

  // One immutable rate record per room and effective date.
  const rateId = `${input.roomId}__${input.effectiveFrom}`
  const rateRef = getRoomRentRateRef(ownerUid, rateId)
  const usageLockRef = getRoomRentRateUsageLockRef(ownerUid, rateId)

  await runTransaction(db, async (transaction) => {
    const [roomSnapshot, existingRateSnapshot, usageLockSnapshot] =
      await Promise.all([
        transaction.get(roomRef),
        transaction.get(rateRef),
        transaction.get(usageLockRef),
      ])

    if (existingRateSnapshot.exists()) {
      throw new RentRateAlreadyExistsError()
    }
    if (usageLockSnapshot.exists()) {
      throw new RentRateInUseError()
    }

    if (!roomSnapshot.exists()) {
      throw new RentRoomNotFoundError()
    }

    const room = roomSnapshot.data()

    if (
      typeof room.roomCode !== 'string' ||
      parseIdentifierNumber('room', room.roomCode) === null ||
      typeof room.propertyId !== 'string' ||
      typeof room.propertyCode !== 'string' ||
      parseIdentifierNumber('property', room.propertyCode) === null
    ) {
      throw new InvalidRentBillingDataError(
        'The selected room contains invalid data.',
      )
    }

    const propertyRef = doc(
      db,
      'users',
      ownerUid,
      'properties',
      room.propertyId,
    )

    const propertySnapshot =
      await transaction.get(propertyRef)

    if (
      !propertySnapshot.exists() ||
      propertySnapshot.data().status !== 'active' ||
      propertySnapshot.data().propertyCode !== room.propertyCode
    ) {
      throw new InvalidRentBillingDataError(
        'The room does not belong to an active property.',
      )
    }

    transaction.set(rateRef, {
      roomId: input.roomId,
      roomCode: room.roomCode,
      propertyId: room.propertyId,
      propertyCode: room.propertyCode,
      effectiveFrom: input.effectiveFrom,
      monthlyRentMinor: input.monthlyRentMinor,
      notes: input.notes.trim(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: actorUid,
      updatedBy: actorUid,
    })
  })

  invalidateOwnerDataCache(ownerUid)
  return rateId
}

/* =========================================================
   CREATE ONE BILL FOR ONE ASSIGNMENT AND MONTH
========================================================= */

async function createRentBillForAssignmentMonth(
  ownerUid: string,
  assignmentId: string,
  billingMonth: string,
  allAssignments: TenantAssignmentRecord[],
  allRates: RoomRentRateRecord[],
): Promise<BillCreationResult> {
  const { db } = getFirebaseServices()
  const actorUid = getCurrentActorUid()

  // Deterministic ID prevents repeated generation for the
  // same assignment and month.
  const billId = `${assignmentId}__${billingMonth}`
  const billRef = getRentBillRef(ownerUid, billId)
  const assignmentRef = getAssignmentRef(
    ownerUid,
    assignmentId,
  )

  const previewAssignment = allAssignments.find(
    (assignment) => assignment.id === assignmentId,
  )

  if (!previewAssignment) {
    throw new InvalidRentBillingDataError(
      `Tenant assignment ${assignmentId} was not found.`,
    )
  }

  const roomRef = doc(
    db,
    'users',
    ownerUid,
    'rooms',
    previewAssignment.roomId,
  )

  const roomMonthLockRef = getRentBillRoomMonthLockRef(
    ownerUid,
    previewAssignment.roomId,
    billingMonth,
  )

  const roomIndexRef = doc(
    db,
    'users',
    ownerUid,
    'currentTenantByRoom',
    previewAssignment.roomId,
  )

  return runTransaction(db, async (transaction) => {
    const [
      existingBillSnapshot,
      assignmentSnapshot,
      roomSnapshot,
      roomIndexSnapshot,
      roomMonthLockSnapshot,
    ] = await Promise.all([
      transaction.get(billRef),
      transaction.get(assignmentRef),
      transaction.get(roomRef),
      transaction.get(roomIndexRef),
      transaction.get(roomMonthLockRef),
    ])

    if (existingBillSnapshot.exists()) {
      return 'exists'
    }

    if (roomMonthLockSnapshot.exists()) {
      return 'exists'
    }

    if (!assignmentSnapshot.exists()) {
      throw new InvalidRentBillingDataError(
        `Tenant assignment ${assignmentId} no longer exists.`,
      )
    }

    if (!roomSnapshot.exists()) {
      throw new RentRoomNotFoundError()
    }

    const assignment = validateBillingAssignment(
      assignmentSnapshot.id,
      assignmentSnapshot.data() as UnknownRecord,
    )

    if (
      assignment.roomId !== previewAssignment.roomId ||
      assignment.tenantId !== previewAssignment.tenantId
    ) {
      throw new InvalidRentBillingDataError(
        'The assignment changed while the bill was being prepared. Refresh and try again.',
      )
    }

    const room = roomSnapshot.data()

    if (
      room.roomCode !== assignment.roomCode ||
      room.propertyId !== assignment.propertyId ||
      room.propertyCode !== assignment.propertyCode
    ) {
      throw new InvalidRentBillingDataError(
        `Room ${assignment.roomCode} no longer matches its saved assignment.`,
      )
    }

    const roomCurrentAssignmentId =
      roomIndexSnapshot.exists()
        ? roomIndexSnapshot.data().assignmentId
        : null

    if (
      roomIndexSnapshot.exists() &&
      typeof roomCurrentAssignmentId !== 'string'
    ) {
      throw new InvalidRentBillingDataError(
        'The room current-assignment index is invalid.',
      )
    }

    // A tenant may occupy multiple rooms at the same time. The room-side
    // index is the authoritative uniqueness constraint; the legacy
    // currentRoomByTenant pointer is intentionally not used for billing.
    if (
      assignment.status === 'current' &&
      roomCurrentAssignmentId !== assignment.id
    ) {
      throw new RentAssignmentOverlapError(
        'The room current-assignment index does not match this tenant assignment. No bill was generated.',
      )
    }

    if (
      assignment.status === 'ended' &&
      roomCurrentAssignmentId === assignment.id
    ) {
      throw new InvalidRentBillingDataError(
        'An ended assignment still has a current room-assignment index.',
      )
    }

    const startOfMonth = monthStartDate(billingMonth)
    const endOfMonth = monthEndDate(billingMonth)

    const occupancyStartDate =
      assignment.moveInDate > startOfMonth
        ? assignment.moveInDate
        : startOfMonth

    const assignmentEnd =
      assignment.moveOutDate ?? '9999-12-31'

    const occupancyEndDate =
      assignmentEnd < endOfMonth
        ? assignmentEnd
        : endOfMonth

    if (occupancyEndDate < occupancyStartDate) {
      return 'skipped'
    }

    const roomAssignmentRecords =
      convertAssignmentsToSnapshotRecords(
        allAssignments,
      ).filter(
        (record) =>
          record.data.roomId === assignment.roomId,
      )

    // Only room assignments are checked for occupancy overlap. A single
    // tenant is allowed to occupy several different rooms concurrently.
    // Include the room's indexed assignment if it is absent from the initial
    // history snapshot, then validate overlap for this room only.
    const linkedAssignmentIds = [
      ...new Set(
        [roomCurrentAssignmentId].filter(
          (id): id is string =>
            typeof id === 'string' &&
            id !== assignment.id,
        ),
      ),
    ]

    const linkedAssignmentSnapshots = await Promise.all(
      linkedAssignmentIds.map((id) =>
        transaction.get(getAssignmentRef(ownerUid, id)),
      ),
    )

    linkedAssignmentSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists()) {
        throw new InvalidRentBillingDataError(
          `Current assignment ${linkedAssignmentIds[index]} is missing.`,
        )
      }

      const record: AssignmentSnapshotRecord = {
        id: snapshot.id,
        data: snapshot.data() as UnknownRecord,
      }

      if (
        record.data.roomId === assignment.roomId &&
        !roomAssignmentRecords.some(
          (item) => item.id === record.id,
        )
      ) {
        roomAssignmentRecords.push(record)
      }

    })

    assertNoOverlappingAssignment(
      assignment,
      roomAssignmentRecords,
      occupancyStartDate,
      occupancyEndDate,
      'room',
    )

    const rates = allRates.filter(
      (rate) => rate.roomId === assignment.roomId,
    )

    const dayCount = daysInBillingMonth(billingMonth)

    const rateBreakdown = calculateRateBreakdown(
      assignment.roomCode,
      occupancyStartDate,
      occupancyEndDate,
      dayCount,
      rates,
    )

    const chargedDays = inclusiveDayCount(
      occupancyStartDate,
      occupancyEndDate,
    )

    const totalMinor = rateBreakdown.reduce(
      (sum, rate) => sum + rate.amountMinor,
      0,
    )

    if (
      !Number.isSafeInteger(totalMinor) ||
      !Number.isSafeInteger(chargedDays)
    ) {
      throw new InvalidRentBillingDataError(
        'The calculated bill exceeds the safe financial calculation limit.',
      )
    }

    const uniqueRateSnapshots = [
      ...new Map(rateBreakdown.map((item) => [item.rateId, item])).values(),
    ]
    const rateUsageChecks = await Promise.all(
      uniqueRateSnapshots.map(async (rateSnapshot) => {
        const referencedRateRef = getRoomRentRateRef(ownerUid, rateSnapshot.rateId)
        const usageLockRef = getRoomRentRateUsageLockRef(ownerUid, rateSnapshot.rateId)
        const [referencedRateSnapshot, usageLockSnapshot] = await Promise.all([
          transaction.get(referencedRateRef),
          transaction.get(usageLockRef),
        ])

        if (!referencedRateSnapshot.exists()) {
          throw new InvalidRentBillingDataError(
            `Rent rate ${rateSnapshot.rateId} was removed while this bill was being prepared. Refresh and try again.`,
          )
        }

        const referencedRate = referencedRateSnapshot.data()
        if (
          referencedRate.roomId !== assignment.roomId ||
          referencedRate.effectiveFrom !== rateSnapshot.effectiveFrom ||
          referencedRate.monthlyRentMinor !== rateSnapshot.monthlyRentMinor
        ) {
          throw new InvalidRentBillingDataError(
            `Rent rate ${rateSnapshot.rateId} changed while this bill was being prepared. Refresh and try again.`,
          )
        }

        return {
          rateSnapshot,
          usageLockRef,
          alreadyLocked: usageLockSnapshot.exists(),
        }
      }),
    )

    transaction.set(billRef, {
      assignmentId: assignment.id,
      tenantId: assignment.tenantId,
      tenantCode: assignment.tenantCode,
      tenantName: assignment.tenantName,
      roomId: assignment.roomId,
      roomCode: assignment.roomCode,
      roomNumber: assignment.roomNumber,
      floorName: assignment.floorName,
      propertyId: assignment.propertyId,
      propertyCode: assignment.propertyCode,
      billingMonth,
      occupancyStartDate,
      occupancyEndDate,
      chargedDays,
      daysInMonth: dayCount,
      rateBreakdown,
      totalMinor,
      currency: 'BDT',
      status: 'issued',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: actorUid,
      updatedBy: actorUid,
    })

    transaction.set(roomMonthLockRef, {
      roomId: assignment.roomId,
      roomCode: assignment.roomCode,
      billingMonth,
      billId,
      assignmentId: assignment.id,
      tenantId: assignment.tenantId,
      tenantCode: assignment.tenantCode,
      tenantName: assignment.tenantName,
      createdAt: serverTimestamp(),
      createdBy: actorUid,
    })

    for (const usage of rateUsageChecks) {
      if (usage.alreadyLocked) continue
      transaction.set(usage.usageLockRef, {
        rateId: usage.rateSnapshot.rateId,
        billId,
        roomId: assignment.roomId,
        rateSnapshot: usage.rateSnapshot,
        createdAt: serverTimestamp(),
        createdBy: actorUid,
      })
    }

    return 'created'
  })
}

/* =========================================================
   MONTHLY BILL GENERATION
========================================================= */

export async function generateRentBillsForMonth(
  ownerUid: string,
  rawBillingMonth: string,
): Promise<RentBillGenerationResult> {
  const billingMonth =
    rentBillingMonthSchema.parse(rawBillingMonth)

  const [assignments, rates, existingBills] = await Promise.all([
    listTenantAssignments(ownerUid),
    listRoomRentRates(ownerUid),
    listRentBills(ownerUid),
  ])

  // Make legacy issued bills reserve their room/month before attempting any
  // new bill. The Firestore rules require this lock on every new bill.
  await ensureRentBillRoomMonthLocks(ownerUid, existingBills)
  await ensureRentRateUsageLocks(ownerUid, existingBills)

  const relevantAssignments = assignments
    .filter((assignment) =>
      assignmentOverlapsMonth(assignment, billingMonth),
    )
    // The room/month lock permits one bill for a room in a month. When a
    // room has multiple assignment records in that month, bill the current
    // occupant first; if vacant, prefer the most recent occupancy. This keeps
    // the room-level duplicate guard deterministic without conflating tenants
    // who occupy different rooms.
    .sort((a, b) =>
      a.roomId.localeCompare(b.roomId) ||
      Number(b.status === 'current') - Number(a.status === 'current') ||
      b.moveInDate.localeCompare(a.moveInDate) ||
      (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0) ||
      a.id.localeCompare(b.id),
    )

  const result: RentBillGenerationResult = {
    billingMonth,
    created: 0,
    alreadyExisted: 0,
    skipped: 0,
    errors: [],
  }

  for (const assignment of relevantAssignments) {
    try {
      const outcome =
        await createRentBillForAssignmentMonth(
          ownerUid,
          assignment.id,
          billingMonth,
          assignments,
          rates,
        )

      if (outcome === 'created') {
        result.created += 1
      } else if (outcome === 'exists') {
        result.alreadyExisted += 1
      } else {
        result.skipped += 1
      }
    } catch (error: unknown) {
      result.errors.push({
        assignmentId: assignment.id,
        tenantCode: assignment.tenantCode,
        tenantName: assignment.tenantName,
        roomCode: assignment.roomCode,
        roomNumber: assignment.roomNumber,
        message: getRentBillErrorMessage(error),
      })
    }
  }

  return result
}

/* =========================================================
   USER-FACING ERROR MESSAGES
========================================================= */

export function getRentBillErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof RentRateAlreadyExistsError ||
    error instanceof RentRateInUseError ||
    error instanceof RentRateNotFoundError ||
    error instanceof RentRoomNotFoundError ||
    error instanceof MissingRentRateError ||
    error instanceof RentAssignmentOverlapError ||
    error instanceof InvalidRentBillingDataError
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
      return 'Database access was denied. Check the published Firestore rules.'

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
        : 'Something went wrong while accessing rent and bills.'
  }
}
