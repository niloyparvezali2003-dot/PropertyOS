import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { flushSync } from 'react-dom'
import {
  Banknote,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  ClipboardList,
  CreditCard,
  LoaderCircle,
  Printer,
  ReceiptText,
  RefreshCw,
  Wallet,
} from 'lucide-react'

import {
  listElectricityBills,
  resolveElectricityBillTenantAssignment,
  type ElectricityBillRecord,
} from '../services/firebase/electricity'
import {
  applyTenantCreditToOpeningBalance,
  applyTenantCredit,
  createPayment,
  getPaymentErrorMessage,
  listCreditApplications,
  listPaymentBillBalances,
  listPayments,
  listTenantCredits,
  type CreditApplicationRecord,
  type PaymentBillBalanceRecord,
  type PaymentRecord,
  type TenantCreditRecord,
} from '../services/firebase/payments'
import { listOpeningBalances, type OpeningBalanceRecord } from '../services/firebase/openingBalances'
import { listRentBills, type RentBillRecord } from '../services/firebase/rentBills'
import { listTenantAssignments, type TenantAssignmentRecord } from '../services/firebase/tenantAssignments'
import { recordAuditEvent } from '../services/firebase/audit'
import { listTenants, type TenantRecord } from '../services/firebase/tenants'
import { listProperties, type PropertyRecord } from '../services/firebase/properties'
import { compareTenantNames } from '../utils/tenantNameSort'
import { DEFAULT_WORKSPACE_SETTINGS, loadWorkspaceSettings, type WorkspaceSettings } from '../services/firebase/workspaceSettings'
import type { PaymentAllocationFormValues, PaymentBillType, PaymentMethod } from '../schemas/payment'
import './payments.css'

type PaymentsPageProps = { ownerUid: string }

type PayableBill = Omit<PaymentAllocationFormValues, 'amountMinor'> & {
  key: string
  paidAmountMinor: number
  outstandingMinor: number
}

type PaymentFormState = {
  paidOn: string
  method: PaymentMethod
  reference: string
  notes: string
  amountReceived: string
}

function newAttemptId(): string {
  return crypto.randomUUID().replace(/-/g, '').toLowerCase()
}

function getToday(): string {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function emptyPaymentForm(): PaymentFormState {
  return { paidOn: getToday(), method: 'cash', reference: '', notes: '', amountReceived: '' }
}

function parseTakaToPoisha(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [wholePart, fractionalPart = ''] = normalized.split('.')
  const whole = Number(wholePart)
  const fractional = Number((fractionalPart + '00').slice(0, 2))
  const amount = whole * 100 + fractional
  return Number.isSafeInteger(amount) ? amount : null
}

function parseTakaAllowZero(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [wholePart, fractionalPart = ''] = normalized.split('.')
  const amount = Number(wholePart) * 100 + Number((fractionalPart + '00').slice(0, 2))
  return Number.isSafeInteger(amount) ? amount : null
}

function formatTaka(amountMinor: number): string {
  return `\u09F3${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`
}

const SMALL_NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
]
const TENS_NUMBER_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function integerToWords(value: number): string {
  if (value < 20) return SMALL_NUMBER_WORDS[value]
  if (value < 100) {
    const remainder = value % 10
    return `${TENS_NUMBER_WORDS[Math.floor(value / 10)]}${remainder ? `-${SMALL_NUMBER_WORDS[remainder]}` : ''}`
  }
  const scales: Array<[number, string]> = [
    [10_000_000, 'crore'], [100_000, 'lakh'], [1_000, 'thousand'], [100, 'hundred'],
  ]
  for (const [scale, label] of scales) {
    if (value >= scale) {
      const quotient = Math.floor(value / scale)
      const remainder = value % scale
      return `${integerToWords(quotient)} ${label}${remainder ? ` ${integerToWords(remainder)}` : ''}`
    }
  }
  return SMALL_NUMBER_WORDS[0]
}

function amountInWords(amountMinor: number): string {
  const safeAmount = Math.max(0, Math.trunc(amountMinor))
  const taka = Math.floor(safeAmount / 100)
  const poisha = safeAmount % 100
  const takaWords = `${integerToWords(taka)} taka`
  return poisha > 0
    ? `${takaWords} and ${integerToWords(poisha)} poisha only`
    : `${takaWords} only`
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-BD', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

function formatMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-BD', { month: 'long', year: 'numeric' }).format(date)
}

function billTypeLabel(value: PaymentBillType): string {
  return value === 'rent' ? 'Rent' : 'Electricity'
}

function methodLabel(value: PaymentMethod): string {
  const labels: Record<PaymentMethod, string> = {
    cash: 'Cash',
    bank_transfer: 'Bank transfer',
    mobile_banking: 'Mobile banking',
    cheque: 'Cheque',
    other: 'Other',
  }
  return labels[value]
}

function paymentReferenceLabel(payment: Pick<PaymentRecord, 'transactionId' | 'receiptNumber'>): string {
  return payment.transactionId ? `TRX ID: ${payment.transactionId}` : `Legacy receipt ID: ${payment.receiptNumber}`
}

const LEGACY_REFERENCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz'
const LEGACY_REFERENCE_SPACE = 62n ** 7n

