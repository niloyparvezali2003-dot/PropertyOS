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

import { getFirebaseServices } from './client'
import { readOpeningBalance } from './openingBalances'
import {
  paymentAllocationSchema,
  paymentFormSchema,
  type PaymentAllocationFormValues,
  type PaymentBillType,
  type PaymentFormValues,
  type PaymentMethod,
} from '../../schemas/payment'

type UnknownRecord = Record<string, unknown>
export type PaymentTransactionType = 'payment' | 'credit_application'

export type PaymentBalanceUpdate = {
  billType: PaymentBillType
  billId: string
  amountMinor: number
}

export type PaymentCreditUpdate = {
  tenantId: string
  amountMinor: number
}

export type PaymentRecord = {
  id: string
  receiptNumber: string
  /** Public short reference; null for receipts created before this ID format. */
  transactionId: string | null
  tenantId: string
  tenantCode: string
  tenantName: string
  paidOn: string
  method: PaymentMethod
  reference: string
  notes: string
  amountMinor: number
  allocatedAmountMinor: number
  advanceAddedMinor: number
  /** Receipt-time tenant-wide outstanding due; null on older receipts. */
  outstandingBeforeMinor: number | null
  outstandingAfterMinor: number | null
  /** Portion of this receipt settled against the tenant's legacy opening balance. */
  openingBalanceAllocationMinor: number
  creditUpdate: PaymentCreditUpdate
  currency: 'BDT'
  status: 'posted'
  allocations: PaymentAllocationFormValues[]
  balanceUpdates: PaymentBalanceUpdate[]
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type PaymentCreationResult = {
  id: string
  receiptNumber: string
  transactionId: string | null
}

export type PaymentBillBalanceRecord = {
  id: string
  billType: PaymentBillType
  billId: string
  billingMonth: string
  tenantAssignmentId: string
  tenantId: string
  tenantCode: string
  tenantName: string
  roomId: string
  roomCode: string
  roomNumber: string
  floorName: string
  propertyId: string
  propertyCode: string
  originalAmountMinor: number
  paidAmountMinor: number
  outstandingMinor: number
  lastTransactionType: PaymentTransactionType
  lastTransactionId: string
  lastTransactionAmountMinor: number
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type TenantCreditRecord = {
  id: string
  tenantId: string
  tenantCode: string
  tenantName: string
  creditMinor: number
  lastTransactionType: PaymentTransactionType
  lastTransactionId: string
  lastTransactionAmountMinor: number
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type CreditApplicationRecord = {
  id: string
  applicationNumber: string
  tenantId: string
  tenantCode: string
  tenantName: string
  allocation: PaymentAllocationFormValues
  billUpdates: PaymentBalanceUpdate[]
  tenantCreditUpdate: PaymentCreditUpdate
  amountMinor: number
  currency: 'BDT'
  status: 'posted'
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type OpeningBalanceCreditApplicationRecord = {
  id: string
  applicationNumber: string
  tenantId: string
  tenantCode: string
  tenantName: string
  amountMinor: number
  currency: 'BDT'
  status: 'posted'
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export class InvalidPaymentDataError extends Error {
  constructor(message = 'Payment data is invalid. No changes were made.') {
    super(message)
    this.name = 'InvalidPaymentDataError'
  }
}

class TransactionReferenceCollisionError extends Error {
  constructor() {
    super('The generated transaction reference is already in use.')
    this.name = 'TransactionReferenceCollisionError'
  }
}

export class PaymentBillNotFoundError extends Error {
  constructor() {
    super('One of the selected bills no longer exists. Refresh and try again.')
    this.name = 'PaymentBillNotFoundError'
  }
}

export class PaymentBillMismatchError extends Error {
  constructor() {
    super('A selected bill no longer matches its tenant or original amount. No payment was recorded.')
    this.name = 'PaymentBillMismatchError'
  }
}

export class PaymentBillSettledError extends Error {
  constructor() {
    super('A selected bill has no outstanding balance. Refresh the page before recording another transaction.')
    this.name = 'PaymentBillSettledError'
  }
}

export class PaymentAmountExceedsBalanceError extends Error {
  constructor() {
    super('The allocation exceeds the bill’s current outstanding balance. Refresh and try again.')
    this.name = 'PaymentAmountExceedsBalanceError'
  }
}

export class PaymentAssignmentMismatchError extends Error {
  constructor() {
    super('The tenant assignment does not cover the bill date or no longer matches the bill. No transaction was recorded.')
    this.name = 'PaymentAssignmentMismatchError'
  }
}

export class InsufficientTenantCreditError extends Error {
  constructor() {
    super('The tenant’s available advance credit is not enough for this allocation. Refresh and try again.')
    this.name = 'InsufficientTenantCreditError'
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function getTimestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null
}

function balanceDocumentId(billType: PaymentBillType, billId: string): string {
  return `${billType}__${billId}`
}

const ADVANCE_REFERENCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz'
const ADVANCE_REFERENCE_LENGTH = 7
const ADVANCE_REFERENCE_MAX_ACCEPTED_BYTE = 248

/** Generates a uniformly distributed 7-character alphanumeric reference using Web Crypto. */
function generateAdvanceReferenceCode(): string {
  const characters: string[] = []
  // 248 is the largest multiple of 62 below 256; rejection avoids modulo bias.
  while (characters.length < ADVANCE_REFERENCE_LENGTH) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= ADVANCE_REFERENCE_MAX_ACCEPTED_BYTE) continue
      characters.push(ADVANCE_REFERENCE_ALPHABET[byte % ADVANCE_REFERENCE_ALPHABET.length])
      if (characters.length === ADVANCE_REFERENCE_LENGTH) break
    }
  }
  return characters.join('')
}

class AdvanceReferenceCollisionError extends Error {
  constructor() {
    super('The advance reference code is already reserved. Generate another code.')
    this.name = 'AdvanceReferenceCollisionError'
  }
}

const TRANSACTION_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const TRANSACTION_ID_LENGTH = 10

/** Generates a 10-character uppercase alphanumeric reference using Web Crypto. */
function generateTransactionId(): string {
  const characters: string[] = []
  // 252 is the largest multiple of 36 below 256; rejecting larger bytes avoids modulo bias.
  while (characters.length < TRANSACTION_ID_LENGTH) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= 252) continue
      characters.push(TRANSACTION_ID_ALPHABET[byte % TRANSACTION_ID_ALPHABET.length])
      if (characters.length === TRANSACTION_ID_LENGTH) break
    }
  }
  return characters.join('')
}

function assignmentCoversDate(assignment: UnknownRecord, value: string): boolean {
  return (
    typeof assignment.moveInDate === 'string' &&
    assignment.moveInDate <= value &&
    (assignment.moveOutDate == null ||
      (typeof assignment.moveOutDate === 'string' && assignment.moveOutDate >= value))
  )
}

