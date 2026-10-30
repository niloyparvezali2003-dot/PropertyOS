import { getCachedList } from './listCache'

import {
  Timestamp,
  collection,
  doc,
  getDocs,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'

import { openingBalanceAdjustmentSchema, openingBalanceFormSchema, type OpeningBalanceAdjustmentValues, type OpeningBalanceFormValues } from '../../schemas/openingBalance'
import { getCurrentActorUid, getFirebaseServices } from './client'

type UnknownRecord = Record<string, unknown>

export type OpeningBalanceRecord = {
  id: string
  tenantId: string
  tenantCode: string
  tenantName: string
  effectiveDate: string
  originalAmountMinor: number
  adjustedAmountMinor: number
  paidAmountMinor: number
  outstandingMinor: number
  note: string
  lastTransactionType: 'opening_balance' | 'payment' | 'credit_application' | 'adjustment'
  lastTransactionId: string
  lastTransactionAmountMinor: number
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type OpeningBalanceAdjustmentRecord = {
  id: string
  adjustmentNumber: string
  tenantId: string
  tenantCode: string
  tenantName: string
  direction: 'increase' | 'decrease'
  amountMinor: number
  beforeOutstandingMinor: number
  afterOutstandingMinor: number
  effectiveDate: string
  note: string
  createdAt: Timestamp | null
  createdBy: string
}

export class OpeningBalanceAlreadyExistsError extends Error {
  constructor() {
    super('An opening balance has already been recorded for this tenant. Use an audited adjustment instead of creating another one.')
    this.name = 'OpeningBalanceAlreadyExistsError'
  }
}

export class OpeningBalanceInsufficientDueError extends Error {
  constructor() {
    super('The decrease cannot be greater than the tenant’s current outstanding opening balance.')
    this.name = 'OpeningBalanceInsufficientDueError'
  }
}

function assertOwner(ownerUid: string): void {
  const { auth } = getFirebaseServices()
  if (!ownerUid || !auth.currentUser) {
    throw new Error('Sign in before accessing this workspace.')
  }
}

function isSafeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000_000_000
}

function isSafeSignedAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 10_000_000_000_000
}

export function readOpeningBalance(id: string, value: unknown): OpeningBalanceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Opening balance ${id} contains invalid data.`)
  const data = value as UnknownRecord
  if (
    data.tenantId !== id || typeof data.tenantCode !== 'string' || !/^T[0-9]{5}[A-Z]$/.test(data.tenantCode) ||
    typeof data.tenantName !== 'string' || data.tenantName.length < 2 ||
    typeof data.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.effectiveDate) ||
    !isSafeAmount(data.originalAmountMinor) || data.originalAmountMinor <= 0 ||
    !isSafeSignedAmount(data.adjustedAmountMinor) ||
    !isSafeAmount(data.paidAmountMinor) || !isSafeAmount(data.outstandingMinor) ||
    data.originalAmountMinor + (data.adjustedAmountMinor as number) < data.paidAmountMinor ||
    data.originalAmountMinor + data.adjustedAmountMinor > 10_000_000_000_000 ||
    data.outstandingMinor !== data.originalAmountMinor + data.adjustedAmountMinor - data.paidAmountMinor ||
    typeof data.note !== 'string' ||
    !['opening_balance', 'payment', 'credit_application', 'adjustment'].includes(String(data.lastTransactionType)) ||
    typeof data.lastTransactionId !== 'string' || !data.lastTransactionId ||
    !isSafeAmount(data.lastTransactionAmountMinor) || data.lastTransactionAmountMinor <= 0 ||
    typeof data.createdBy !== 'string' || !data.createdBy || typeof data.updatedBy !== 'string' || !data.updatedBy ||
    !(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)
  ) throw new Error(`Opening balance ${id} has inconsistent fields or amounts.`)
  return {
    id,
    tenantId: data.tenantId as string,
    tenantCode: data.tenantCode,
    tenantName: data.tenantName,
    effectiveDate: data.effectiveDate,
    originalAmountMinor: data.originalAmountMinor,
    adjustedAmountMinor: data.adjustedAmountMinor as number,
    paidAmountMinor: data.paidAmountMinor,
    outstandingMinor: data.outstandingMinor,
    note: data.note,
    lastTransactionType: data.lastTransactionType as OpeningBalanceRecord['lastTransactionType'],
    lastTransactionId: data.lastTransactionId,
    lastTransactionAmountMinor: data.lastTransactionAmountMinor,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt : null,
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : null,
    createdBy: data.createdBy,
    updatedBy: data.updatedBy,
  }
}

function readAdjustment(id: string, value: unknown): OpeningBalanceAdjustmentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Opening balance adjustment ${id} contains invalid data.`)
  const data = value as UnknownRecord
  if (
    data.adjustmentNumber !== `OBA-${id}` || typeof data.tenantId !== 'string' ||
    typeof data.tenantCode !== 'string' || typeof data.tenantName !== 'string' ||
    !['increase', 'decrease'].includes(String(data.direction)) || !isSafeAmount(data.amountMinor) || data.amountMinor <= 0 ||
    !isSafeAmount(data.beforeOutstandingMinor) || !isSafeAmount(data.afterOutstandingMinor) ||
    (data.direction === 'increase' && data.afterOutstandingMinor !== data.beforeOutstandingMinor + data.amountMinor) ||
    (data.direction === 'decrease' && (data.beforeOutstandingMinor < data.amountMinor || data.afterOutstandingMinor !== data.beforeOutstandingMinor - data.amountMinor)) ||
    typeof data.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.effectiveDate) ||
    typeof data.note !== 'string' || !data.note ||
    typeof data.createdBy !== 'string' || !data.createdBy || !(data.createdAt instanceof Timestamp)
  ) throw new Error(`Opening balance adjustment ${id} contains inconsistent data.`)
  return {
    id,
    adjustmentNumber: data.adjustmentNumber as string,
    tenantId: data.tenantId,
    tenantCode: data.tenantCode,
    tenantName: data.tenantName,
    direction: data.direction as 'increase' | 'decrease',
    amountMinor: data.amountMinor,
    beforeOutstandingMinor: data.beforeOutstandingMinor,
    afterOutstandingMinor: data.afterOutstandingMinor,
    effectiveDate: data.effectiveDate,
    note: data.note,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt : null,
    createdBy: data.createdBy,
  }
}