/** Stable short alias for immutable advance applications created before AP references existed. */
function legacyAdvanceReferenceSuffix(documentId: string): string {
  let hash = 14695981039346656037n
  for (let index = 0; index < documentId.length; index += 1) {
    hash ^= BigInt(documentId.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  let value = hash % LEGACY_REFERENCE_SPACE
  let suffix = ''
  for (let index = 0; index < 7; index += 1) {
    suffix = LEGACY_REFERENCE_ALPHABET[Number(value % 62n)] + suffix
    value /= 62n
  }
  return suffix
}

function advanceApplicationReferenceLabel(applicationNumber: string, documentId: string): string {
  if (/^AP-[A-Za-z0-9]{7}$/.test(applicationNumber)) return applicationNumber
  if (applicationNumber.startsWith('ADV-')) return `AP-${legacyAdvanceReferenceSuffix(documentId)}`
  return applicationNumber
}

function makePayableBills(
  rentBills: RentBillRecord[],
  electricityBills: ElectricityBillRecord[],
  assignments: TenantAssignmentRecord[],
  balances: PaymentBillBalanceRecord[],
): { bills: PayableBill[]; unmatchedElectricity: number; unmatchedRent: number; invalidBalances: number } {
  const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]))
  const balanceByKey = new Map(balances.map((balance) => [balance.id, balance]))
  const bills: PayableBill[] = []
  let unmatchedElectricity = 0
  let unmatchedRent = 0
  let invalidBalances = 0

  const addBill = (allocation: Omit<PaymentAllocationFormValues, 'amountMinor'>, amountMinor: number) => {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return
    const key = `${allocation.billType}__${allocation.billId}`
    const balance = balanceByKey.get(key)
    if (balance && (
      balance.originalAmountMinor !== amountMinor ||
      balance.tenantAssignmentId !== allocation.tenantAssignmentId ||
      balance.tenantId !== allocation.tenantId ||
      balance.roomId !== allocation.roomId ||
      balance.billType !== allocation.billType ||
      balance.billId !== allocation.billId
    )) {
      invalidBalances += 1
      return
    }
    const paidAmountMinor = balance?.paidAmountMinor ?? 0
    const outstandingMinor = balance?.outstandingMinor ?? amountMinor
    if (!Number.isSafeInteger(outstandingMinor) || outstandingMinor < 0 || paidAmountMinor + outstandingMinor !== amountMinor) {
      invalidBalances += 1
      return
    }
    if (outstandingMinor <= 0) return
    bills.push({ ...allocation, key, billAmountMinor: amountMinor, paidAmountMinor, outstandingMinor })
  }

  for (const bill of rentBills) {
    const assignment = assignmentById.get(bill.assignmentId)
    if (!assignment || assignment.tenantId !== bill.tenantId || assignment.roomId !== bill.roomId ||
      assignment.moveInDate > bill.occupancyStartDate ||
      (assignment.moveOutDate !== null && assignment.moveOutDate < bill.occupancyEndDate)) {
      unmatchedRent += 1
      continue
    }
    addBill({
      billType: 'rent',
      billId: bill.id,
      billingMonth: bill.billingMonth,
      referenceDate: bill.occupancyEndDate,
      billAmountMinor: bill.totalMinor,
      tenantAssignmentId: bill.assignmentId,
      tenantId: bill.tenantId,
      tenantCode: bill.tenantCode,
      tenantName: bill.tenantName,
      roomId: bill.roomId,
      roomCode: bill.roomCode,
      roomNumber: bill.roomNumber,
      floorName: bill.floorName,
      propertyId: bill.propertyId,
      propertyCode: bill.propertyCode,
    }, bill.totalMinor)
  }

  for (const bill of electricityBills) {
    const assignment = resolveElectricityBillTenantAssignment(bill, assignments)
    if (!assignment) {
      unmatchedElectricity += 1
      continue
    }
    addBill({
      billType: 'electricity',
      billId: bill.id,
      billingMonth: bill.billingMonth,
      referenceDate: bill.readingDate,
      billAmountMinor: bill.amountMinor,
      tenantAssignmentId: assignment.id,
      tenantId: assignment.tenantId,
      tenantCode: assignment.tenantCode,
      tenantName: assignment.tenantName,
      roomId: bill.roomId,
      roomCode: bill.roomCode,
      roomNumber: assignment.roomNumber,
      floorName: assignment.floorName,
      propertyId: bill.propertyId,
      propertyCode: bill.propertyCode,
    }, bill.amountMinor)
  }

  bills.sort((left, right) => right.billingMonth.localeCompare(left.billingMonth) ||
    left.tenantName.localeCompare(right.tenantName) || left.roomCode.localeCompare(right.roomCode))
  return { bills, unmatchedElectricity, unmatchedRent, invalidBalances }
}

function allocationFor(bill: PayableBill, amountMinor: number): PaymentAllocationFormValues {
  return {
    billType: bill.billType,
    billId: bill.billId,
    billingMonth: bill.billingMonth,
    referenceDate: bill.referenceDate,
    amountMinor,
    billAmountMinor: bill.billAmountMinor,
    tenantAssignmentId: bill.tenantAssignmentId,
    tenantId: bill.tenantId,
    tenantCode: bill.tenantCode,
    tenantName: bill.tenantName,
    roomId: bill.roomId,
    roomCode: bill.roomCode,
    roomNumber: bill.roomNumber,
    floorName: bill.floorName,
    propertyId: bill.propertyId,
    propertyCode: bill.propertyCode,
  }
}