function assertAssignmentMatches(
  assignment: UnknownRecord,
  allocation: PaymentAllocationFormValues,
  requireDateCoverage = true,
): void {
  if (
    assignment.tenantId !== allocation.tenantId ||
    assignment.tenantCode !== allocation.tenantCode ||
    assignment.tenantName !== allocation.tenantName ||
    assignment.roomId !== allocation.roomId ||
    assignment.roomCode !== allocation.roomCode ||
    assignment.roomNumber !== allocation.roomNumber ||
    assignment.floorName !== allocation.floorName ||
    assignment.propertyId !== allocation.propertyId ||
    assignment.propertyCode !== allocation.propertyCode ||
    (requireDateCoverage && !assignmentCoversDate(assignment, allocation.referenceDate))
  ) {
    throw new PaymentAssignmentMismatchError()
  }
}

function validateSourceBill(
  billType: PaymentBillType,
  billId: string,
  bill: UnknownRecord,
  assignment: UnknownRecord,
  allocation: PaymentAllocationFormValues,
): number {
  const amount = billType === 'rent' ? bill.totalMinor : bill.amountMinor
  if (
    bill.status !== 'issued' ||
    !isSafeNonNegativeInteger(amount) ||
    amount <= 0 ||
    amount !== allocation.billAmountMinor ||
    bill.billingMonth !== allocation.billingMonth ||
    bill.roomId !== allocation.roomId ||
    bill.roomCode !== allocation.roomCode ||
    bill.propertyId !== allocation.propertyId ||
    bill.propertyCode !== allocation.propertyCode
  ) {
    throw new PaymentBillMismatchError()
  }

  if (billType === 'rent') {
    assertAssignmentMatches(assignment, allocation)
    const assignmentEnd = typeof assignment.moveOutDate === 'string'
      ? assignment.moveOutDate
      : '9999-12-31'
    if (
      bill.assignmentId !== allocation.tenantAssignmentId ||
      bill.tenantId !== allocation.tenantId ||
      bill.tenantCode !== allocation.tenantCode ||
      bill.tenantName !== allocation.tenantName ||
      bill.roomNumber !== allocation.roomNumber ||
      bill.floorName !== allocation.floorName ||
      typeof bill.occupancyStartDate !== 'string' ||
      typeof bill.occupancyEndDate !== 'string' ||
      bill.occupancyStartDate < (assignment.moveInDate as string) ||
      bill.occupancyEndDate > assignmentEnd ||
      allocation.referenceDate !== bill.occupancyEndDate
    ) {
      throw new PaymentBillMismatchError()
    }
  } else {
    const hasTenantIssueSnapshot = typeof bill.tenantAssignmentId === 'string'
    if (hasTenantIssueSnapshot) {
      // New electricity bills are charged to the tenant saved at issue time.
      // Do not re-check assignment date coverage: the assignment may have ended
      // since issue, but the immutable bill must remain payable by that tenant.
      if (
        bill.tenantAssignmentId !== allocation.tenantAssignmentId ||
        bill.tenantId !== allocation.tenantId ||
        bill.tenantCode !== allocation.tenantCode ||
        bill.tenantName !== allocation.tenantName ||
        bill.tenantRoomNumber !== allocation.roomNumber ||
        bill.tenantFloorName !== allocation.floorName
      ) {
        throw new PaymentBillMismatchError()
      }
      assertAssignmentMatches(assignment, allocation, false)
    } else {
      // Legacy electricity bills predate tenant-at-issue snapshots. Prefer the
      // historical assignment; if none covers the reading date, a single
      // current tenant in that room may take responsibility for the legacy bill.
      const isCurrentRoomAssignment =
        assignment.status === 'current' &&
        assignment.moveOutDate === null &&
        assignment.roomId === allocation.roomId
      assertAssignmentMatches(assignment, allocation, !isCurrentRoomAssignment)
    }

    if (
      typeof bill.readingId !== 'string' ||
      bill.readingId !== billId ||
      typeof bill.readingDate !== 'string' ||
      bill.readingDate !== allocation.referenceDate
    ) {
      throw new PaymentBillMismatchError()
    }
  }

  return amount
}

function sameAllocation(
  allocation: PaymentAllocationFormValues,
  expected: PaymentAllocationFormValues | undefined,
): boolean {
  return Boolean(expected) &&
    allocation.billType === expected!.billType &&
    allocation.billId === expected!.billId &&
    allocation.billingMonth === expected!.billingMonth &&
    allocation.referenceDate === expected!.referenceDate &&
    allocation.amountMinor === expected!.amountMinor &&
    allocation.billAmountMinor === expected!.billAmountMinor &&
    allocation.tenantAssignmentId === expected!.tenantAssignmentId &&
    allocation.tenantId === expected!.tenantId &&
    allocation.tenantCode === expected!.tenantCode &&
    allocation.tenantName === expected!.tenantName &&
    allocation.roomId === expected!.roomId &&
    allocation.roomCode === expected!.roomCode &&
    allocation.roomNumber === expected!.roomNumber &&
    allocation.floorName === expected!.floorName &&
    allocation.propertyId === expected!.propertyId &&
    allocation.propertyCode === expected!.propertyCode
}

