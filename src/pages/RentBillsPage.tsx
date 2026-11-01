import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'

import {
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  LoaderCircle,
  Plus,
  ReceiptText,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { recordAuditEvent } from '../services/firebase/audit'
import {
  createRoomRentRate,
  deleteRoomRentRate,
  ensureRentBillRoomMonthLocks,
  ensureRentRateUsageLocks,
  generateRentBillsForMonth,
  getRentBillErrorMessage,
  listRentBills,
  listRoomRentRates,
  type RentBillGenerationResult,
  type RentBillRecord,
  type RoomRentRateRecord,
} from '../services/firebase/rentBills'
import { listProperties, type PropertyRecord } from '../services/firebase/properties'
import { listRooms, type RoomRecord } from '../services/firebase/rooms'
import { listTenantAssignments, type TenantAssignmentRecord } from '../services/firebase/tenantAssignments'
import { roomRentRateFormSchema } from '../schemas/rentBill'
import './rent-bills.css'

type RentBillsPageProps = {
  ownerUid: string
}

type RateFormState = {
  roomId: string
  effectiveFrom: string
  monthlyRent: string
  notes: string
}

function getToday(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function getCurrentBillingMonth(): string {
  return getToday().slice(0, 7)
}

function emptyRateForm(roomId = ''): RateFormState {
  return {
    roomId,
    effectiveFrom: getToday(),
    monthlyRent: '',
    notes: '',
  }
}

function parseTakaToPoisha(value: string): number | null {
  const normalized = value.trim()

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null
  }

  const [wholePart, fractionalPart = ''] = normalized.split('.')
  const whole = Number(wholePart)
  const fractional = Number((fractionalPart + '00').slice(0, 2))
  const amount = whole * 100 + fractional

  return Number.isSafeInteger(amount) ? amount : null
}

function formatTaka(amountMinor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)

  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('en-BD', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function formatBillingMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00`)

  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('en-BD', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

export function RentBillsPage({ ownerUid }: RentBillsPageProps) {
  const [rates, setRates] = useState<RoomRentRateRecord[]>([])
  const [bills, setBills] = useState<RentBillRecord[]>([])
  const [rooms, setRooms] = useState<RoomRecord[]>([])
  const [properties, setProperties] = useState<PropertyRecord[]>([])
  const [tenantAssignments, setTenantAssignments] = useState<TenantAssignmentRecord[]>([])

  const [isLoading, setIsLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [pageSuccess, setPageSuccess] = useState('')

  const [isRateDialogOpen, setIsRateDialogOpen] = useState(false)
  const [rateForm, setRateForm] = useState<RateFormState>(emptyRateForm())
  const [rateFormError, setRateFormError] = useState('')
  const [isSavingRate, setIsSavingRate] = useState(false)
  const [deletingRateId, setDeletingRateId] = useState('')

  const [billingMonth, setBillingMonth] = useState(getCurrentBillingMonth)
  const [isGenerationConfirmOpen, setIsGenerationConfirmOpen] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationResult, setGenerationResult] =
    useState<RentBillGenerationResult | null>(null)

  const [billSearch, setBillSearch] = useState('')
  const [billMonthFilter, setBillMonthFilter] = useState(getCurrentBillingMonth)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setPageError('')

    try {
      const [nextRates, nextBills, nextRooms, nextProperties, nextTenantAssignments] =
        await Promise.all([
          listRoomRentRates(ownerUid),
          listRentBills(ownerUid),
          listRooms(ownerUid),
          listProperties(ownerUid),
          listTenantAssignments(ownerUid),
        ])

      // Protect rate records referenced by older issued bills before the
      // user can attempt to delete an unused rate.
      await ensureRentRateUsageLocks(ownerUid, nextBills)
      await ensureRentBillRoomMonthLocks(ownerUid, nextBills)

      setRates(nextRates)
      setBills(nextBills)
      setRooms(nextRooms)
      setProperties(nextProperties)
      setTenantAssignments(nextTenantAssignments)
    } catch (error: unknown) {
      setPageError(getRentBillErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const propertyById = useMemo(
    () => new Map(properties.map((property) => [property.id, property])),
    [properties],
  )

  const roomById = useMemo(
    () => new Map(rooms.map((room) => [room.id, room])),
    [rooms],
  )

  const rateIdsUsedByIssuedBills = useMemo(
    () => new Set(
      bills.flatMap((bill) => bill.rateBreakdown.map((snapshot) => snapshot.rateId)),
    ),
    [bills],
  )

  const ratePreview = useMemo(() => {
    if (!rateForm.roomId || !rateForm.effectiveFrom) return null

    const proposedRentMinor = parseTakaToPoisha(rateForm.monthlyRent)
    if (proposedRentMinor === null || proposedRentMinor <= 0) return null

    const roomRates = rates.filter((rate) => rate.roomId === rateForm.roomId)
    const duplicateRate = roomRates.find(
      (rate) => rate.effectiveFrom === rateForm.effectiveFrom,
    ) ?? null
    const previousRate = roomRates
      .filter((rate) => rate.effectiveFrom < rateForm.effectiveFrom)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null

    return {
      proposedRentMinor,
      duplicateRate,
      previousRate,
      differenceMinor: previousRate
        ? proposedRentMinor - previousRate.monthlyRentMinor
        : 0,
    }
  }, [rates, rateForm.roomId, rateForm.effectiveFrom, rateForm.monthlyRent])

  const rentRateOverview = useMemo(() => {
    // Keep every immutable rate record for billing and ledger history, but show
    // only the latest effective rate once per room in this overview.
    const latestRateByRoom = new Map<string, RoomRentRateRecord>()
    for (const rate of rates) {
      const existing = latestRateByRoom.get(rate.roomId)
      if (!existing || rate.effectiveFrom > existing.effectiveFrom) {
        latestRateByRoom.set(rate.roomId, rate)
      }
    }

    const englishCollator = new Intl.Collator('en', {
      sensitivity: 'base',
      numeric: true,
    })
    const banglaCollator = new Intl.Collator('bn', {
      sensitivity: 'base',
      numeric: true,
    })

    return [...latestRateByRoom.values()]
      .map((rate) => {
        const room = roomById.get(rate.roomId)
        const property = propertyById.get(rate.propertyId)
        const currentTenantNames: string[] = Array.from(new Set<string>(
          tenantAssignments
            .filter((assignment) =>
              assignment.roomId === rate.roomId &&
              assignment.status === 'current' &&
              assignment.moveOutDate === null,
            )
            .map((assignment) => assignment.tenantName.trim())
            .filter((name): name is string => Boolean(name)),
        )).sort((a, b) => a.localeCompare(b, 'bn', { sensitivity: 'base' }))

        return {
          rate,
          room,
          property,
          tenantLabel: currentTenantNames.length > 0
            ? currentTenantNames.join(', ')
            : 'Vacant',
          sortName: currentTenantNames[0] ?? '',
        }
      })
      .sort((a, b) => {
        if (!a.sortName && b.sortName) return 1
        if (a.sortName && !b.sortName) return -1
        if (!a.sortName && !b.sortName) {
          return (a.room?.roomNumber ?? a.rate.roomCode).localeCompare(
            b.room?.roomNumber ?? b.rate.roomCode,
            'en',
            { numeric: true, sensitivity: 'base' },
          )
        }

        const aIsBangla = /[\u0980-\u09FF]/.test(a.sortName)
        const bIsBangla = /[\u0980-\u09FF]/.test(b.sortName)
        if (aIsBangla !== bIsBangla) return aIsBangla ? 1 : -1
        return (aIsBangla ? banglaCollator : englishCollator).compare(
          a.sortName,
          b.sortName,
        )
      })
  }, [rates, roomById, propertyById, tenantAssignments])

  const activePropertyIds = useMemo(
    () => new Set(
      properties
        .filter((property) => property.status === 'active')
        .map((property) => property.id),
    ),
    [properties],
  )

  const selectableRooms = useMemo(
    () => rooms.filter((room) => activePropertyIds.has(room.propertyId)),
    [rooms, activePropertyIds],
  )

  const rentRateCoverage = useMemo(() => {
    const roomIdsWithRates = new Set(rates.map((rate) => rate.roomId))
    const currentTenantNamesByRoom = new Map<string, string[]>()

    for (const assignment of tenantAssignments) {
      if (
        assignment.status !== 'current' ||
        assignment.moveOutDate !== null
      ) {
        continue
      }

      const tenantName = assignment.tenantName.trim()
      if (!tenantName) continue

      const names = currentTenantNamesByRoom.get(assignment.roomId) ?? []
      if (!names.includes(tenantName)) names.push(tenantName)
      currentTenantNamesByRoom.set(assignment.roomId, names)
    }

    const missingRooms = selectableRooms
      .filter((room) => !roomIdsWithRates.has(room.id))
      .map((room) => ({
        room,
        property: propertyById.get(room.propertyId),
        tenantNames: (currentTenantNamesByRoom.get(room.id) ?? []).sort((a, b) => {
          const aIsBangla = /[\u0980-\u09FF]/.test(a)
          const bIsBangla = /[\u0980-\u09FF]/.test(b)
          if (aIsBangla !== bIsBangla) return aIsBangla ? 1 : -1
          return a.localeCompare(b, aIsBangla ? 'bn' : 'en', {
            sensitivity: 'base',
            numeric: true,
          })
        }),
      }))
      .sort((a, b) => {
        const propertyOrder = (a.property?.name ?? a.room.propertyCode).localeCompare(
          b.property?.name ?? b.room.propertyCode,
          'en',
          { sensitivity: 'base', numeric: true },
        )
        if (propertyOrder !== 0) return propertyOrder

        const floorOrder = a.room.floorName.localeCompare(
          b.room.floorName,
          'en',
          { sensitivity: 'base', numeric: true },
        )
        if (floorOrder !== 0) return floorOrder

        return a.room.roomNumber.localeCompare(b.room.roomNumber, 'en', {
          sensitivity: 'base',
          numeric: true,
        })
      })

    const coveredRooms = selectableRooms.length - missingRooms.length

    return {
      totalRooms: selectableRooms.length,
      coveredRooms,
      missingRooms,
      coveragePercent: selectableRooms.length > 0
        ? Math.round((coveredRooms / selectableRooms.length) * 100)
        : 0,
    }
  }, [rates, selectableRooms, tenantAssignments, propertyById])

  const billMonths = useMemo(
    () =>
      [...new Set([getCurrentBillingMonth(), ...bills.map((bill) => bill.billingMonth)])]
        .sort()
        .reverse(),
    [bills],
  )

  const filteredBills = useMemo(() => {
    const searchTerm = billSearch.trim().toLowerCase()

    return bills.filter((bill) => {
      if (billMonthFilter !== 'all' && bill.billingMonth !== billMonthFilter) {
        return false
      }

      if (!searchTerm) return true

      return [
        bill.tenantName,
        bill.tenantCode,
        bill.roomCode,
        bill.roomNumber,
        bill.floorName,
        bill.propertyCode,
        bill.billingMonth,
      ]
        .join(' ')
        .toLowerCase()
        .includes(searchTerm)
    })
  }, [bills, billMonthFilter, billSearch])

  const selectedMonthBills = useMemo(
    () => bills.filter((bill) => bill.billingMonth === billingMonth),
    [bills, billingMonth],
  )

  const billedTotalMinor = useMemo(
    () => bills.reduce((sum, bill) => sum + bill.totalMinor, 0),
    [bills],
  )

  function openRateDialog(roomId = '') {
    setRateForm(emptyRateForm(roomId))
    setRateFormError('')
    setPageError('')
    setPageSuccess('')
    setIsRateDialogOpen(true)
  }

  function closeRateDialog() {
    if (isSavingRate) return

    setIsRateDialogOpen(false)
    setRateForm(emptyRateForm())
    setRateFormError('')
  }

  function updateRateField<K extends keyof RateFormState>(
    field: K,
    value: RateFormState[K],
  ) {
    setRateForm((current) => ({ ...current, [field]: value }))
  }

  async function handleRateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (isSavingRate) return

    setRateFormError('')
    setPageError('')
    setPageSuccess('')

    const monthlyRentMinor = parseTakaToPoisha(rateForm.monthlyRent)

    if (monthlyRentMinor === null || monthlyRentMinor <= 0) {
      setRateFormError('Enter a valid monthly rent greater than ৳0.00, using up to two decimal places.')
      return
    }

    const parsed = roomRentRateFormSchema.safeParse({
      roomId: rateForm.roomId,
      effectiveFrom: rateForm.effectiveFrom,
      monthlyRentMinor,
      notes: rateForm.notes,
    })

    if (!parsed.success) {
      setRateFormError(
        parsed.error.issues[0]?.message ?? 'Review the rent rate details.',
      )
      return
    }

    setIsSavingRate(true)

    try {
      const rateId = await createRoomRentRate(ownerUid, parsed.data)
      const selectedRoom = rooms.find((room) => room.id === parsed.data.roomId)
      const roomLabel = selectedRoom ? `${selectedRoom.roomCode} · Room ${selectedRoom.roomNumber}` : 'Selected room'
      await recordAuditEvent(ownerUid, {
        action: 'rate_added',
        entityType: 'rent_rate',
        entityId: rateId,
        entityLabel: `${roomLabel} rent rate`,
        summary: `Set monthly rent for ${roomLabel} to ${formatTaka(parsed.data.monthlyRentMinor)}, effective ${parsed.data.effectiveFrom}.`,
      })
      setIsRateDialogOpen(false)
      setRateForm(emptyRateForm())
      setPageSuccess('Rent rate saved. Previously issued bills and their rate snapshots were not changed.')
      await loadData()
    } catch (error: unknown) {
      setRateFormError(getRentBillErrorMessage(error))
    } finally {
      setIsSavingRate(false)
    }
  }

  async function handleDeleteRate(rate: RoomRentRateRecord) {
    if (deletingRateId || isSavingRate || isGenerating) return

    if (rateIdsUsedByIssuedBills.has(rate.id)) {
      setPageError(
        'This rent rate is already used by an issued bill. It cannot be deleted; add a new rate with a different effective date instead.',
      )
      return
    }

    const room = roomById.get(rate.roomId)
    const roomLabel = room
      ? `Room ${room.roomNumber} (${room.roomCode})`
      : `Room ${rate.roomCode}`
    const confirmed = window.confirm(
      `Delete the unused rent rate for ${roomLabel}, effective ${rate.effectiveFrom}? You can add it again with the same effective date. Issued bills will not be changed.`,
    )
    if (!confirmed) return

    setDeletingRateId(rate.id)
    setPageError('')
    setPageSuccess('')

    try {
      await deleteRoomRentRate(ownerUid, rate.id)
      await recordAuditEvent(ownerUid, {
        action: 'rate_deleted',
        entityType: 'rent_rate',
        entityId: rate.id,
        entityLabel: `${roomLabel} rent rate`,
        summary: `Deleted unused rent rate ${formatTaka(rate.monthlyRentMinor)}, effective ${rate.effectiveFrom}.`,
      })
      setPageSuccess(
        `Unused rent rate for ${roomLabel} was deleted. You can now enter the corrected rate using the same effective date.`,
      )
      await loadData()
    } catch (error: unknown) {
      setPageError(getRentBillErrorMessage(error))
    } finally {
      setDeletingRateId('')
    }
  }

  async function handleGenerateBills() {
    if (isGenerating || !billingMonth) return

    setIsGenerating(true)
    setIsGenerationConfirmOpen(false)
    setPageError('')
    setPageSuccess('')
    setGenerationResult(null)

    try {
      const result = await generateRentBillsForMonth(ownerUid, billingMonth)
      if (result.created > 0) {
        await recordAuditEvent(ownerUid, {
          action: 'bills_generated',
          entityType: 'rent_bills',
          entityId: result.billingMonth,
          entityLabel: formatBillingMonth(result.billingMonth),
          summary: `Generated ${result.created} rent ${result.created === 1 ? 'bill' : 'bills'} for ${formatBillingMonth(result.billingMonth)}. ${result.alreadyExisted} already existed and ${result.skipped} were skipped.`,
        })
      }
      setGenerationResult(result)
      setPageSuccess(`Billing run completed for ${formatBillingMonth(result.billingMonth)}. Review the results below.`)
      await loadData()
    } catch (error: unknown) {
      setPageError(getRentBillErrorMessage(error))
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <>
      <header className="page-heading rent-page-heading">
        <div>
          <p className="eyebrow">Finance</p>
          <h1>Rent &amp; Bills</h1>
          <p className="page-description">
            Set dated room rent rates, generate monthly bills, and review the saved billing history.
          </p>
        </div>

        <button
          className="button button-primary"
          type="button"
          onClick={() => openRateDialog()}
          disabled={isLoading || selectableRooms.length === 0}
        >
          <Plus size={17} aria-hidden="true" />
          Set rent rate
        </button>
      </header>

      {pageError && (
        <div className="properties-error" role="alert">
          <p>{pageError}</p>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void loadData()}
            disabled={isLoading}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Retry
          </button>
        </div>
      )}

      {pageSuccess && (
        <div className="rent-success-message" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          <span>{pageSuccess}</span>
          <button
            type="button"
            className="rent-dismiss-message"
            onClick={() => setPageSuccess('')}
            aria-label="Dismiss success message"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="rent-page-stack">
        <section className="rent-stats-grid" aria-label="Rent billing summary">
          <article className="rent-stat-card">
            <span className="rent-stat-icon rent-stat-icon--blue">
              <ReceiptText size={19} aria-hidden="true" />
            </span>
            <p>Total issued bills</p>
            <strong>{isLoading ? '—' : bills.length}</strong>
            <small>All saved billing months</small>
          </article>
          <article className="rent-stat-card">
            <span className="rent-stat-icon rent-stat-icon--green">
              <CalendarDays size={19} aria-hidden="true" />
            </span>
            <p>Selected month</p>
            <strong>{isLoading ? '—' : selectedMonthBills.length}</strong>
            <small>{formatBillingMonth(billingMonth)}</small>
          </article>
          <article className="rent-stat-card">
            <span className="rent-stat-icon rent-stat-icon--purple">
              <CircleDollarSign size={19} aria-hidden="true" />
            </span>
            <p>Total billed</p>
            <strong>{isLoading ? '—' : formatTaka(billedTotalMinor)}</strong>
            <small>Historical issued totals</small>
          </article>
        </section>

        <div className="rent-workspace-grid">
          <section className="panel rent-generator-panel">
            <div className="panel-heading">
              <div>
                <h2>Generate monthly bills</h2>
                <p>One bill per eligible tenant assignment for the selected month.</p>
              </div>
              <span className="rent-panel-icon">
                <CalendarDays size={19} aria-hidden="true" />
              </span>
            </div>

            <label className="property-form-field rent-month-field">
              <span>Billing month <span aria-hidden="true">*</span></span>
              <input
                type="month"
                value={billingMonth}
                onChange={(event) => {
                  setBillingMonth(event.target.value)
                  setPageSuccess('')
                  setGenerationResult(null)
                }}
                required
              />
            </label>

            <p className="rent-help-text">
              Existing bills are kept as-is. Running the same month again will not create duplicate bills.
            </p>

            <button
              className="button button-primary rent-full-button"
              type="button"
              onClick={() => setIsGenerationConfirmOpen(true)}
              disabled={isLoading || isGenerating || !billingMonth}
            >
              {isGenerating ? (
                <LoaderCircle className="rent-spin" size={17} aria-hidden="true" />
              ) : (
                <ReceiptText size={17} aria-hidden="true" />
              )}
              {isGenerating ? 'Generating bills…' : 'Generate bills'}
            </button>

            {generationResult && (
              <div className="rent-generation-result" role="status">
                <h3>Generation report · {formatBillingMonth(generationResult.billingMonth)}</h3>
                {generationResult.created + generationResult.alreadyExisted + generationResult.skipped + generationResult.errors.length === 0 ? (
                  <p>No tenant assignments overlap this billing month.</p>
                ) : (
                  <div className="rent-result-counts">
                    <span><strong>{generationResult.created}</strong> created</span>
                    <span><strong>{generationResult.alreadyExisted}</strong> already existed</span>
                    <span><strong>{generationResult.skipped}</strong> skipped</span>
                    <span className={generationResult.errors.length > 0 ? 'has-errors' : ''}>
                      <strong>{generationResult.errors.length}</strong> errors
                    </span>
                  </div>
                )}
                {generationResult.errors.length > 0 && (
                  <details className="rent-generation-errors">
                    <summary>Review {generationResult.errors.length} item(s) that need attention</summary>
                    <ul>
                      {generationResult.errors.map((item) => (
                        <li key={`${item.assignmentId}-${item.message}`}>
                          <strong>{item.tenantName}</strong> · {item.tenantCode} · Room {item.roomNumber} ({item.roomCode})
                          <span>{item.message}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </section>

          <section className="panel rent-rates-panel">
            <div className="panel-heading">
              <div>
                <h2>Rent rate history</h2>
                <p>One latest rate per room is shown here. Every rent change remains recorded in that room's ledger.</p>
              </div>
              <span className="rent-panel-icon">
                <CircleDollarSign size={19} aria-hidden="true" />
              </span>
            </div>

            {!isLoading && (
              <div className="rent-rate-coverage" role="status" aria-live="polite">
                <div className="rent-rate-coverage-top">
                  <div>
                    <strong>{rentRateCoverage.coveredRooms} of {rentRateCoverage.totalRooms} rooms have rent rates</strong>
                    <span>
                      {rentRateCoverage.missingRooms.length === 0
                        ? 'Every selectable room has at least one rent rate.'
                        : `${rentRateCoverage.missingRooms.length} ${rentRateCoverage.missingRooms.length === 1 ? 'room needs' : 'rooms need'} a rent rate.`}
                    </span>
                  </div>
                  <strong className={rentRateCoverage.missingRooms.length > 0 ? 'rent-rate-coverage-count is-missing' : 'rent-rate-coverage-count'}>
                    {rentRateCoverage.coveragePercent}%
                  </strong>
                </div>
                <div
                  className="rent-rate-coverage-track"
                  role="progressbar"
                  aria-label="Rooms with rent rates"
                  aria-valuemin={0}
                  aria-valuemax={rentRateCoverage.totalRooms}
                  aria-valuenow={rentRateCoverage.coveredRooms}
                >
                  <span style={{ width: `${rentRateCoverage.coveragePercent}%` }} />
                </div>
              </div>
            )}

            {!isLoading && rentRateCoverage.missingRooms.length > 0 && (
              <details
                className="rent-missing-rate-panel"
                open={rentRateCoverage.missingRooms.length <= 10}
              >
                <summary>
                  <span>
                    <strong>Rooms without rent rates</strong>
                    <small>Identify rooms that still need a monthly rent amount.</small>
                  </span>
                  <b>{rentRateCoverage.missingRooms.length} missing</b>
                </summary>
                <div className="rent-missing-rate-list">
                  {rentRateCoverage.missingRooms.map(({ room, property, tenantNames }) => (
                    <article className="rent-missing-rate-item" key={room.id}>
                      <div className="rent-missing-rate-copy">
                        <strong>
                          {tenantNames.length > 0 ? tenantNames.join(', ') : 'Vacant'}
                          {' · '}Room {room.roomNumber}
                        </strong>
                        <span>
                          {property?.name ?? room.propertyCode}
                          {' · '}Floor {room.floorName}
                          {' · '}{room.roomCode}
                        </span>
                      </div>
                      <button
                        className="button button-secondary rent-missing-rate-action"
                        type="button"
                        onClick={() => openRateDialog(room.id)}
                        disabled={isSavingRate}
                      >
                        <Plus size={14} aria-hidden="true" />
                        Set rate
                      </button>
                    </article>
                  ))}
                </div>
              </details>
            )}

            {isLoading ? (
              <div className="properties-state rent-inline-state" role="status">
                <LoaderCircle className="rent-spin" size={22} aria-hidden="true" />
                <p>Loading rent rates…</p>
              </div>
            ) : rates.length === 0 ? (
              <div className="rent-empty-inline">
                <FileText size={23} aria-hidden="true" />
                <strong>No rent rates recorded</strong>
                <p>Add a room rate before generating rent bills.</p>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => openRateDialog()}
                  disabled={selectableRooms.length === 0}
                >
                  <Plus size={16} aria-hidden="true" />
                  Add first rate
                </button>
              </div>
            ) : (
              <div className="rent-rate-list">
                {rentRateOverview.map(({ rate, room, property, tenantLabel }) => (
                  <article className="rent-rate-item" key={rate.roomId}>
                    <div className="rent-rate-main">
                      <div className="rent-rate-heading">
                        <strong>{tenantLabel} - Room {room?.roomNumber ?? rate.roomCode}</strong>
                        <span>{formatTaka(rate.monthlyRentMinor)} <small>/ month</small></span>
                      </div>
                      <p>
                        {property?.name ?? rate.propertyCode}
                        {room ? ` · Floor ${room.floorName}` : ''}
                      </p>
                      <div className="rent-rate-meta">
                        <span>Effective {formatDate(rate.effectiveFrom)}</span>
                        {rate.notes && <span className="rent-rate-note">{rate.notes}</span>}
                      </div>
                      <div className="rent-rate-actions">
                        {rateIdsUsedByIssuedBills.has(rate.id) ? (
                          <span className="rent-rate-locked-note">
                            Used in an issued bill · protected
                          </span>
                        ) : (
                          <span className="rent-rate-available-note">
                            Not used in an issued bill · can be deleted
                          </span>
                        )}
                        <button
                          type="button"
                          className="button button-secondary rent-rate-delete-button"
                          onClick={() => void handleDeleteRate(rate)}
                          disabled={
                            rateIdsUsedByIssuedBills.has(rate.id) ||
                            Boolean(deletingRateId) ||
                            isSavingRate ||
                            isGenerating ||
                            isLoading
                          }
                          title={
                            rateIdsUsedByIssuedBills.has(rate.id)
                              ? 'This rate is used by an issued bill and cannot be deleted.'
                              : 'Delete this unused rent rate'
                          }
                        >
                          {deletingRateId === rate.id ? (
                            <LoaderCircle className="rent-spin" size={14} aria-hidden="true" />
                          ) : (
                            <Trash2 size={14} aria-hidden="true" />
                          )}
                          {deletingRateId === rate.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="panel rent-bills-panel">
          <div className="panel-heading rent-bills-heading">
            <div>
              <h2>Issued rent bills</h2>
              <p>Saved bill values and rate breakdowns remain historical snapshots.</p>
            </div>
            <span className="rent-bill-count">{filteredBills.length} shown</span>
          </div>

          <div className="rent-bills-toolbar">
            <SearchInput
              value={billSearch}
              onChange={setBillSearch}
              placeholder="Search tenant, room, or month…"
            />
            <label className="rent-filter-field">
              <span>Month</span>
              <select
                value={billMonthFilter}
                onChange={(event) => setBillMonthFilter(event.target.value)}
                aria-label="Filter bills by billing month"
              >
                <option value="all">All months</option>
                {billMonths.map((month) => (
                  <option value={month} key={month}>{formatBillingMonth(month)}</option>
                ))}
              </select>
            </label>
          </div>

          {isLoading ? (
            <div className="properties-state" role="status">
              <LoaderCircle className="rent-spin" size={22} aria-hidden="true" />
              <p>Loading issued bills…</p>
            </div>
          ) : filteredBills.length === 0 ? (
            <div className="rent-empty-inline rent-empty-bills">
              <ReceiptText size={25} aria-hidden="true" />
              <strong>{bills.length === 0 ? 'No rent bills yet' : 'No matching bills'}</strong>
              <p>
                {bills.length === 0
                  ? 'Choose a billing month above and generate bills after adding rent rates for the occupied rooms.'
                  : 'Try another search term or billing month.'}
              </p>
            </div>
          ) : (
            <div className="rent-bill-list">
              {filteredBills.map((bill) => (
                <article className="rent-bill-card" key={bill.id}>
                  <div className="rent-bill-card-top">
                    <div className="rent-bill-person">
                      <strong>{bill.tenantName}</strong>
                      <span>{bill.tenantCode}</span>
                    </div>
                    <div className="rent-bill-amount">
                      <strong>{formatTaka(bill.totalMinor)}</strong>
                      <span className="rent-issued-status">Issued</span>
                    </div>
                  </div>

                  <div className="rent-bill-details">
                    <span><small>Billing month</small><strong>{formatBillingMonth(bill.billingMonth)}</strong></span>
                    <span><small>Room</small><strong>{bill.roomCode} · {bill.roomNumber}</strong></span>
                    <span><small>Property</small><strong>{bill.propertyCode}</strong></span>
                    <span><small>Occupancy</small><strong>{formatDate(bill.occupancyStartDate)} – {formatDate(bill.occupancyEndDate)}</strong></span>
                    <span><small>Chargeable days</small><strong>{bill.chargedDays} / {bill.daysInMonth}</strong></span>
                  </div>

                  <details className="rent-bill-breakdown">
                    <summary>View saved rate breakdown ({bill.rateBreakdown.length})</summary>
                    <div className="rent-breakdown-list">
                      {bill.rateBreakdown.map((part, index) => (
                        <div className="rent-breakdown-row" key={`${part.rateId}-${part.segmentStartDate}-${index}`}>
                          <div>
                            <strong>{formatTaka(part.monthlyRentMinor)} per month</strong>
                            <span>Rate effective {formatDate(part.effectiveFrom)}</span>
                            <span>{formatDate(part.segmentStartDate)} – {formatDate(part.segmentEndDate)} · {part.chargedDays} day(s)</span>
                          </div>
                          <strong>{formatTaka(part.amountMinor)}</strong>
                        </div>
                      ))}
                    </div>
                  </details>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {isRateDialogOpen && (
        <div className="modal-overlay" role="presentation">
          <section
            className="property-modal rent-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rent-rate-dialog-title"
          >
            <div className="property-modal-heading">
              <div>
                <p className="eyebrow">Rent settings</p>
                <h2 id="rent-rate-dialog-title">Set room rent rate</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={closeRateDialog}
                disabled={isSavingRate}
                aria-label="Close rent rate form"
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>

            <p className="property-id-note">
              Each rate is preserved by its effective date. Adding a new rate does not rewrite previously issued bills.
            </p>

            <form className="property-form" onSubmit={handleRateSubmit}>
              <div className="property-form-field">
                <label htmlFor="rent-rate-room">Room <span>*</span></label>
                <select
                  id="rent-rate-room"
                  value={rateForm.roomId}
                  onChange={(event) => updateRateField('roomId', event.target.value)}
                  required
                  disabled={isSavingRate || selectableRooms.length === 0}
                >
                  <option value="">Select a room</option>
                  {[...selectableRooms]
                    .map((room) => {
                      const currentTenants = tenantAssignments.filter((assignment) =>
                        assignment.roomId === room.id &&
                        assignment.status === 'current' &&
                        assignment.moveOutDate === null,
                      )
                      const tenantName = currentTenants.length === 1
                        ? currentTenants[0].tenantName
                        : currentTenants.length > 1
                          ? 'Multiple tenants — review'
                          : 'Vacant'
                      const propertyName = propertyById.get(room.propertyId)?.name ?? 'Property unavailable'
                      return {
                        room,
                        tenantName,
                        label: `${tenantName} - Room ${room.roomNumber} - ${propertyName}`,
                      }
                    })
                    .sort((a, b) => {
                      const aVacant = a.tenantName === 'Vacant'
                      const bVacant = b.tenantName === 'Vacant'
                      if (aVacant !== bVacant) return aVacant ? 1 : -1
                      const aBangla = /[\u0980-\u09FF]/.test(a.tenantName)
                      const bBangla = /[\u0980-\u09FF]/.test(b.tenantName)
                      if (aBangla !== bBangla) return aBangla ? 1 : -1
                      return a.tenantName.localeCompare(b.tenantName, aBangla ? 'bn' : 'en', { sensitivity: 'base', numeric: true })
                    })
                    .map(({ room, label }) => (
                      <option value={room.id} key={room.id}>{label}</option>
                    ))}
                </select>
                {selectableRooms.length === 0 && (
                  <small className="field-hint">Create a room under an active property before adding a rent rate.</small>
                )}
              </div>

              <div className="room-form-row">
                <div className="property-form-field">
                  <label htmlFor="rent-rate-effective-date">Effective from <span>*</span></label>
                  <input
                    id="rent-rate-effective-date"
                    type="date"
                    value={rateForm.effectiveFrom}
                    onChange={(event) => updateRateField('effectiveFrom', event.target.value)}
                    required
                    disabled={isSavingRate}
                  />
                </div>
                <div className="property-form-field">
                  <label htmlFor="rent-rate-monthly-amount">Monthly rent (BDT) <span>*</span></label>
                  <input
                    id="rent-rate-monthly-amount"
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="0.01"
                    placeholder="8500.00"
                    value={rateForm.monthlyRent}
                    onChange={(event) => updateRateField('monthlyRent', event.target.value)}
                    required
                    disabled={isSavingRate}
                  />
                </div>
              </div>
              <p className="field-hint rent-currency-hint">Enter the amount in taka. The database stores integer poisha (100 poisha = ৳1).</p>

              {ratePreview && (
                <section className="rent-rate-preview" aria-live="polite" aria-label="Rent rate preview">
                  <div className="rent-rate-preview-heading">
                    <strong>Review before saving</strong>
                    <span>Effective {formatDate(rateForm.effectiveFrom)}</span>
                  </div>
                  {ratePreview.duplicateRate ? (
                    <p className="rent-rate-preview-warning">A rate already exists for this room and effective date. Delete it first if it is unused, or choose a different date.</p>
                  ) : ratePreview.previousRate ? (
                    <div className="rent-rate-preview-grid">
                      <div>
                        <small>Previous monthly rent</small>
                        <strong>{formatTaka(ratePreview.previousRate.monthlyRentMinor)}</strong>
                      </div>
                      <div>
                        <small>{ratePreview.differenceMinor === 0 ? 'Change' : ratePreview.differenceMinor > 0 ? 'Monthly increase' : 'Monthly decrease'}</small>
                        <strong className={ratePreview.differenceMinor === 0 ? '' : ratePreview.differenceMinor > 0 ? 'is-increase' : 'is-decrease'}>
                          {ratePreview.differenceMinor === 0
                            ? 'No change'
                            : `${ratePreview.differenceMinor > 0 ? '+' : '−'}${formatTaka(Math.abs(ratePreview.differenceMinor))}`}
                        </strong>
                      </div>
                      <div>
                        <small>New monthly rent</small>
                        <strong>{formatTaka(ratePreview.proposedRentMinor)}</strong>
                      </div>
                    </div>
                  ) : (
                    <div className="rent-rate-preview-grid is-initial">
                      <div>
                        <small>Initial monthly rent</small>
                        <strong>{formatTaka(ratePreview.proposedRentMinor)}</strong>
                      </div>
                    </div>
                  )}
                  <p className="rent-rate-preview-note">This rate-history entry is informational. It does not create a debit or change the Room Ledger balance. Only an issued rent bill creates a charge.</p>
                </section>
              )}

              <div className="property-form-field">
                <label htmlFor="rent-rate-notes">Notes</label>
                <textarea
                  id="rent-rate-notes"
                  value={rateForm.notes}
                  onChange={(event) => updateRateField('notes', event.target.value)}
                  placeholder="Optional reason or reference for this rate"
                  maxLength={1000}
                  disabled={isSavingRate}
                />
              </div>

              {rateFormError && <p className="rent-form-error" role="alert">{rateFormError}</p>}

              <div className="property-form-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={closeRateDialog}
                  disabled={isSavingRate}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={isSavingRate || selectableRooms.length === 0 || Boolean(ratePreview?.duplicateRate)}
                >
                  {isSavingRate && <LoaderCircle className="rent-spin" size={16} aria-hidden="true" />}
                  {isSavingRate ? 'Saving rate…' : 'Confirm & save rate'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {isGenerationConfirmOpen && (
        <div className="modal-overlay" role="presentation">
          <section
            className="property-modal rent-modal rent-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rent-generation-dialog-title"
          >
            <div className="property-modal-heading">
              <div>
                <p className="eyebrow">Bill generation</p>
                <h2 id="rent-generation-dialog-title">Generate {formatBillingMonth(billingMonth)} bills?</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setIsGenerationConfirmOpen(false)}
                disabled={isGenerating}
                aria-label="Close confirmation"
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>

            <p className="rent-confirm-copy">
              PropertyOS will calculate bills from each assignment that overlaps this month and the rent rates effective during the occupied dates. Existing bills will not be overwritten, and a repeat run will not create duplicates.
            </p>

            <div className="property-form-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => setIsGenerationConfirmOpen(false)}
                disabled={isGenerating}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="button"
                onClick={() => void handleGenerateBills()}
                disabled={isGenerating || !billingMonth}
              >
                {isGenerating && <LoaderCircle className="rent-spin" size={16} aria-hidden="true" />}
                {isGenerating ? 'Generating…' : 'Confirm generation'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