export function PaymentsPage({ ownerUid }: PaymentsPageProps) {
  const [rentBills, setRentBills] = useState<RentBillRecord[]>([])
  const [electricityBills, setElectricityBills] = useState<ElectricityBillRecord[]>([])
  const [assignments, setAssignments] = useState<TenantAssignmentRecord[]>([])
  const [tenants, setTenants] = useState<TenantRecord[]>([])
  const [properties, setProperties] = useState<PropertyRecord[]>([])
  const [payments, setPayments] = useState<PaymentRecord[]>([])
  const [balances, setBalances] = useState<PaymentBillBalanceRecord[]>([])
  const [openingBalances, setOpeningBalances] = useState<OpeningBalanceRecord[]>([])
  const [credits, setCredits] = useState<TenantCreditRecord[]>([])
  const [creditApplications, setCreditApplications] = useState<CreditApplicationRecord[]>([])
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>({ ...DEFAULT_WORKSPACE_SETTINGS })
  const [isLoading, setIsLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [pageSuccess, setPageSuccess] = useState('')
  const [formError, setFormError] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [applyingCreditKey, setApplyingCreditKey] = useState<string | null>(null)
  const [selectedTenantId, setSelectedTenantId] = useState('')
  const [allocationAmounts, setAllocationAmounts] = useState<Record<string, string>>({})
  const [form, setForm] = useState<PaymentFormState>(emptyPaymentForm)
  const [printPaymentId, setPrintPaymentId] = useState<string | null>(null)
  const [showAllRecentPayments, setShowAllRecentPayments] = useState(false)
  const [showAllAdvanceApplications, setShowAllAdvanceApplications] = useState(false)
  const [paymentAttemptId, setPaymentAttemptId] = useState(newAttemptId)
  const creditAttemptIds = useRef(new Map<string, string>())

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setPageError('')
    try {
      const [nextRentBills, nextElectricityBills, nextAssignments, nextTenants, nextPayments, nextBalances, nextCredits, nextApplications, nextOpeningBalances, nextProperties, settingsResult] = await Promise.all([
        listRentBills(ownerUid),
        listElectricityBills(ownerUid),
        listTenantAssignments(ownerUid),
        listTenants(ownerUid),
        listPayments(ownerUid),
        listPaymentBillBalances(ownerUid),
        listTenantCredits(ownerUid),
        listCreditApplications(ownerUid),
        listOpeningBalances(ownerUid),
        listProperties(ownerUid),
        loadWorkspaceSettings(ownerUid),
      ])
      setRentBills(nextRentBills)
      setElectricityBills(nextElectricityBills)
      setAssignments(nextAssignments)
      setTenants(nextTenants)
      setProperties(nextProperties)
      setPayments(nextPayments)
      setBalances(nextBalances)
      setOpeningBalances(nextOpeningBalances)
      setCredits(nextCredits)
      setCreditApplications(nextApplications)
      setWorkspaceSettings(settingsResult.settings)
    } catch (error: unknown) {
      setPageError(getPaymentErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => { void loadData() }, [loadData])

  const recentPayments = useMemo(() => [...payments].sort((left, right) => {
    // Recent means when the receipt was recorded, not a possibly backdated paidOn date.
    const createdAtDifference = (right.createdAt?.toMillis() ?? 0) - (left.createdAt?.toMillis() ?? 0)
    if (createdAtDifference !== 0) return createdAtDifference
    const paidOnDifference = right.paidOn.localeCompare(left.paidOn)
    return paidOnDifference || right.id.localeCompare(left.id)
  }), [payments])
  const visibleRecentPayments = showAllRecentPayments ? recentPayments : recentPayments.slice(0, 5)
  const recentAdvanceApplications = useMemo(() => [...creditApplications].sort((left, right) => {
    // Use the actual application creation timestamp, not the bill month or allocation date.
    const createdAtDifference = (right.createdAt?.toMillis() ?? 0) - (left.createdAt?.toMillis() ?? 0)
    return createdAtDifference || right.id.localeCompare(left.id)
  }), [creditApplications])
  const visibleAdvanceApplications = showAllAdvanceApplications
    ? recentAdvanceApplications
    : recentAdvanceApplications.slice(0, 5)

  const payableState = useMemo(() => makePayableBills(rentBills, electricityBills, assignments, balances), [rentBills, electricityBills, assignments, balances])
  const openBills = payableState.bills
  const tenantsById = useMemo(() => new Map(tenants.map((tenant) => [tenant.id, tenant])), [tenants])
  const propertyById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties])
  const tenantOptions = useMemo(() => {
    const assignmentsByTenantId = new Map<string, TenantAssignmentRecord[]>()
    const currentAssignmentsByTenantId = new Map<string, TenantAssignmentRecord[]>()

    for (const assignment of assignments) {
      const tenantRecords = assignmentsByTenantId.get(assignment.tenantId) ?? []
      tenantRecords.push(assignment)
      assignmentsByTenantId.set(assignment.tenantId, tenantRecords)

      if (assignment.status === 'current' && assignment.moveOutDate === null) {
        const current = currentAssignmentsByTenantId.get(assignment.tenantId) ?? []
        current.push(assignment)
        currentAssignmentsByTenantId.set(assignment.tenantId, current)
      }
    }

    return tenants
      .map((tenant) => {
        const tenantAssignments = assignmentsByTenantId.get(tenant.id) ?? []
        const currentAssignments = currentAssignmentsByTenantId.get(tenant.id) ?? []
        // Prefer every current room. If the tenant has moved out but still has
        // an unpaid bill, show the latest historical room instead of hiding
        // the useful room/property context from the payment selector.
        const displayAssignments = currentAssignments.length > 0
          ? currentAssignments
          : [...tenantAssignments].sort((left, right) =>
              (right.moveOutDate ?? right.moveInDate).localeCompare(left.moveOutDate ?? left.moveInDate),
            ).slice(0, 1)
        const locations = displayAssignments
          .map((assignment) => {
            const propertyName = propertyById.get(assignment.propertyId)?.name || assignment.propertyCode
            return `Room ${assignment.roomNumber} - ${propertyName}`
          })
          .filter((location, index, all) => all.indexOf(location) === index)

        return {
          id: tenant.id,
          name: tenant.fullName,
          label: locations.length > 0
            ? `${tenant.fullName} - ${locations.join(' / ')}`
            : `${tenant.fullName} - No room assignment`,
        }
      })
      .sort((left, right) => compareTenantNames(left.name, right.name))
  }, [tenants, assignments, propertyById])
  const creditByTenantId = useMemo(() => new Map(credits.map((credit) => [credit.tenantId, credit])), [credits])
  const selectedTenant = tenantsById.get(selectedTenantId) ?? null
  const selectedTenantCredit = selectedTenantId ? creditByTenantId.get(selectedTenantId)?.creditMinor ?? 0 : 0
  const selectedTenantBills = useMemo(() => openBills.filter((bill) => bill.tenantId === selectedTenantId), [openBills, selectedTenantId])
  const selectedOpeningBalance = openingBalances.find((balance) => balance.tenantId === selectedTenantId) ?? null
  const selectedTenantBillOutstandingMinor = selectedTenantBills.reduce((total, bill) => total + bill.outstandingMinor, 0)
  const selectedTenantOutstandingMinor = selectedTenantBillOutstandingMinor + (selectedOpeningBalance?.outstandingMinor ?? 0)

  const selectedAllocations = useMemo(() => {
    const result: PaymentAllocationFormValues[] = []
    for (const bill of selectedTenantBills) {
      const raw = allocationAmounts[bill.key] ?? ''
      if (!raw.trim()) continue
      const amountMinor = parseTakaToPoisha(raw)
      if (amountMinor === null || amountMinor <= 0) continue
      result.push(allocationFor(bill, amountMinor))
    }
    return result
  }, [selectedTenantBills, allocationAmounts])

  const totalAllocatedMinor = selectedAllocations.reduce((total, allocation) => total + allocation.amountMinor, 0)
  const amountReceivedMinor = form.amountReceived.trim() ? parseTakaToPoisha(form.amountReceived) : null
  const openingAllocationText = allocationAmounts.opening_balance ?? ''
  const openingBalanceAllocationMinor = selectedOpeningBalance?.outstandingMinor
    ? openingAllocationText.trim()
      ? parseTakaAllowZero(openingAllocationText) ?? -1
      : amountReceivedMinor === null
        ? 0
        : Math.min(selectedOpeningBalance.outstandingMinor, Math.max(0, amountReceivedMinor - totalAllocatedMinor))
    : 0
  const totalAllocatedIncludingOpeningMinor = totalAllocatedMinor + Math.max(0, openingBalanceAllocationMinor)
  const hasInvalidReceived = !form.amountReceived.trim() || amountReceivedMinor === null || amountReceivedMinor <= 0
  const hasInvalidAllocation = selectedTenantBills.some((bill) => {
    const raw = allocationAmounts[bill.key] ?? ''
    return raw.trim().length > 0 && parseTakaToPoisha(raw) === null
  })
  const overAllocated = selectedAllocations.some((allocation) => {
    const bill = selectedTenantBills.find((item) => item.billType === allocation.billType && item.billId === allocation.billId)
    return !bill || allocation.amountMinor > bill.outstandingMinor
  })
  const receivedBelowAllocated = amountReceivedMinor !== null && totalAllocatedIncludingOpeningMinor > amountReceivedMinor
  const invalidOpeningAllocation = openingAllocationText.trim().length > 0 && parseTakaAllowZero(openingAllocationText) === null
  const overOpeningAllocation = openingBalanceAllocationMinor < 0 || openingBalanceAllocationMinor > (selectedOpeningBalance?.outstandingMinor ?? 0)
  const advanceFromThisPayment = amountReceivedMinor !== null && amountReceivedMinor >= totalAllocatedIncludingOpeningMinor && amountReceivedMinor > 0
    ? amountReceivedMinor - totalAllocatedIncludingOpeningMinor
    : 0
  const totalOutstandingMinor = openBills.reduce((total, bill) => total + bill.outstandingMinor, 0) + openingBalances.reduce((total, balance) => total + balance.outstandingMinor, 0)
  const totalCreditMinor = credits.reduce((total, credit) => total + credit.creditMinor, 0)

  const updateForm = <K extends keyof PaymentFormState>(key: K, value: PaymentFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleTenantChange = (tenantId: string) => {
    setSelectedTenantId(tenantId)
    setAllocationAmounts({})
    setFormError('')
    setPageSuccess('')
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')
    setPageSuccess('')
    if (!selectedTenant) {
      setFormError('Select a tenant before recording a payment.')
      return
    }
    if (hasInvalidReceived || amountReceivedMinor === null) {
      setFormError('Enter the actual amount received, with up to two decimal places.')
      return
    }
    if (hasInvalidAllocation) {
      setFormError('Enter each allocation as a valid amount with up to two decimal places.')
      return
    }
    if (overAllocated) {
      setFormError('An allocation exceeds the bill’s current outstanding balance.')
      return
    }
    if (invalidOpeningAllocation || overOpeningAllocation) {
      setFormError('The opening balance allocation is invalid or exceeds its current outstanding amount.')
      return
    }
    if (receivedBelowAllocated) {
      setFormError('The actual amount received cannot be less than the total allocations.')
      return
    }

    setIsSaving(true)
    try {
      const paymentResult = await createPayment(ownerUid, {
        tenantId: selectedTenant.id,
        tenantCode: selectedTenant.tenantCode,
        tenantName: selectedTenant.fullName,
        paidOn: form.paidOn,
        method: form.method,
        reference: form.reference.trim(),
        notes: form.notes.trim(),
        amountReceivedMinor,
        outstandingBeforeMinor: selectedTenantOutstandingMinor,
        openingBalanceAllocationMinor,
        allocations: selectedAllocations,
      }, paymentAttemptId)
      await recordAuditEvent(ownerUid, {
        action: 'payment_recorded',
        entityType: 'payment',
        entityId: paymentResult.receiptNumber,
        entityLabel: `${paymentResult.transactionId ? `TRX ID: ${paymentResult.transactionId}` : `Legacy receipt ID: ${paymentResult.receiptNumber}`} · ${selectedTenant.fullName}`,
        summary: `Recorded a payment of ${formatTaka(amountReceivedMinor)} for ${selectedTenant.fullName}.`,
        dedupeKey: `payment_${paymentResult.receiptNumber}`,
      })
      const transactionLabel = paymentResult.transactionId ? `TRX ID: ${paymentResult.transactionId}` : `Legacy receipt ID: ${paymentResult.receiptNumber}`
      setPageSuccess(`Payment recorded successfully. ${transactionLabel}${advanceFromThisPayment > 0 ? ` · ${formatTaka(advanceFromThisPayment)} added to advance credit.` : ''}`)
      setAllocationAmounts({})
      setPaymentAttemptId(newAttemptId())
      setForm((current) => ({ ...current, reference: '', notes: '', amountReceived: '' }))
      await loadData()
    } catch (error: unknown) {
      setFormError(getPaymentErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  const applyAdvance = async (bill: PayableBill) => {
    setPageError('')
    setPageSuccess('')
    const credit = creditByTenantId.get(bill.tenantId)
    if (!credit || credit.creditMinor <= 0) {
      setPageError('This tenant has no available advance credit.')
      return
    }
    const rawRequested = allocationAmounts[bill.key] ?? ''
    let amountMinor: number
    if (rawRequested.trim()) {
      const parsed = parseTakaToPoisha(rawRequested)
      if (parsed === null || parsed <= 0) {
        setPageError('Enter a valid positive allocation amount before applying advance credit.')
        return
      }
      amountMinor = parsed
    } else {
      amountMinor = Math.min(credit.creditMinor, bill.outstandingMinor)
    }
    if (amountMinor > credit.creditMinor) {
      setPageError(`The allocation exceeds available advance credit of ${formatTaka(credit.creditMinor)}.`)
      return
    }
    if (amountMinor > bill.outstandingMinor) {
      setPageError(`The allocation exceeds this bill’s outstanding balance of ${formatTaka(bill.outstandingMinor)}.`)
      return
    }
    const attemptKey = `${bill.key}:${amountMinor}`
    let idempotencyKey = creditAttemptIds.current.get(attemptKey)
    if (!idempotencyKey) {
      idempotencyKey = newAttemptId()
      creditAttemptIds.current.set(attemptKey, idempotencyKey)
    }

    setApplyingCreditKey(bill.key)
    try {
      const applicationNumber = await applyTenantCredit(ownerUid, allocationFor(bill, amountMinor), idempotencyKey)
      await recordAuditEvent(ownerUid, {
        action: 'credit_applied',
        entityType: 'credit_application',
        entityId: applicationNumber,
        entityLabel: `${applicationNumber} · ${bill.tenantName}`,
        summary: `Applied ${formatTaka(amountMinor)} of advance credit for ${bill.tenantName} to a ${bill.billType} bill (${bill.billId}).`,
        dedupeKey: `credit_${applicationNumber}`,
      })
      creditAttemptIds.current.delete(attemptKey)
      setPageSuccess(`Advance applied successfully. Reference: ${applicationNumber}`)
      setAllocationAmounts((current) => ({ ...current, [bill.key]: '' }))
      await loadData()
    } catch (error: unknown) {
      setPageError(getPaymentErrorMessage(error))
    } finally {
      setApplyingCreditKey(null)
    }
  }

  const applyOpeningBalanceAdvance = async () => {
    if (!selectedTenant || !selectedOpeningBalance || selectedOpeningBalance.outstandingMinor <= 0) return
    const credit = creditByTenantId.get(selectedTenant.id)
    if (!credit || credit.creditMinor <= 0) {
      setPageError('This tenant has no available advance credit.')
      return
    }
    const amountMinor = Math.min(credit.creditMinor, selectedOpeningBalance.outstandingMinor)
    const attemptKey = `opening_balance:${selectedTenant.id}:${amountMinor}`
    let idempotencyKey = creditAttemptIds.current.get(attemptKey)
    if (!idempotencyKey) {
      idempotencyKey = newAttemptId()
      creditAttemptIds.current.set(attemptKey, idempotencyKey)
    }
    setPageError('')
    setPageSuccess('')
    setApplyingCreditKey('opening_balance')
    try {
      const applicationNumber = await applyTenantCreditToOpeningBalance(
        ownerUid,
        selectedTenant.id,
        selectedTenant.tenantCode,
        selectedTenant.fullName,
        amountMinor,
        idempotencyKey,
      )
      await recordAuditEvent(ownerUid, {
        action: 'credit_applied',
        entityType: 'credit_application',
        entityId: applicationNumber,
        entityLabel: `${applicationNumber} · ${selectedTenant.fullName}`,
        summary: `Applied ${formatTaka(amountMinor)} of advance credit to the opening balance for ${selectedTenant.fullName}.`,
        dedupeKey: `credit_${applicationNumber}`,
      })
      creditAttemptIds.current.delete(attemptKey)
      setPageSuccess(`Advance applied to opening balance. Reference: ${applicationNumber}`)
      setAllocationAmounts((current) => ({ ...current, opening_balance: '' }))
      await loadData()
    } catch (error: unknown) {
      setPageError(getPaymentErrorMessage(error))
    } finally {
      setApplyingCreditKey(null)
    }
  }

  const printReceipt = (payment: PaymentRecord) => {
    // Flush the selected receipt into the DOM synchronously, then call print
    // directly inside the button's click event. The previous setTimeout path
    // could lose mobile Safari/Chrome's transient user activation, so the
    // browser silently ignored window.print() on phones.
    flushSync(() => {
      setPrintPaymentId(payment.id)
    })
    window.print()
  }

  return (
    <div className="payments-page">
      <header className="payments-header">
        <div>
          <p className="eyebrow">Finance</p>
          <h1>Payments</h1>
          <p className="page-description">Record tenant payments, allocate money to issued bills, track advance credit, and preserve printable receipts and transaction history.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void loadData()} disabled={isLoading || isSaving || applyingCreditKey !== null}>
          {isLoading ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </header>

      {pageError && <div className="payment-error" role="alert">{pageError}</div>}
      {pageSuccess && <div className="payment-success" role="status"><CheckCircle2 size={17} /> {pageSuccess}</div>}

      <section className="payments-summary-grid" aria-label="Payment summary">
        <div className="payments-summary-card"><div className="payments-summary-label"><CircleDollarSign size={16} /> Total outstanding</div><strong className="payments-summary-value">{formatTaka(totalOutstandingMinor)}</strong></div>
        <div className="payments-summary-card"><div className="payments-summary-label"><ClipboardList size={16} /> Open bills</div><strong className="payments-summary-value">{openBills.length}</strong></div>
        <div className="payments-summary-card"><div className="payments-summary-label"><Wallet size={16} /> Available advances</div><strong className="payments-summary-value">{formatTaka(totalCreditMinor)}</strong></div>
        <div className="payments-summary-card"><div className="payments-summary-label"><ReceiptText size={16} /> Recorded receipts</div><strong className="payments-summary-value">{payments.length}</strong></div>
      </section>

      {(payableState.unmatchedElectricity > 0 || payableState.unmatchedRent > 0 || payableState.invalidBalances > 0) && (
        <div className="payment-notice" role="status">Some records need review before they can be paid. Unmatched electricity bills: {payableState.unmatchedElectricity}; unmatched rent bills: {payableState.unmatchedRent}; inconsistent bill balances: {payableState.invalidBalances}. No payment was changed for these records.</div>
      )}

      <div className="payments-content-grid">
        <form className="payments-panel" onSubmit={handleSubmit}>
          <div className="payments-section-heading"><div><h2>Record a payment</h2><p className="payments-section-subtitle">Enter the money actually received. Allocate some or all of it to bills; any remainder is saved as tenant advance credit.</p></div><Wallet size={21} aria-hidden="true" /></div>

          <div className="payments-form-grid">
            <label className="property-form-field payment-field-full"><span>Tenant <span>*</span></span>
              <select value={selectedTenantId} onChange={(event) => handleTenantChange(event.target.value)} required>
                <option value="">Select tenant</option>
                {tenantOptions.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.label}</option>)}
              </select>
            </label>
            <label className="property-form-field"><span>Amount actually received (BDT) <span>*</span></span>
              <input type="number" min="0.01" step="0.01" inputMode="decimal" value={form.amountReceived} onChange={(event) => updateForm('amountReceived', event.target.value)} placeholder="0.00" required />
            </label>
            <label className="property-form-field"><span>Payment date <span>*</span></span>
              <input type="date" value={form.paidOn} max={getToday()} onChange={(event) => updateForm('paidOn', event.target.value)} required />
            </label>
            <label className="property-form-field"><span>Payment method <span>*</span></span>
              <select value={form.method} onChange={(event) => updateForm('method', event.target.value as PaymentMethod)} required>
                <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="mobile_banking">Mobile banking (bKash/Nagad)</option><option value="cheque">Cheque</option><option value="other">Other</option>
              </select>
            </label>
            <label className="property-form-field"><span>Reference / transaction ID</span><input value={form.reference} maxLength={120} onChange={(event) => updateForm('reference', event.target.value)} placeholder="Optional transaction reference" /></label>
            <label className="property-form-field payment-field-full"><span>Notes</span><textarea value={form.notes} maxLength={1000} onChange={(event) => updateForm('notes', event.target.value)} placeholder="Optional payment note" /></label>
          </div>

          {selectedTenantId && (
            <div className="payment-credit-panel">
              <div><span>Available advance credit</span><strong>{formatTaka(selectedTenantCredit)}</strong></div>
              <p>Advance credit is money already received and not yet allocated to a bill. Applying it to a bill does not create a second cash receipt.</p>
            </div>
          )}

          <div className="payments-section-heading" style={{ marginTop: 22, marginBottom: 0 }}><div><h2>Outstanding balances</h2><p className="payments-section-subtitle">Allocate new receipts to issued bills and any previous due already recorded for this tenant.</p></div></div>

          {!selectedTenantId ? <div className="payment-empty-state">Select a tenant to view their outstanding opening balance, rent, and electricity bills.</div> : (
            <div className="payment-bill-list">
              {selectedOpeningBalance && selectedOpeningBalance.outstandingMinor > 0 && (
                <article className="payment-bill-row payment-opening-balance-row" key={`opening-${selectedOpeningBalance.id}`}>
                  <div className="payment-bill-topline"><div><p className="payment-bill-title">Previous due · Opening balance</p><div className="payment-bill-meta">Tenant-level opening amount · Effective {formatDate(selectedOpeningBalance.effectiveDate)}</div></div><strong>{formatTaka(selectedOpeningBalance.outstandingMinor)} due</strong></div>
                  <div className="payment-bill-amounts"><div><span>Original due</span><strong>{formatTaka(selectedOpeningBalance.originalAmountMinor)}</strong></div><div><span>Already paid / applied</span><strong>{formatTaka(selectedOpeningBalance.paidAmountMinor)}</strong></div><div><span>Remaining</span><strong>{formatTaka(selectedOpeningBalance.outstandingMinor)}</strong></div></div>
                  <div className="payment-allocation-input"><label>Amount to allocate (BDT)
                    <input type="number" min="0" max={(selectedOpeningBalance.outstandingMinor / 100).toFixed(2)} step="0.01" inputMode="decimal" value={openingAllocationText} onChange={(event) => setAllocationAmounts((current) => ({ ...current, opening_balance: event.target.value }))} placeholder={amountReceivedMinor === null ? 'Auto from received amount' : `Auto: ${formatTaka(openingBalanceAllocationMinor)}`} />
                  </label><button className="payment-small-button" type="button" onClick={() => setAllocationAmounts((current) => ({ ...current, opening_balance: (selectedOpeningBalance.outstandingMinor / 100).toFixed(2) }))}>Full balance</button></div>
                  <p className="payment-opening-auto-note">Leave this field empty to automatically apply the unallocated part of the received amount to the previous due. Enter 0 to keep it as advance credit instead.</p>
                  <div className="payment-bill-actions"><button className="payment-small-button payment-advance-button" type="button" disabled={selectedTenantCredit <= 0 || applyingCreditKey !== null || isSaving || isLoading} onClick={() => void applyOpeningBalanceAdvance()}>{applyingCreditKey === 'opening_balance' ? <LoaderCircle size={14} className="animate-spin" /> : <CreditCard size={14} />} Apply advance ({formatTaka(selectedTenantCredit)})</button></div>
                </article>
              )}
              {selectedOpeningBalance && selectedOpeningBalance.outstandingMinor === 0 && <div className="payment-opening-settled"><CheckCircle2 size={16} /> Previous opening due has been fully settled.</div>}
              {selectedTenantBills.map((bill) => {
                const billCredit = creditByTenantId.get(bill.tenantId)?.creditMinor ?? 0
                return (
                  <article className="payment-bill-row" key={bill.key}>
                    <div className="payment-bill-topline"><div><p className="payment-bill-title">{billTypeLabel(bill.billType)} · {formatMonth(bill.billingMonth)}</p><div className="payment-bill-meta">{bill.roomCode} · Room {bill.roomNumber} · {bill.propertyCode} · {bill.floorName}</div></div><strong>{formatTaka(bill.outstandingMinor)} due</strong></div>
                    <div className="payment-bill-amounts"><div><span>Original bill</span><strong>{formatTaka(bill.billAmountMinor)}</strong></div><div><span>Already paid</span><strong>{formatTaka(bill.paidAmountMinor)}</strong></div><div><span>Remaining</span><strong>{formatTaka(bill.outstandingMinor)}</strong></div></div>
                    <div className="payment-allocation-input"><label>Amount to allocate (BDT)
                      <input type="number" min="0" max={(bill.outstandingMinor / 100).toFixed(2)} step="0.01" inputMode="decimal" value={allocationAmounts[bill.key] ?? ''} onChange={(event) => setAllocationAmounts((current) => ({ ...current, [bill.key]: event.target.value }))} placeholder="0.00" />
                    </label><button className="payment-small-button" type="button" onClick={() => setAllocationAmounts((current) => ({ ...current, [bill.key]: (bill.outstandingMinor / 100).toFixed(2) }))}>Full balance</button></div>
                    <div className="payment-bill-actions"><button className="payment-small-button payment-advance-button" type="button" disabled={billCredit <= 0 || applyingCreditKey !== null || isSaving || isLoading} onClick={() => void applyAdvance(bill)}>{applyingCreditKey === bill.key ? <LoaderCircle size={14} className="animate-spin" /> : <CreditCard size={14} />} Apply advance ({formatTaka(billCredit)})</button></div>
                  </article>
                )
              })}
              {selectedTenantBills.length === 0 && (!selectedOpeningBalance || selectedOpeningBalance.outstandingMinor === 0) && <div className="payment-empty-state">No outstanding balances are available for this tenant. Any amount received can be kept as advance credit.</div>}
            </div>
          )}

          <div className="payment-total-row"><div><span>Total allocated to outstanding balances</span><div className="payments-section-subtitle">Includes new bill allocations and the opening balance amount.</div></div><strong>{formatTaka(totalAllocatedIncludingOpeningMinor)}</strong></div>
          <div className="payment-total-row payment-receipt-preview"><div><span>Receipt total · actual cash received</span><div className="payments-section-subtitle">The difference, if any, is added to advance credit.</div></div><strong>{amountReceivedMinor !== null && amountReceivedMinor > 0 ? formatTaka(amountReceivedMinor) : '—'}</strong></div>
          <div className="payment-credit-preview"><span>Advance added by this receipt</span><strong>{formatTaka(advanceFromThisPayment)}</strong></div>
          {form.amountReceived.trim() && hasInvalidReceived && <div className="payment-error" role="alert">Enter a valid received amount greater than zero, using no more than two decimal places.</div>}
          {hasInvalidAllocation && <div className="payment-error" role="alert">One or more bill allocation amounts are invalid. Use amounts with no more than two decimal places.</div>}
          {(invalidOpeningAllocation || overOpeningAllocation) && <div className="payment-error" role="alert">The opening balance allocation is invalid or exceeds its current remaining due.</div>}
          {overAllocated && <div className="payment-error" role="alert">One or more allocations exceed the current outstanding bill balance.</div>}
          {receivedBelowAllocated && <div className="payment-error" role="alert">Amount received is less than the total allocated to outstanding balances. Increase the received amount or lower the allocations.</div>}

          {formError && <div className="payment-error" role="alert" style={{ marginTop: 12 }}>{formError}</div>}
          <div className="payment-submit-row"><button className="button-primary" type="submit" disabled={isSaving || isLoading || !selectedTenantId || hasInvalidReceived || hasInvalidAllocation || overAllocated || invalidOpeningAllocation || overOpeningAllocation || receivedBelowAllocated || applyingCreditKey !== null}>{isSaving ? <LoaderCircle size={17} className="animate-spin" /> : <Banknote size={17} />}{isSaving ? 'Recording payment…' : 'Record payment & issue receipt'}</button></div>
          <p className="payments-section-subtitle" style={{ marginTop: 12 }}>Payment receipts, bill-balance changes, and advance-credit changes are written atomically. Issued bills are never edited, and applying advance credit does not count as a second payment.</p>
        </form>

        <section className="payments-history-panel">
          <div className="payments-section-heading"><div><h2>Recent payments</h2><p className="payments-section-subtitle">Posted receipts are preserved as immutable history.</p></div><ReceiptText size={21} aria-hidden="true" /></div>
          {isLoading ? <div className="payment-empty-state"><span className="payment-inline-spinner"><LoaderCircle size={17} className="animate-spin" /> Loading payment history…</span></div> : recentPayments.length === 0 ? <div className="payment-empty-state">No payments recorded yet. A receipt will appear here after the first payment.</div> : (
            <>
              <div className="payment-history-list" id="recent-payment-history-list">{visibleRecentPayments.map((payment) => (
                <article className="payment-history-row" key={payment.id}><div className="payment-history-main"><p className="payment-history-title payment-transaction-id">{paymentReferenceLabel(payment)}</p><div className="payment-history-meta">{payment.tenantCode} — {payment.tenantName}<br />{formatDate(payment.paidOn)} · {methodLabel(payment.method)}<br />{payment.allocations.length + (payment.openingBalanceAllocationMinor > 0 ? 1 : 0)} allocation{payment.allocations.length + (payment.openingBalanceAllocationMinor > 0 ? 1 : 0) === 1 ? '' : 's'}{payment.advanceAddedMinor > 0 ? ` · ${formatTaka(payment.advanceAddedMinor)} advance` : ''}</div><div className="payment-history-actions"><button type="button" onClick={() => printReceipt(payment)}><Printer size={14} /> Print receipt</button></div></div><strong className="payment-history-amount">{formatTaka(payment.amountMinor)}</strong></article>
              ))}</div>
              {recentPayments.length > 5 && (
                <button
                  className="payment-history-more-button"
                  type="button"
                  onClick={() => setShowAllRecentPayments((current) => !current)}
                  aria-expanded={showAllRecentPayments}
                  aria-controls="recent-payment-history-list"
                >
                  {showAllRecentPayments ? <><ChevronUp size={15} /> Show less</> : <><ChevronDown size={15} /> Show more ({recentPayments.length - 5} older)</>}
                </button>
              )}
            </>
          )}

          <div className="payments-section-heading payment-subsection-heading"><div><h2>Advance applications</h2><p className="payments-section-subtitle">Advance credit applied to bills, separate from cash receipts.</p></div><CreditCard size={20} aria-hidden="true" /></div>
          {isLoading ? <div className="payment-empty-state">Loading advance history…</div> : recentAdvanceApplications.length === 0 ? <div className="payment-empty-state">No advance credit has been applied yet.</div> : (
            <>
              <div className="payment-history-list" id="advance-application-history-list">{visibleAdvanceApplications.map((application) => (
                <article className="payment-history-row" key={application.id}><div className="payment-history-main"><p className="payment-history-title payment-transaction-id">{advanceApplicationReferenceLabel(application.applicationNumber, application.id)}</p><div className="payment-history-meta">{application.tenantCode} — {application.tenantName}<br />{billTypeLabel(application.allocation.billType)} · {formatMonth(application.allocation.billingMonth)} · {application.allocation.roomCode} / {application.allocation.roomNumber}</div></div><strong className="payment-history-amount">{formatTaka(application.amountMinor)}</strong></article>
              ))}</div>
              {recentAdvanceApplications.length > 5 && (
                <button
                  className="payment-history-more-button"
                  type="button"
                  onClick={() => setShowAllAdvanceApplications((current) => !current)}
                  aria-expanded={showAllAdvanceApplications}
                  aria-controls="advance-application-history-list"
                >
                  {showAllAdvanceApplications ? <><ChevronUp size={15} /> Show less</> : <><ChevronDown size={15} /> Show more ({recentAdvanceApplications.length - 5} older)</>}
                </button>
              )}
            </>
          )}
        </section>
      </div>

      {payments.map((payment) => (
        <section className="payment-print-receipt" data-active={printPaymentId === payment.id ? 'true' : 'false'} key={`print-${payment.id}`} aria-label={`Receipt ${paymentReferenceLabel(payment)}`}>
          <div className="payment-receipt-sheet">
            <header className="payment-receipt-header">
              <div className="payment-receipt-brand">
                <span className="payment-receipt-logo"><img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="T&N House's" /></span>
                <div>
                  <h1>{workspaceSettings.houseName}</h1>
                  <p>Official payment receipt</p>
                  {workspaceSettings.address && <small>{workspaceSettings.address}</small>}
                  {workspaceSettings.contractNumber && <small>Contract: {workspaceSettings.contractNumber}</small>}
                  {workspaceSettings.paymentContact && <small>Payment contact: {workspaceSettings.paymentContact}</small>}
                </div>
              </div>
              <div className="payment-receipt-meta payment-receipt-meta-right">
                <strong className="payment-receipt-transaction-id">{paymentReferenceLabel(payment)}</strong>
                <span>Payment date: {formatDate(payment.paidOn)}</span>
                <span>Method: {methodLabel(payment.method)}</span>
                {payment.reference && <span>Reference: {payment.reference}</span>}
              </div>
            </header>

            <div className="payment-receipt-tenant">
              <span>Received from</span>
              <strong>{payment.tenantName}</strong>
              <small>{payment.tenantCode}</small>
            </div>

            <div className="payment-receipt-section-title">Payment allocation details</div>
            <table className="payment-receipt-table">
              <thead><tr><th>Type</th><th>Billing month / date</th><th>Room</th><th>Allocated amount</th></tr></thead>
              <tbody>
                {payment.allocations.length === 0 && payment.openingBalanceAllocationMinor === 0
                  ? <tr><td colSpan={4}>No bills were allocated. The received amount is held as tenant advance credit.</td></tr>
                  : <>
                    {payment.openingBalanceAllocationMinor > 0 && <tr><td>Opening balance</td><td>Tenant-level previous due</td><td>—</td><td>{formatTaka(payment.openingBalanceAllocationMinor)}</td></tr>}
                    {payment.allocations.map((allocation) => (
                    <tr key={`${allocation.billType}-${allocation.billId}`}>
                      <td>{billTypeLabel(allocation.billType)}</td>
                      <td>{formatMonth(allocation.billingMonth)}<br /><small>{allocation.billType === 'electricity' ? 'Reading' : 'Bill reference'}: {formatDate(allocation.referenceDate)}</small></td>
                      <td>{allocation.roomCode} · {allocation.roomNumber}</td>
                      <td>{formatTaka(allocation.amountMinor)}</td>
                    </tr>
                    ))}
                  </>}
              </tbody>
            </table>

            <div className="payment-receipt-summary">
              <div><span>Outstanding due before payment</span><strong>{payment.outstandingBeforeMinor === null ? 'Not recorded on this older receipt' : formatTaka(payment.outstandingBeforeMinor)}</strong></div>
              <div><span>Amount applied to outstanding due</span><strong>{formatTaka(payment.allocatedAmountMinor)}</strong></div>
              <div className="payment-receipt-summary-total"><span>Outstanding due after payment</span><strong>{payment.outstandingAfterMinor === null ? 'Not recorded on this older receipt' : formatTaka(payment.outstandingAfterMinor)}</strong></div>
              <div><span>Advance credit added</span><strong>{formatTaka(payment.advanceAddedMinor)}</strong></div>
            </div>

            <div className="payment-receipt-paid">
              <span>Total amount received</span>
              <strong>{formatTaka(payment.amountMinor)}</strong>
              <p>In words: {amountInWords(payment.amountMinor)}</p>
            </div>

            {payment.notes && <p className="payment-receipt-notes">Notes: {payment.notes}</p>}
            <footer className="payment-receipt-footer">
              <p>This receipt confirms the amount actually received. Only the amount allocated to issued bills or the tenant opening balance reduces outstanding due. Any unallocated amount is held as advance credit and is not counted as a second payment when applied later.</p>
              {workspaceSettings.statementFooter && <strong>{workspaceSettings.statementFooter}</strong>}
              <div className="payment-receipt-signatures"><span>Received by</span><span>Tenant signature</span></div>
              <small>Generated by PropertyOS</small>
            </footer>
          </div>
        </section>
      ))}
    </div>
  )
}