function readPaymentRecord(id: string, value: unknown): PaymentRecord {
  if (!isRecord(value)) throw new InvalidPaymentDataError(`Payment ${id} contains invalid data.`)

  const parsed = paymentFormSchema.safeParse({
    tenantId: value.tenantId,
    tenantCode: value.tenantCode,
    tenantName: value.tenantName,
    paidOn: value.paidOn,
    method: value.method,
    reference: value.reference,
    notes: value.notes,
    amountReceivedMinor: value.amountMinor,
    openingBalanceAllocationMinor: value.openingBalanceAllocationMinor ?? 0,
    allocations: value.allocations,
  })
  const amountMinor = value.amountMinor
  // Use the schema's normalized output so the optional legacy field is always a number.
  const openingBalanceAllocationMinor = parsed.success
    ? parsed.data.openingBalanceAllocationMinor
    : 0
  const allocatedAmountMinor = parsed.success
    ? parsed.data.allocations.reduce((total, allocation) => total + allocation.amountMinor, 0) +
      (isSafeNonNegativeInteger(openingBalanceAllocationMinor) ? openingBalanceAllocationMinor : -1)
    : -1
  const advanceAddedMinor = isSafeNonNegativeInteger(amountMinor)
    ? amountMinor - allocatedAmountMinor
    : -1
  const transactionId = value.transactionId === undefined ? null : value.transactionId
  const hasDueSnapshot = value.outstandingBeforeMinor !== undefined || value.outstandingAfterMinor !== undefined
  const validDueSnapshot = !hasDueSnapshot || (
    isSafeNonNegativeInteger(value.outstandingBeforeMinor) &&
    isSafeNonNegativeInteger(value.outstandingAfterMinor) &&
    value.outstandingBeforeMinor >= allocatedAmountMinor &&
    value.outstandingAfterMinor === value.outstandingBeforeMinor - allocatedAmountMinor
  )

  if (
    !parsed.success ||
    !isSafeNonNegativeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !isSafeNonNegativeInteger(openingBalanceAllocationMinor) ||
    value.receiptNumber !== `PAY-${id}` ||
    (transactionId !== null && (typeof transactionId !== 'string' || !/^[A-Z0-9]{10}$/.test(transactionId))) ||
    value.allocatedAmountMinor !== allocatedAmountMinor ||
    value.advanceAddedMinor !== advanceAddedMinor ||
    advanceAddedMinor < 0 ||
    !validDueSnapshot ||
    value.currency !== 'BDT' ||
    value.status !== 'posted' ||
    !Array.isArray(value.balanceUpdates) ||
    value.balanceUpdates.length !== parsed.data.allocations.length ||
    !isRecord(value.creditUpdate) ||
    value.creditUpdate.tenantId !== parsed.data.tenantId ||
    value.creditUpdate.amountMinor !== advanceAddedMinor ||
    typeof value.createdBy !== 'string' ||
    typeof value.updatedBy !== 'string' ||
    !(value.createdAt instanceof Timestamp) ||
    !(value.updatedAt instanceof Timestamp)
  ) {
    throw new InvalidPaymentDataError(`Payment ${id} contains invalid or inconsistent data.`)
  }

  const balanceUpdates = value.balanceUpdates.map((item): PaymentBalanceUpdate => {
    if (
      !isRecord(item) ||
      (item.billType !== 'rent' && item.billType !== 'electricity') ||
      typeof item.billId !== 'string' ||
      !isSafeNonNegativeInteger(item.amountMinor) ||
      item.amountMinor <= 0
    ) {
      throw new InvalidPaymentDataError(`Payment ${id} contains an invalid bill allocation.`)
    }
    return { billType: item.billType, billId: item.billId, amountMinor: item.amountMinor }
  })

  const expectedUpdates = parsed.data.allocations.map((allocation) => ({
    billType: allocation.billType,
    billId: allocation.billId,
    amountMinor: allocation.amountMinor,
  }))
  if (balanceUpdates.length !== expectedUpdates.length || balanceUpdates.some((item, index) => {
    const expected = expectedUpdates[index]
    return !expected || item.billType !== expected.billType || item.billId !== expected.billId || item.amountMinor !== expected.amountMinor
  })) {
    throw new InvalidPaymentDataError(`Payment ${id} has inconsistent allocation snapshots.`)
  }

  return {
    id,
    receiptNumber: value.receiptNumber as string,
    transactionId: typeof transactionId === 'string' ? transactionId : null,
    tenantId: parsed.data.tenantId,
    tenantCode: parsed.data.tenantCode,
    tenantName: parsed.data.tenantName,
    paidOn: parsed.data.paidOn,
    method: parsed.data.method,
    reference: parsed.data.reference,
    notes: parsed.data.notes,
    amountMinor,
    allocatedAmountMinor,
    advanceAddedMinor,
    outstandingBeforeMinor: hasDueSnapshot ? value.outstandingBeforeMinor as number : null,
    outstandingAfterMinor: hasDueSnapshot ? value.outstandingAfterMinor as number : null,
    openingBalanceAllocationMinor,
    creditUpdate: { tenantId: parsed.data.tenantId, amountMinor: advanceAddedMinor },
    currency: 'BDT',
    status: 'posted',
    allocations: parsed.data.allocations,
    balanceUpdates,
    createdAt: getTimestamp(value.createdAt),
    updatedAt: getTimestamp(value.updatedAt),
    createdBy: value.createdBy,
    updatedBy: value.updatedBy,
  }
}

function paymentMatchesAttempt(existing: PaymentRecord, input: PaymentFormValues): boolean {
  if (
    existing.tenantId !== input.tenantId ||
    existing.tenantCode !== input.tenantCode ||
    existing.tenantName !== input.tenantName ||
    existing.paidOn !== input.paidOn ||
    existing.method !== input.method ||
    existing.reference !== input.reference ||
    existing.notes !== input.notes ||
    existing.amountMinor !== input.amountReceivedMinor ||
    existing.openingBalanceAllocationMinor !== input.openingBalanceAllocationMinor ||
    existing.allocations.length !== input.allocations.length
  ) return false
  return existing.allocations.every((allocation, index) => sameAllocation(allocation, input.allocations[index]))
}

function readBillBalance(id: string, value: unknown): PaymentBillBalanceRecord {
  if (!isRecord(value)) throw new InvalidPaymentDataError(`Bill balance ${id} contains invalid data.`)
  const stringFields = [
    'billId', 'billingMonth', 'tenantAssignmentId', 'tenantId', 'tenantCode',
    'tenantName', 'roomId', 'roomCode', 'roomNumber', 'floorName',
    'propertyId', 'propertyCode', 'lastTransactionId', 'createdBy', 'updatedBy',
  ] as const

  if (
    (value.billType !== 'rent' && value.billType !== 'electricity') ||
    stringFields.some((field) => typeof value[field] !== 'string') ||
    (value.lastTransactionType !== 'payment' && value.lastTransactionType !== 'credit_application') ||
    !isSafeNonNegativeInteger(value.originalAmountMinor) ||
    value.originalAmountMinor <= 0 ||
    !isSafeNonNegativeInteger(value.paidAmountMinor) ||
    !isSafeNonNegativeInteger(value.outstandingMinor) ||
    !isSafeNonNegativeInteger(value.lastTransactionAmountMinor) ||
    value.lastTransactionAmountMinor <= 0 ||
    value.lastTransactionAmountMinor > value.originalAmountMinor ||
    !(value.createdAt instanceof Timestamp) ||
    !(value.updatedAt instanceof Timestamp) ||
    value.paidAmountMinor + value.outstandingMinor !== value.originalAmountMinor
  ) {
    throw new InvalidPaymentDataError(`Bill balance ${id} has inconsistent amounts or fields.`)
  }

  return {
    id,
    billType: value.billType,
    billId: value.billId as string,
    billingMonth: value.billingMonth as string,
    tenantAssignmentId: value.tenantAssignmentId as string,
    tenantId: value.tenantId as string,
    tenantCode: value.tenantCode as string,
    tenantName: value.tenantName as string,
    roomId: value.roomId as string,
    roomCode: value.roomCode as string,
    roomNumber: value.roomNumber as string,
    floorName: value.floorName as string,
    propertyId: value.propertyId as string,
    propertyCode: value.propertyCode as string,
    originalAmountMinor: value.originalAmountMinor,
    paidAmountMinor: value.paidAmountMinor,
    outstandingMinor: value.outstandingMinor,
    lastTransactionType: value.lastTransactionType,
    lastTransactionId: value.lastTransactionId as string,
    lastTransactionAmountMinor: value.lastTransactionAmountMinor,
    createdAt: getTimestamp(value.createdAt),
    updatedAt: getTimestamp(value.updatedAt),
    createdBy: value.createdBy as string,
    updatedBy: value.updatedBy as string,
  }
}