export async function listOpeningBalances(ownerUid: string): Promise<OpeningBalanceRecord[]> {
  assertOwner(ownerUid)

  return getCachedList(ownerUid, 'OpeningBalances', async () => {
    const { db } = getFirebaseServices()
    const snapshot = await getDocs(collection(db, 'users', ownerUid, 'openingBalances'))
    return snapshot.docs.map((item) => readOpeningBalance(item.id, item.data()))
  })
}

export async function listOpeningBalanceAdjustments(ownerUid: string): Promise<OpeningBalanceAdjustmentRecord[]> {
  assertOwner(ownerUid)

  return getCachedList(ownerUid, 'OpeningBalanceAdjustments', async () => {
    const { db } = getFirebaseServices()
    const snapshot = await getDocs(collection(db, 'users', ownerUid, 'openingBalanceAdjustments'))
    return snapshot.docs.map((item) => readAdjustment(item.id, item.data()))
  })
}

export async function createOpeningBalance(ownerUid: string, rawInput: OpeningBalanceFormValues): Promise<void> {
  assertOwner(ownerUid)
  const input = openingBalanceFormSchema.parse(rawInput)
  const { db } = getFirebaseServices()
  const tenantRef = doc(db, 'users', ownerUid, 'tenants', input.tenantId)
  const openingRef = doc(db, 'users', ownerUid, 'openingBalances', input.tenantId)

  await runTransaction(db, async (transaction) => {
    const [tenantSnapshot, openingSnapshot] = await Promise.all([
      transaction.get(tenantRef),
      transaction.get(openingRef),
    ])
    if (!tenantSnapshot.exists()) throw new Error('The selected tenant no longer exists.')
    const tenant = tenantSnapshot.data()
    if (tenant.tenantCode !== input.tenantCode || tenant.fullName !== input.tenantName) {
      throw new Error('Tenant details changed. Refresh before recording an opening balance.')
    }
    if (openingSnapshot.exists()) throw new OpeningBalanceAlreadyExistsError()
    transaction.set(openingRef, {
      tenantId: input.tenantId,
      tenantCode: input.tenantCode,
      tenantName: input.tenantName,
      effectiveDate: input.effectiveDate,
      originalAmountMinor: input.amountMinor,
      adjustedAmountMinor: 0,
      paidAmountMinor: 0,
      outstandingMinor: input.amountMinor,
      note: input.note,
      lastTransactionType: 'opening_balance',
      lastTransactionId: openingRef.id,
      lastTransactionAmountMinor: input.amountMinor,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
    })
  })
}

export async function adjustOpeningBalance(
  ownerUid: string,
  tenantId: string,
  rawInput: OpeningBalanceAdjustmentValues,
): Promise<string> {
  assertOwner(ownerUid)
  const input = openingBalanceAdjustmentSchema.parse(rawInput)
  const { db } = getFirebaseServices()
  const openingRef = doc(db, 'users', ownerUid, 'openingBalances', tenantId)
  const adjustmentRef = doc(collection(db, 'users', ownerUid, 'openingBalanceAdjustments'))

  await runTransaction(db, async (transaction) => {
    const openingSnapshot = await transaction.get(openingRef)
    if (!openingSnapshot.exists()) throw new Error('No opening balance exists for this tenant.')
    const current = readOpeningBalance(openingSnapshot.id, openingSnapshot.data())
    const nextOutstanding = input.direction === 'increase'
      ? current.outstandingMinor + input.amountMinor
      : current.outstandingMinor - input.amountMinor
    if (input.direction === 'decrease' && nextOutstanding < 0) throw new OpeningBalanceInsufficientDueError()
    if (!Number.isSafeInteger(nextOutstanding) || nextOutstanding > 10_000_000_000_000) throw new Error('The adjusted balance exceeds the allowed amount.')
    const signedAdjustment = input.direction === 'increase' ? input.amountMinor : -input.amountMinor
    const nextAdjustedAmount = current.adjustedAmountMinor + signedAdjustment
    const nextOriginalTotal = current.originalAmountMinor + nextAdjustedAmount
    if (nextOriginalTotal < current.paidAmountMinor) throw new OpeningBalanceInsufficientDueError()

    transaction.set(adjustmentRef, {
      adjustmentNumber: `OBA-${adjustmentRef.id}`,
      tenantId,
      tenantCode: current.tenantCode,
      tenantName: current.tenantName,
      direction: input.direction,
      amountMinor: input.amountMinor,
      beforeOutstandingMinor: current.outstandingMinor,
      afterOutstandingMinor: nextOutstanding,
      effectiveDate: input.effectiveDate,
      note: input.note,
      createdAt: serverTimestamp(),
      createdBy: getCurrentActorUid(),
    })
    transaction.update(openingRef, {
      adjustedAmountMinor: nextAdjustedAmount,
      outstandingMinor: nextOutstanding,
      lastTransactionType: 'adjustment',
      lastTransactionId: adjustmentRef.id,
      lastTransactionAmountMinor: input.amountMinor,
      updatedAt: serverTimestamp(),
      updatedBy: getCurrentActorUid(),
    })
  })
  return `OBA-${adjustmentRef.id}`
}