function readTenantCredit(id: string, value: unknown): TenantCreditRecord {
  if (!isRecord(value) || value.tenantId !== id) {
    throw new InvalidPaymentDataError(`Tenant credit ${id} contains invalid data.`)
  }
  if (
    typeof value.tenantCode !== 'string' ||
    !/^T[0-9]{5}[A-Z]$/.test(value.tenantCode) ||
    typeof value.tenantName !== 'string' || value.tenantName.length < 2 ||
    (value.lastTransactionType !== 'payment' && value.lastTransactionType !== 'credit_application') ||
    typeof value.lastTransactionId !== 'string' ||
    !isSafeNonNegativeInteger(value.creditMinor) ||
    !isSafeNonNegativeInteger(value.lastTransactionAmountMinor) ||
    value.lastTransactionAmountMinor <= 0 ||
    !(value.createdAt instanceof Timestamp) ||
    !(value.updatedAt instanceof Timestamp) ||
    typeof value.createdBy !== 'string' ||
    typeof value.updatedBy !== 'string'
  ) {
    throw new InvalidPaymentDataError(`Tenant credit ${id} contains invalid or inconsistent values.`)
  }
  return {
    id,
    tenantId: id,
    tenantCode: value.tenantCode,
    tenantName: value.tenantName,
    creditMinor: value.creditMinor,
    lastTransactionType: value.lastTransactionType,
    lastTransactionId: value.lastTransactionId,
    lastTransactionAmountMinor: value.lastTransactionAmountMinor,
    createdAt: getTimestamp(value.createdAt),
    updatedAt: getTimestamp(value.updatedAt),
    createdBy: value.createdBy,
    updatedBy: value.updatedBy,
  }
}

function readCreditApplication(id: string, value: unknown): CreditApplicationRecord {
  if (!isRecord(value)) throw new InvalidPaymentDataError(`Advance application ${id} contains invalid data.`)
  const allocationResult = paymentAllocationSchema.safeParse(value.allocation)
  const amountMinor = value.amountMinor
  const billUpdates = value.billUpdates
  const creditUpdate = value.tenantCreditUpdate
  const applicationNumber = typeof value.applicationNumber === 'string'
    ? value.applicationNumber
    : ''
  const isLegacyApplicationNumber = applicationNumber === `ADV-${id}`
  const isCurrentApplicationNumber = /^AP-[A-Za-z0-9]{7}$/.test(applicationNumber)
  if (
    !allocationResult.success ||
    (!isLegacyApplicationNumber && !isCurrentApplicationNumber) ||
    value.tenantId !== allocationResult.data.tenantId ||
    value.tenantCode !== allocationResult.data.tenantCode ||
    value.tenantName !== allocationResult.data.tenantName ||
    amountMinor !== allocationResult.data.amountMinor ||
    !Array.isArray(billUpdates) || billUpdates.length !== 1 ||
    !isRecord(billUpdates[0]) ||
    billUpdates[0].billType !== allocationResult.data.billType ||
    billUpdates[0].billId !== allocationResult.data.billId ||
    billUpdates[0].amountMinor !== allocationResult.data.amountMinor ||
    !isRecord(creditUpdate) ||
    creditUpdate.tenantId !== allocationResult.data.tenantId ||
    creditUpdate.amountMinor !== allocationResult.data.amountMinor ||
    value.currency !== 'BDT' || value.status !== 'posted' ||
    !(value.createdAt instanceof Timestamp) || !(value.updatedAt instanceof Timestamp) ||
    typeof value.createdBy !== 'string' || typeof value.updatedBy !== 'string'
  ) {
    throw new InvalidPaymentDataError(`Advance application ${id} contains inconsistent data.`)
  }
  return {
    id,
    applicationNumber,
    tenantId: allocationResult.data.tenantId,
    tenantCode: allocationResult.data.tenantCode,
    tenantName: allocationResult.data.tenantName,
    allocation: allocationResult.data,
    billUpdates: [{
      billType: allocationResult.data.billType,
      billId: allocationResult.data.billId,
      amountMinor: allocationResult.data.amountMinor,
    }],
    tenantCreditUpdate: {
      tenantId: allocationResult.data.tenantId,
      amountMinor: allocationResult.data.amountMinor,
    },
    amountMinor: allocationResult.data.amountMinor,
    currency: 'BDT',
    status: 'posted',
    createdAt: getTimestamp(value.createdAt),
    updatedAt: getTimestamp(value.updatedAt),
    createdBy: value.createdBy,
    updatedBy: value.updatedBy,
  }
}

function sameCreditApplication(existing: CreditApplicationRecord, allocation: PaymentAllocationFormValues): boolean {
  return sameAllocation(existing.allocation, allocation)
}

export async function listPayments(ownerUid: string): Promise<PaymentRecord[]> {
  return getCachedList(ownerUid, 'Payments', async () => {
    const { db } = getFirebaseServices()
    const paymentRef = collection(db, 'users', ownerUid, 'payments')
    const snapshot = await getDocs(query(paymentRef, orderBy('paidOn', 'desc')))
    return snapshot.docs.map((item) => readPaymentRecord(item.id, item.data()))
  })
}

export async function listPaymentBillBalances(ownerUid: string): Promise<PaymentBillBalanceRecord[]> {
  return getCachedList(ownerUid, 'PaymentBillBalances', async () => {
    const { db } = getFirebaseServices()
    const snapshot = await getDocs(collection(db, 'users', ownerUid, 'billBalances'))
    return snapshot.docs.map((item) => readBillBalance(item.id, item.data()))
  })
}

export async function listTenantCredits(ownerUid: string): Promise<TenantCreditRecord[]> {
  return getCachedList(ownerUid, 'TenantCredits', async () => {
    const { db } = getFirebaseServices()
    const snapshot = await getDocs(collection(db, 'users', ownerUid, 'tenantCredits'))
    return snapshot.docs.map((item) => readTenantCredit(item.id, item.data()))
  })
}

export async function listCreditApplications(ownerUid: string): Promise<CreditApplicationRecord[]> {
  return getCachedList(ownerUid, 'CreditApplications', async () => {
    const { db } = getFirebaseServices()
    const creditApplicationsRef = collection(db, 'users', ownerUid, 'creditApplications')
    const snapshot = await getDocs(query(creditApplicationsRef, orderBy('createdAt', 'desc')))
    return snapshot.docs.map((item) => readCreditApplication(item.id, item.data()))
  })
}

function readOpeningBalanceCreditApplication(id: string, value: unknown): OpeningBalanceCreditApplicationRecord {
  if (!isRecord(value) ||
    value.applicationNumber !== `OBC-${id}` ||
    typeof value.tenantId !== 'string' ||
    typeof value.tenantCode !== 'string' || !/^T[0-9]{5}[A-Z]$/.test(value.tenantCode) ||
    typeof value.tenantName !== 'string' || value.tenantName.length < 2 ||
    !isSafeNonNegativeInteger(value.amountMinor) || value.amountMinor <= 0 ||
    !isRecord(value.tenantCreditUpdate) || value.tenantCreditUpdate.tenantId !== value.tenantId || value.tenantCreditUpdate.amountMinor !== value.amountMinor ||
    value.currency !== 'BDT' || value.status !== 'posted' ||
    !(value.createdAt instanceof Timestamp) || !(value.updatedAt instanceof Timestamp) ||
    typeof value.createdBy !== 'string' || typeof value.updatedBy !== 'string'
  ) throw new InvalidPaymentDataError(`Opening balance advance application ${id} contains invalid data.`)
  return {
    id,
    applicationNumber: value.applicationNumber,
    tenantId: value.tenantId,
    tenantCode: value.tenantCode,
    tenantName: value.tenantName,
    amountMinor: value.amountMinor,
    currency: 'BDT',
    status: 'posted',
    createdAt: getTimestamp(value.createdAt),
    updatedAt: getTimestamp(value.updatedAt),
    createdBy: value.createdBy,
    updatedBy: value.updatedBy,
  }
}

export async function listOpeningBalanceCreditApplications(ownerUid: string): Promise<OpeningBalanceCreditApplicationRecord[]> {
  return getCachedList(ownerUid, 'OpeningBalanceCreditApplications', async () => {
    const { db } = getFirebaseServices()
    const refs = collection(db, 'users', ownerUid, 'openingBalanceCreditApplications')
    const snapshot = await getDocs(query(refs, orderBy('createdAt', 'desc')))
    return snapshot.docs.map((item) => readOpeningBalanceCreditApplication(item.id, item.data()))
  })
}

export async function createPayment(
  ownerUid: string,
  rawInput: PaymentFormValues,
  idempotencyKey?: string,
): Promise<PaymentCreationResult> {
  const input = paymentFormSchema.parse(rawInput)
  const billAllocatedAmountMinor = input.allocations.reduce((total, allocation) => total + allocation.amountMinor, 0)
  const allocatedAmountMinor = billAllocatedAmountMinor + input.openingBalanceAllocationMinor
  const advanceAddedMinor = input.amountReceivedMinor - allocatedAmountMinor
  if (!isSafeNonNegativeInteger(input.outstandingBeforeMinor)) {
    throw new InvalidPaymentDataError('The tenant outstanding due snapshot is missing. Refresh the payment page and try again.')
  }
  if (allocatedAmountMinor > input.outstandingBeforeMinor) {
    throw new InvalidPaymentDataError('The selected bill allocations exceed the tenant outstanding due snapshot. Refresh and try again.')
  }
  const outstandingAfterMinor = input.outstandingBeforeMinor - allocatedAmountMinor
  if (
    !Number.isSafeInteger(allocatedAmountMinor) ||
    allocatedAmountMinor < 0 ||
    !Number.isSafeInteger(advanceAddedMinor) ||
    advanceAddedMinor < 0
  ) {
    throw new InvalidPaymentDataError('Payment and allocation totals are not safe monetary amounts.')
  }

  const { auth, db } = getFirebaseServices()
  const actorUid = auth.currentUser?.uid
  if (!actorUid || actorUid !== ownerUid) {
    throw new InvalidPaymentDataError('Your sign-in session does not match this workspace. Sign in again.')
  }
  if (idempotencyKey !== undefined && !/^[a-f0-9]{32}$/.test(idempotencyKey)) {
    throw new InvalidPaymentDataError('The payment attempt identifier is invalid. Start a new payment attempt.')
  }

  const paymentRef = idempotencyKey
    ? doc(db, 'users', ownerUid, 'payments', `p_${idempotencyKey}`)
    : doc(collection(db, 'users', ownerUid, 'payments'))
  const receiptNumber = `PAY-${paymentRef.id}`
  const tenantRef = doc(db, 'users', ownerUid, 'tenants', input.tenantId)
  const creditRef = doc(db, 'users', ownerUid, 'tenantCredits', input.tenantId)
  const openingBalanceRef = doc(db, 'users', ownerUid, 'openingBalances', input.tenantId)
  const references = input.allocations.map((allocation) => ({
    allocation,
    billRef: doc(db, 'users', ownerUid, allocation.billType === 'rent' ? 'rentBills' : 'electricityBills', allocation.billId),
    balanceRef: doc(db, 'users', ownerUid, 'billBalances', balanceDocumentId(allocation.billType, allocation.billId)),
    assignmentRef: doc(db, 'users', ownerUid, 'tenantAssignments', allocation.tenantAssignmentId),
  }))

  for (let referenceAttempt = 0; referenceAttempt < 12; referenceAttempt += 1) {
    const transactionId = generateTransactionId()
    const transactionReferenceRef = doc(db, 'users', ownerUid, 'transactionReferences', transactionId)

    try {
      return await runTransaction(db, async (transaction) => {
    const paymentSnapshot = await transaction.get(paymentRef)
    if (paymentSnapshot.exists()) {
      const existing = readPaymentRecord(paymentSnapshot.id, paymentSnapshot.data())
      if (paymentMatchesAttempt(existing, input)) {
        return { id: existing.id, receiptNumber: existing.receiptNumber, transactionId: existing.transactionId }
      }
      throw new InvalidPaymentDataError('This payment attempt was already used for different details. Start a new payment attempt.')
    }

    const transactionReferenceSnapshot = await transaction.get(transactionReferenceRef)
    if (transactionReferenceSnapshot.exists()) throw new TransactionReferenceCollisionError()

    const tenantSnapshotPromise = transaction.get(tenantRef)
    const creditSnapshotPromise = advanceAddedMinor > 0 ? transaction.get(creditRef) : Promise.resolve(null)
    const openingBalanceSnapshotPromise = input.openingBalanceAllocationMinor > 0
      ? transaction.get(openingBalanceRef)
      : Promise.resolve(null)
    const [tenantSnapshot, creditSnapshot, openingBalanceSnapshot] = await Promise.all([
      tenantSnapshotPromise,
      creditSnapshotPromise,
      openingBalanceSnapshotPromise,
    ])
    if (!tenantSnapshot.exists()) throw new InvalidPaymentDataError('The selected tenant no longer exists.')
    const tenantData = tenantSnapshot.data() as UnknownRecord
    if (tenantData.tenantCode !== input.tenantCode || tenantData.fullName !== input.tenantName) {
      throw new InvalidPaymentDataError('The selected tenant details changed. Refresh before recording this payment.')
    }

    const readSets = await Promise.all(references.map(async (reference) => {
      const [billSnapshot, balanceSnapshot, assignmentSnapshot] = await Promise.all([
        transaction.get(reference.billRef),
        transaction.get(reference.balanceRef),
        transaction.get(reference.assignmentRef),
      ])
      return { ...reference, billSnapshot, balanceSnapshot, assignmentSnapshot }
    }))

    const writes = readSets.map((readSet) => {
      const { allocation, billSnapshot, balanceSnapshot, assignmentSnapshot } = readSet
      if (!billSnapshot.exists()) throw new PaymentBillNotFoundError()
      if (!assignmentSnapshot.exists()) throw new PaymentAssignmentMismatchError()
      const bill = billSnapshot.data() as UnknownRecord
      const assignment = assignmentSnapshot.data() as UnknownRecord
      const sourceAmountMinor = validateSourceBill(allocation.billType, allocation.billId, bill, assignment, allocation)

      let paidAmountMinor = 0
      let createdAt: Timestamp | ReturnType<typeof serverTimestamp> = serverTimestamp()
      let createdBy = actorUid
      if (balanceSnapshot.exists()) {
        const balance = readBillBalance(balanceSnapshot.id, balanceSnapshot.data())
        if (
          balance.billType !== allocation.billType || balance.billId !== allocation.billId ||
          balance.originalAmountMinor !== sourceAmountMinor || balance.billingMonth !== allocation.billingMonth ||
          balance.tenantAssignmentId !== allocation.tenantAssignmentId || balance.tenantId !== allocation.tenantId ||
          balance.roomId !== allocation.roomId || balance.roomCode !== allocation.roomCode ||
          balance.propertyId !== allocation.propertyId || balance.propertyCode !== allocation.propertyCode
        ) throw new PaymentBillMismatchError()
        paidAmountMinor = balance.paidAmountMinor
        createdAt = balance.createdAt ?? serverTimestamp()
        createdBy = balance.createdBy
      }
      const outstandingMinor = sourceAmountMinor - paidAmountMinor
      if (outstandingMinor <= 0) throw new PaymentBillSettledError()
      if (allocation.amountMinor > outstandingMinor) throw new PaymentAmountExceedsBalanceError()
      const nextPaidAmountMinor = paidAmountMinor + allocation.amountMinor
      if (!Number.isSafeInteger(nextPaidAmountMinor) || nextPaidAmountMinor > sourceAmountMinor) {
        throw new PaymentAmountExceedsBalanceError()
      }

      return {
        balanceRef: readSet.balanceRef,
        balanceData: {
          billType: allocation.billType,
          billId: allocation.billId,
          billingMonth: allocation.billingMonth,
          tenantAssignmentId: allocation.tenantAssignmentId,
          tenantId: allocation.tenantId,
          tenantCode: allocation.tenantCode,
          tenantName: allocation.tenantName,
          roomId: allocation.roomId,
          roomCode: allocation.roomCode,
          roomNumber: allocation.roomNumber,
          floorName: allocation.floorName,
          propertyId: allocation.propertyId,
          propertyCode: allocation.propertyCode,
          originalAmountMinor: sourceAmountMinor,
          paidAmountMinor: nextPaidAmountMinor,
          outstandingMinor: sourceAmountMinor - nextPaidAmountMinor,
          lastTransactionType: 'payment' as const,
          lastTransactionId: paymentRef.id,
          lastTransactionAmountMinor: allocation.amountMinor,
          createdAt,
          updatedAt: serverTimestamp(),
          createdBy,
          updatedBy: actorUid,
        },
      }
    })

    let openingBalanceWrite: UnknownRecord | null = null
    if (input.openingBalanceAllocationMinor > 0) {
      if (!openingBalanceSnapshot?.exists()) {
        throw new InvalidPaymentDataError('This tenant does not have an opening balance to settle.')
      }
      const openingBalance = readOpeningBalance(openingBalanceSnapshot.id, openingBalanceSnapshot.data())
      if (
        openingBalance.tenantId !== input.tenantId ||
        openingBalance.tenantCode !== input.tenantCode ||
        openingBalance.tenantName !== input.tenantName
      ) throw new InvalidPaymentDataError('The opening balance no longer matches the selected tenant. Refresh and try again.')
      if (input.openingBalanceAllocationMinor > openingBalance.outstandingMinor) {
        throw new PaymentAmountExceedsBalanceError()
      }
      openingBalanceWrite = {
        tenantId: openingBalance.tenantId,
        tenantCode: openingBalance.tenantCode,
        tenantName: openingBalance.tenantName,
        effectiveDate: openingBalance.effectiveDate,
        originalAmountMinor: openingBalance.originalAmountMinor,
        adjustedAmountMinor: openingBalance.adjustedAmountMinor,
        paidAmountMinor: openingBalance.paidAmountMinor + input.openingBalanceAllocationMinor,
        outstandingMinor: openingBalance.outstandingMinor - input.openingBalanceAllocationMinor,
        note: openingBalance.note,
        lastTransactionType: 'payment',
        lastTransactionId: paymentRef.id,
        lastTransactionAmountMinor: input.openingBalanceAllocationMinor,
        createdAt: openingBalance.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: openingBalance.createdBy,
        updatedBy: actorUid,
      }
    }

    let creditWrite: UnknownRecord | null = null
    if (advanceAddedMinor > 0) {
      let currentCreditMinor = 0
      let creditCreatedAt: Timestamp | ReturnType<typeof serverTimestamp> = serverTimestamp()
      let creditCreatedBy = actorUid
      if (creditSnapshot?.exists()) {
        const currentCredit = readTenantCredit(creditSnapshot.id, creditSnapshot.data())
        if (currentCredit.tenantCode !== input.tenantCode) throw new InvalidPaymentDataError('Tenant credit belongs to a different tenant code.')
        currentCreditMinor = currentCredit.creditMinor
        creditCreatedAt = currentCredit.createdAt ?? serverTimestamp()
        creditCreatedBy = currentCredit.createdBy
      }
      const nextCreditMinor = currentCreditMinor + advanceAddedMinor
      if (!Number.isSafeInteger(nextCreditMinor)) throw new InvalidPaymentDataError('Advance credit exceeds the safe calculation limit.')
      creditWrite = {
        tenantId: input.tenantId,
        tenantCode: input.tenantCode,
        tenantName: input.tenantName,
        creditMinor: nextCreditMinor,
        lastTransactionType: 'payment',
        lastTransactionId: paymentRef.id,
        lastTransactionAmountMinor: advanceAddedMinor,
        createdAt: creditCreatedAt,
        updatedAt: serverTimestamp(),
        createdBy: creditCreatedBy,
        updatedBy: actorUid,
      }
    }

    const balanceUpdates = input.allocations.map((allocation) => ({
      billType: allocation.billType,
      billId: allocation.billId,
      amountMinor: allocation.amountMinor,
    }))
    transaction.set(paymentRef, {
      receiptNumber,
      transactionId,
      tenantId: input.tenantId,
      tenantCode: input.tenantCode,
      tenantName: input.tenantName,
      paidOn: input.paidOn,
      method: input.method,
      reference: input.reference,
      notes: input.notes,
      amountMinor: input.amountReceivedMinor,
      allocatedAmountMinor,
      advanceAddedMinor,
      openingBalanceAllocationMinor: input.openingBalanceAllocationMinor,
      outstandingBeforeMinor: input.outstandingBeforeMinor,
      outstandingAfterMinor,
      creditUpdate: { tenantId: input.tenantId, amountMinor: advanceAddedMinor },
      currency: 'BDT',
      status: 'posted',
      allocations: input.allocations,
      balanceUpdates,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: actorUid,
      updatedBy: actorUid,
    })
    transaction.set(transactionReferenceRef, {
      paymentId: paymentRef.id,
      transactionId,
      createdAt: serverTimestamp(),
    })
    for (const write of writes) transaction.set(write.balanceRef, write.balanceData)
    if (openingBalanceWrite) transaction.set(openingBalanceRef, openingBalanceWrite)
    if (creditWrite) transaction.set(creditRef, creditWrite)
    return { id: paymentRef.id, receiptNumber, transactionId }
      })
    } catch (error) {
      if (error instanceof TransactionReferenceCollisionError) continue
      throw error
    }
  }

  throw new InvalidPaymentDataError('Unable to reserve a unique transaction ID. Please retry the payment.')
}

export async function applyTenantCredit(
  ownerUid: string,
  rawAllocation: PaymentAllocationFormValues,
  idempotencyKey?: string,
): Promise<string> {
  const allocation = paymentAllocationSchema.parse(rawAllocation)
  const { auth, db } = getFirebaseServices()
  const actorUid = auth.currentUser?.uid
  if (!actorUid || actorUid !== ownerUid) {
    throw new InvalidPaymentDataError('Your sign-in session does not match this workspace. Sign in again.')
  }
  if (idempotencyKey !== undefined && !/^[a-f0-9]{32}$/.test(idempotencyKey)) {
    throw new InvalidPaymentDataError('The advance application attempt identifier is invalid.')
  }

  const applicationRef = idempotencyKey
    ? doc(db, 'users', ownerUid, 'creditApplications', `ca_${idempotencyKey}`)
    : doc(collection(db, 'users', ownerUid, 'creditApplications'))
  const creditRef = doc(db, 'users', ownerUid, 'tenantCredits', allocation.tenantId)
  const billRef = doc(db, 'users', ownerUid, allocation.billType === 'rent' ? 'rentBills' : 'electricityBills', allocation.billId)
  const balanceRef = doc(db, 'users', ownerUid, 'billBalances', balanceDocumentId(allocation.billType, allocation.billId))
  const assignmentRef = doc(db, 'users', ownerUid, 'tenantAssignments', allocation.tenantAssignmentId)

  // Reserve the short public reference in a separate document in the same
  // transaction. The document ID itself makes duplicate AP codes impossible.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const applicationNumber = `AP-${generateAdvanceReferenceCode()}`
    const referenceIndexRef = doc(db, 'users', ownerUid, 'creditApplicationReferenceIndex', applicationNumber)
    try {
      return await runTransaction(db, async (transaction) => {
        const applicationSnapshot = await transaction.get(applicationRef)
        if (applicationSnapshot.exists()) {
          const existing = readCreditApplication(applicationSnapshot.id, applicationSnapshot.data())
          if (sameCreditApplication(existing, allocation)) return existing.applicationNumber
          throw new InvalidPaymentDataError('This advance application attempt was already used for different details.')
        }

        const referenceIndexSnapshot = await transaction.get(referenceIndexRef)
        if (referenceIndexSnapshot.exists()) throw new AdvanceReferenceCollisionError()

        const [creditSnapshot, billSnapshot, balanceSnapshot, assignmentSnapshot] = await Promise.all([
          transaction.get(creditRef),
          transaction.get(billRef),
          transaction.get(balanceRef),
          transaction.get(assignmentRef),
        ])
        if (!creditSnapshot.exists()) throw new InsufficientTenantCreditError()
        if (!billSnapshot.exists()) throw new PaymentBillNotFoundError()
        if (!assignmentSnapshot.exists()) throw new PaymentAssignmentMismatchError()

        const credit = readTenantCredit(creditSnapshot.id, creditSnapshot.data())
        if (credit.tenantCode !== allocation.tenantCode || credit.creditMinor < allocation.amountMinor) {
          throw new InsufficientTenantCreditError()
        }
        const bill = billSnapshot.data() as UnknownRecord
        const assignment = assignmentSnapshot.data() as UnknownRecord
        const sourceAmountMinor = validateSourceBill(allocation.billType, allocation.billId, bill, assignment, allocation)

        let paidAmountMinor = 0
        let balanceCreatedAt: Timestamp | ReturnType<typeof serverTimestamp> = serverTimestamp()
        let balanceCreatedBy = actorUid
        if (balanceSnapshot.exists()) {
          const balance = readBillBalance(balanceSnapshot.id, balanceSnapshot.data())
          if (
            balance.billType !== allocation.billType || balance.billId !== allocation.billId ||
            balance.originalAmountMinor !== sourceAmountMinor || balance.billingMonth !== allocation.billingMonth ||
            balance.tenantAssignmentId !== allocation.tenantAssignmentId || balance.tenantId !== allocation.tenantId ||
            balance.roomId !== allocation.roomId || balance.roomCode !== allocation.roomCode ||
            balance.propertyId !== allocation.propertyId || balance.propertyCode !== allocation.propertyCode
          ) throw new PaymentBillMismatchError()
          paidAmountMinor = balance.paidAmountMinor
          balanceCreatedAt = balance.createdAt ?? serverTimestamp()
          balanceCreatedBy = balance.createdBy
        }
        const outstandingMinor = sourceAmountMinor - paidAmountMinor
        if (outstandingMinor <= 0) throw new PaymentBillSettledError()
        if (allocation.amountMinor > outstandingMinor) throw new PaymentAmountExceedsBalanceError()

        const applicationData = {
          applicationNumber,
          tenantId: allocation.tenantId,
          tenantCode: allocation.tenantCode,
          tenantName: allocation.tenantName,
          allocation,
          billUpdates: [{ billType: allocation.billType, billId: allocation.billId, amountMinor: allocation.amountMinor }],
          tenantCreditUpdate: { tenantId: allocation.tenantId, amountMinor: allocation.amountMinor },
          amountMinor: allocation.amountMinor,
          currency: 'BDT',
          status: 'posted',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: actorUid,
          updatedBy: actorUid,
        }
        const nextPaidAmountMinor = paidAmountMinor + allocation.amountMinor
        const balanceData = {
          billType: allocation.billType,
          billId: allocation.billId,
          billingMonth: allocation.billingMonth,
          tenantAssignmentId: allocation.tenantAssignmentId,
          tenantId: allocation.tenantId,
          tenantCode: allocation.tenantCode,
          tenantName: allocation.tenantName,
          roomId: allocation.roomId,
          roomCode: allocation.roomCode,
          roomNumber: allocation.roomNumber,
          floorName: allocation.floorName,
          propertyId: allocation.propertyId,
          propertyCode: allocation.propertyCode,
          originalAmountMinor: sourceAmountMinor,
          paidAmountMinor: nextPaidAmountMinor,
          outstandingMinor: sourceAmountMinor - nextPaidAmountMinor,
          lastTransactionType: 'credit_application',
          lastTransactionId: applicationRef.id,
          lastTransactionAmountMinor: allocation.amountMinor,
          createdAt: balanceCreatedAt,
          updatedAt: serverTimestamp(),
          createdBy: balanceCreatedBy,
          updatedBy: actorUid,
        }
        const creditData = {
          tenantId: credit.tenantId,
          tenantCode: credit.tenantCode,
          tenantName: credit.tenantName,
          creditMinor: credit.creditMinor - allocation.amountMinor,
          lastTransactionType: 'credit_application',
          lastTransactionId: applicationRef.id,
          lastTransactionAmountMinor: allocation.amountMinor,
          createdAt: credit.createdAt ?? serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: credit.createdBy,
          updatedBy: actorUid,
        }

        transaction.set(applicationRef, applicationData)
        transaction.set(referenceIndexRef, {
          applicationId: applicationRef.id,
          applicationNumber,
          createdAt: serverTimestamp(),
          createdBy: actorUid,
        })
        transaction.set(balanceRef, balanceData)
        transaction.set(creditRef, creditData)
        return applicationNumber
      })
    } catch (error) {
      if (error instanceof AdvanceReferenceCollisionError) continue
      throw error
    }
  }

  throw new InvalidPaymentDataError('Unable to reserve a unique advance application reference. Please retry.')
}

/** Apply existing advance credit to the tenant-level opening balance. */
export async function applyTenantCreditToOpeningBalance(
  ownerUid: string,
  tenantId: string,
  tenantCode: string,
  tenantName: string,
  amountMinor: number,
  idempotencyKey: string,
): Promise<string> {
  const { auth, db } = getFirebaseServices()
  const actorUid = auth.currentUser?.uid
  if (!actorUid || actorUid !== ownerUid) throw new InvalidPaymentDataError('Your sign-in session does not match this workspace. Sign in again.')
  if (!/^[a-f0-9]{32}$/.test(idempotencyKey) || !isSafeNonNegativeInteger(amountMinor) || amountMinor <= 0) {
    throw new InvalidPaymentDataError('The opening balance advance application is invalid.')
  }

  const applicationRef = doc(db, 'users', ownerUid, 'openingBalanceCreditApplications', `obca_${idempotencyKey}`)
  const openingBalanceRef = doc(db, 'users', ownerUid, 'openingBalances', tenantId)
  const tenantRef = doc(db, 'users', ownerUid, 'tenants', tenantId)
  const creditRef = doc(db, 'users', ownerUid, 'tenantCredits', tenantId)
  const applicationNumber = `OBC-${applicationRef.id}`

  return runTransaction(db, async (transaction) => {
    const existingSnapshot = await transaction.get(applicationRef)
    if (existingSnapshot.exists()) {
      const existing = readOpeningBalanceCreditApplication(existingSnapshot.id, existingSnapshot.data())
      if (existing.tenantId === tenantId && existing.tenantCode === tenantCode && existing.tenantName === tenantName && existing.amountMinor === amountMinor) {
        return existing.applicationNumber
      }
      throw new InvalidPaymentDataError('This advance application attempt was already used for different details.')
    }

    const [tenantSnapshot, balanceSnapshot, creditSnapshot] = await Promise.all([
      transaction.get(tenantRef),
      transaction.get(openingBalanceRef),
      transaction.get(creditRef),
    ])
    if (!tenantSnapshot.exists() || !balanceSnapshot.exists()) throw new InvalidPaymentDataError('The tenant opening balance no longer exists.')
    if (!creditSnapshot.exists()) throw new InsufficientTenantCreditError()
    const tenant = tenantSnapshot.data()
    if (tenant.tenantCode !== tenantCode || tenant.fullName !== tenantName) throw new InvalidPaymentDataError('Tenant details changed. Refresh and try again.')

    const openingBalance = readOpeningBalance(balanceSnapshot.id, balanceSnapshot.data())
    const credit = readTenantCredit(creditSnapshot.id, creditSnapshot.data())
    if (openingBalance.tenantCode !== tenantCode || openingBalance.tenantName !== tenantName || credit.tenantCode !== tenantCode) {
      throw new InvalidPaymentDataError('The tenant opening balance or advance credit does not match the selected tenant.')
    }
    if (credit.creditMinor < amountMinor) throw new InsufficientTenantCreditError()
    if (openingBalance.outstandingMinor < amountMinor) throw new PaymentAmountExceedsBalanceError()

    transaction.set(applicationRef, {
      applicationNumber,
      tenantId,
      tenantCode,
      tenantName,
      amountMinor,
      tenantCreditUpdate: { tenantId, amountMinor },
      currency: 'BDT',
      status: 'posted',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: actorUid,
      updatedBy: actorUid,
    })
    transaction.update(openingBalanceRef, {
      paidAmountMinor: openingBalance.paidAmountMinor + amountMinor,
      outstandingMinor: openingBalance.outstandingMinor - amountMinor,
      lastTransactionType: 'credit_application',
      lastTransactionId: applicationRef.id,
      lastTransactionAmountMinor: amountMinor,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    })
    transaction.update(creditRef, {
      creditMinor: credit.creditMinor - amountMinor,
      lastTransactionType: 'credit_application',
      lastTransactionId: applicationRef.id,
      lastTransactionAmountMinor: amountMinor,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    })
    return applicationNumber
  })
}

export function getPaymentErrorMessage(error: unknown): string {
  if (
    error instanceof PaymentBillNotFoundError ||
    error instanceof PaymentBillMismatchError ||
    error instanceof PaymentBillSettledError ||
    error instanceof PaymentAmountExceedsBalanceError ||
    error instanceof PaymentAssignmentMismatchError ||
    error instanceof InsufficientTenantCreditError ||
    error instanceof InvalidPaymentDataError
  ) return error.message

  if (error instanceof Error) {
    if (/permission-denied|missing or insufficient permissions/i.test(error.message)) {
      return 'Database access was denied. Check that the latest payment rules are published in Firebase.'
    }
    if (error.message) return error.message
  }
  return 'Unable to complete the payment. Refresh and try again.'
}
