import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import {
  Activity,
  CheckCircle2,
  CircleDollarSign,
  Download,
  FileText,
  Gauge,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
  Zap,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { listMeterAssignments, type MeterAssignmentRecord } from '../services/firebase/meters'
import { recordAuditEvent } from '../services/firebase/audit'
import { listRooms, type RoomRecord } from '../services/firebase/rooms'
import { listProperties, type PropertyRecord } from '../services/firebase/properties'
import { listTenantAssignments, type TenantAssignmentRecord } from '../services/firebase/tenantAssignments'
import {
  createElectricityBillFromReading,
  resolveElectricityBillTenantAssignment,
  createElectricityRate,
  getElectricityErrorMessage,
  listElectricityBills,
  listElectricityRates,
  listElectricityReadings,
  type ElectricityBillRecord,
  type ElectricityRateRecord,
  type ElectricityReadingRecord,
} from '../services/firebase/electricity'
import { electricityRateFormSchema, electricityReadingFormSchema } from '../schemas/electricity'
import { loadWorkspaceSettings } from '../services/firebase/workspaceSettings'
import { downloadMonthlyBillReportPdf } from '../utils/monthlyBillReportPdf'
import { compareTenantNames } from '../utils/tenantNameSort'
import './electricity.css'

type ElectricityPageProps = { ownerUid: string }
type RateFormState = { roomId: string; effectiveFrom: string; pricePerUnit: string; notes: string }
type ReadingFormState = { meterAssignmentId: string; readingDate: string; currentReading: string; notes: string }

// The default ৳10.00/unit rate remains active for billing, but is hidden from the visible rate history.
const DEFAULT_ELECTRICITY_RATE_MINOR = 10 * 100

function todayIso(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function emptyRateForm(roomId = ''): RateFormState {
  return { roomId, effectiveFrom: todayIso(), pricePerUnit: '', notes: '' }
}

function emptyReadingForm(): ReadingFormState {
  return { meterAssignmentId: '', readingDate: todayIso(), currentReading: '', notes: '' }
}

function takaToPoisha(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [wholePart, decimalPart = ''] = normalized.split('.')
  const result = Number(wholePart) * 100 + Number((decimalPart + '00').slice(0, 2))
  return Number.isSafeInteger(result) ? result : null
}

function formatTaka(amountMinor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100)}`
}

function formatReading(value: number): string {
  return new Intl.NumberFormat('en-BD', { maximumFractionDigits: 3 }).format(value)
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

function getApplicableRate(
  rates: ElectricityRateRecord[],
  roomId: string,
  readingDate: string,
): ElectricityRateRecord | undefined {
  const eligible = (items: ElectricityRateRecord[]) => items
    .filter((rate) => rate.effectiveFrom <= readingDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))

  // A room-specific rate remains active until a newer rate is added for that
  // room. Legacy shared rates are used only until that room has its own rate.
  return eligible(rates.filter((rate) => rate.roomId === roomId))[0]
    ?? eligible(rates.filter((rate) => rate.roomId === null))[0]
}

export function ElectricityPage({ ownerUid }: ElectricityPageProps) {
  const [rates, setRates] = useState<ElectricityRateRecord[]>([])
  const [readings, setReadings] = useState<ElectricityReadingRecord[]>([])
  const [bills, setBills] = useState<ElectricityBillRecord[]>([])
  const [assignments, setAssignments] = useState<MeterAssignmentRecord[]>([])
  const [rooms, setRooms] = useState<RoomRecord[]>([])
  const [properties, setProperties] = useState<PropertyRecord[]>([])
  const [tenantAssignments, setTenantAssignments] = useState<TenantAssignmentRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [pageSuccess, setPageSuccess] = useState('')
  const [isRateFormOpen, setIsRateFormOpen] = useState(false)
  const [isReadingFormOpen, setIsReadingFormOpen] = useState(false)
  const [rateForm, setRateForm] = useState<RateFormState>(emptyRateForm())
  const [readingForm, setReadingForm] = useState<ReadingFormState>(emptyReadingForm())
  const [rateFormError, setRateFormError] = useState('')
  const [readingFormError, setReadingFormError] = useState('')
  const [isSavingRate, setIsSavingRate] = useState(false)
  const [isSavingReading, setIsSavingReading] = useState(false)
  const [billSearch, setBillSearch] = useState('')
  // Default the dashboard to the current billing month; historical months remain selectable.
  const [monthFilter, setMonthFilter] = useState(() => todayIso().slice(0, 7))
  const [isDownloadingReport, setIsDownloadingReport] = useState(false)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setPageError('')
    try {
      const [nextRates, nextReadings, nextBills, nextAssignments, nextRooms, nextProperties, nextTenantAssignments] = await Promise.all([
        listElectricityRates(ownerUid),
        listElectricityReadings(ownerUid),
        listElectricityBills(ownerUid),
        listMeterAssignments(ownerUid),
        listRooms(ownerUid),
        listProperties(ownerUid),
        listTenantAssignments(ownerUid),
      ])
      setRates(nextRates)
      setReadings(nextReadings)
      setBills(nextBills)
      setAssignments(nextAssignments)
      setRooms(nextRooms)
      setProperties(nextProperties)
      setTenantAssignments(nextTenantAssignments)
    } catch (error: unknown) {
      setPageError(getElectricityErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => { void loadData() }, [loadData])

  const roomById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms])
  const propertyById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties])
  const currentTenantByRoomId = useMemo(() => {
    const map = new Map<string, TenantAssignmentRecord>()
    for (const assignment of tenantAssignments) {
      if (assignment.status === 'current') {
        map.set(assignment.roomId, assignment)
      }
    }
    return map
  }, [tenantAssignments])
  const currentAssignments = useMemo(
    () => assignments
      .filter((assignment) => assignment.status === 'current')
      .sort((left, right) =>
        compareTenantNames(
          currentTenantByRoomId.get(left.roomId)?.tenantName,
          currentTenantByRoomId.get(right.roomId)?.tenantName,
        ) || left.roomCode.localeCompare(right.roomCode),
      ),
    [assignments, currentTenantByRoomId],
  )
  const selectableRooms = useMemo(
    () => [...rooms].sort((left, right) =>
      compareTenantNames(
        currentTenantByRoomId.get(left.id)?.tenantName,
        currentTenantByRoomId.get(right.id)?.tenantName,
      ) || left.roomCode.localeCompare(right.roomCode),
    ),
    [rooms, currentTenantByRoomId],
  )
  const visibleRates = useMemo(
    () => rates.filter((rate) => rate.pricePerUnitMinor !== DEFAULT_ELECTRICITY_RATE_MINOR),
    [rates],
  )
  const billDisplayLabel = useCallback((bill: ElectricityBillRecord) => {
    // Use the room's CURRENT tenant assignment for display only. The issued bill
    // keeps its original meter, room, property, reading, rate, and amount snapshots.
    const room = roomById.get(bill.roomId)
    const tenantAssignment = currentTenantByRoomId.get(bill.roomId)
    const property = propertyById.get(bill.propertyId)
      ?? (room ? propertyById.get(room.propertyId) : undefined)
    const tenantName = tenantAssignment?.tenantName?.trim() || 'No current tenant'
    const roomNumber = room?.roomNumber || tenantAssignment?.roomNumber || bill.roomCode
    const propertyName = property?.name || tenantAssignment?.propertyCode || bill.propertyCode

    return `${tenantName} - Room ${roomNumber} - ${propertyName}`
  }, [roomById, currentTenantByRoomId, propertyById])
  const months = useMemo(() => {
    // Include both bill and reading months, plus the current month even when it
    // has no bills yet. This makes the page open on a clean current-month view.
    const currentMonth = todayIso().slice(0, 7)
    return [...new Set([
      currentMonth,
      ...bills.map((bill) => bill.billingMonth),
      ...readings.map((reading) => reading.billingMonth),
    ])].sort().reverse()
  }, [bills, readings])
  const monthBills = useMemo(
    () => monthFilter === 'all' ? bills : bills.filter((bill) => bill.billingMonth === monthFilter),
    [bills, monthFilter],
  )
  const monthReadings = useMemo(
    () => monthFilter === 'all' ? readings : readings.filter((reading) => reading.billingMonth === monthFilter),
    [readings, monthFilter],
  )
  const monthTotalBilledMinor = useMemo(
    () => monthBills.reduce((sum, bill) => sum + bill.amountMinor, 0),
    [monthBills],
  )
  const filteredBills = useMemo(() => {
    const term = billSearch.trim().toLowerCase()
    return monthBills.filter((bill) => {
      if (!term) return true
      return [billDisplayLabel(bill), bill.meterCode, bill.roomCode, bill.propertyCode, bill.billingMonth, bill.readingDate].join(' ').toLowerCase().includes(term)
    })
  }, [billSearch, monthBills, billDisplayLabel])
  const selectedAssignment = currentAssignments.find((assignment) => assignment.id === readingForm.meterAssignmentId)
  const selectedPreviousReading = selectedAssignment
    ? readings.find((item) => item.meterAssignmentId === selectedAssignment.id)?.currentReading ?? selectedAssignment.initialReading
    : 0
  const selectedRate = selectedAssignment
    ? getApplicableRate(rates, selectedAssignment.roomId, readingForm.readingDate)
    : undefined

  async function handleDownloadElectricityReport() {
    if (isDownloadingReport) return
    if (monthFilter === 'all') {
      setPageError('Choose one billing month before downloading the electricity bill report.')
      return
    }

    const reportBills = bills.filter((bill) => bill.billingMonth === monthFilter)
    if (reportBills.length === 0) {
      setPageError(`No issued electricity bills exist for ${formatMonth(monthFilter)}.`)
      return
    }

    setPageError('')
    setPageSuccess('')
    setIsDownloadingReport(true)
    try {
      const { settings } = await loadWorkspaceSettings(ownerUid)
      await downloadMonthlyBillReportPdf({
        kind: 'electricity',
        houseName: settings.houseName,
        billingMonth: monthFilter,
        rows: reportBills.map((bill) => {
          const tenantAssignment = resolveElectricityBillTenantAssignment(bill, tenantAssignments)
          const room = roomById.get(bill.roomId)
          const property = propertyById.get(bill.propertyId)
            ?? (room ? propertyById.get(room.propertyId) : undefined)

          return {
            tenantName: bill.tenantName?.trim() || tenantAssignment?.tenantName || 'Unassigned',
            roomNumber: bill.tenantRoomNumber || room?.roomNumber || tenantAssignment?.roomNumber || bill.roomCode,
            propertyName: property?.name || bill.propertyCode,
            amountMinor: bill.amountMinor,
          }
        }),
      })
      setPageSuccess(`Monthly electricity bill PDF downloaded for ${formatMonth(monthFilter)}. Only issued electricity amounts are included; previous dues and payments are excluded.`)
    } catch (error: unknown) {
      setPageError(error instanceof Error ? error.message : 'Could not generate the monthly electricity bill PDF.')
    } finally {
      setIsDownloadingReport(false)
    }
  }

  async function handleRateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setRateFormError('')
    setPageError('')
    setPageSuccess('')
    const pricePerUnitMinor = takaToPoisha(rateForm.pricePerUnit)
    if (pricePerUnitMinor === null) {
      setRateFormError('Enter a valid rate with up to two decimal places.')
      return
    }
    const parsed = electricityRateFormSchema.safeParse({
      roomId: rateForm.roomId,
      effectiveFrom: rateForm.effectiveFrom,
      pricePerUnitMinor,
      notes: rateForm.notes,
    })
    if (!parsed.success) {
      setRateFormError(parsed.error.issues[0]?.message ?? 'Check the rate details.')
      return
    }
    setIsSavingRate(true)
    try {
      const rateId = await createElectricityRate(ownerUid, parsed.data)
      const selectedRoom = rooms.find((room) => room.id === parsed.data.roomId)
      const roomLabel = selectedRoom ? `${selectedRoom.roomCode} · Room ${selectedRoom.roomNumber}` : 'Selected room'
      await recordAuditEvent(ownerUid, {
        action: 'rate_added',
        entityType: 'electricity_rate',
        entityId: rateId,
        entityLabel: `${roomLabel} electricity rate`,
        summary: `Set electricity rate for ${roomLabel} to ${formatTaka(parsed.data.pricePerUnitMinor)} per unit, effective ${parsed.data.effectiveFrom}.`,
      })
      setPageSuccess(`Electricity rate for ${selectedRoom?.roomCode ?? 'the selected room'} saved from ${formatDate(parsed.data.effectiveFrom)}. Earlier rate records remain unchanged.`)
      setRateForm(emptyRateForm())
      setIsRateFormOpen(false)
      await loadData()
    } catch (error: unknown) {
      setRateFormError(getElectricityErrorMessage(error))
    } finally {
      setIsSavingRate(false)
    }
  }

  async function handleReadingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setReadingFormError('')
    setPageError('')
    setPageSuccess('')
    const currentReading = readingForm.currentReading.trim() === '' ? Number.NaN : Number(readingForm.currentReading)
    const parsed = electricityReadingFormSchema.safeParse({
      meterAssignmentId: readingForm.meterAssignmentId,
      readingDate: readingForm.readingDate,
      currentReading,
      notes: readingForm.notes,
    })
    if (!parsed.success) {
      setReadingFormError(parsed.error.issues[0]?.message ?? 'Check the meter reading details.')
      return
    }
    if (selectedAssignment && parsed.data.currentReading <= selectedPreviousReading) {
      setReadingFormError(`Current reading must be higher than the previous reading (${formatReading(selectedPreviousReading)}). Enter a larger value.`)
      return
    }
    setIsSavingReading(true)
    try {
      const billId = await createElectricityBillFromReading(ownerUid, parsed.data)
      const room = selectedAssignment ? roomById.get(selectedAssignment.roomId) : undefined
      const billLabel = `${selectedAssignment?.meterCode ?? 'Meter'} · ${selectedAssignment?.roomCode ?? 'Room'} · ${formatMonth(parsed.data.readingDate.slice(0, 7))}`
      await recordAuditEvent(ownerUid, {
        action: 'bill_issued',
        entityType: 'electricity_bill',
        entityId: billId,
        entityLabel: billLabel,
        summary: `Issued an electricity bill for ${selectedAssignment?.roomCode ?? 'the selected room'}${room?.roomNumber ? ` / Room ${room.roomNumber}` : ''}, reading date ${parsed.data.readingDate}.`,
      })
      setPageSuccess(`Reading saved and electricity bill issued for ${formatMonth(parsed.data.readingDate.slice(0, 7))}. Reference: ${billId}`)
      if (monthFilter !== 'all') setMonthFilter(parsed.data.readingDate.slice(0, 7))
      setReadingForm(emptyReadingForm())
      setIsReadingFormOpen(false)
      await loadData()
    } catch (error: unknown) {
      setReadingFormError(getElectricityErrorMessage(error))
    } finally {
      setIsSavingReading(false)
    }
  }

  const readAssignmentLabel = (assignment: MeterAssignmentRecord) => {
    const room = roomById.get(assignment.roomId)
    const property = propertyById.get(assignment.propertyId)
      ?? (room ? propertyById.get(room.propertyId) : undefined)
    const tenantAssignment = currentTenantByRoomId.get(assignment.roomId)

    const tenantName = tenantAssignment?.tenantName?.trim() || 'No current tenant'
    const roomNumber = room?.roomNumber || tenantAssignment?.roomNumber || assignment.roomCode
    const propertyName = property?.name || assignment.propertyCode

    return `${tenantName} - Room ${roomNumber} - ${propertyName}`
  }

  return (
    <section className="electricity-page">
      <header className="electricity-heading">
        <div>
          <p className="eyebrow">Finance</p>
          <h1>Electricity</h1>
          <p className="page-description">Maintain dated electricity rates and record multiple sequential meter readings, each with its own immutable electricity bill.</p>
        </div>
        <div className="electricity-heading-actions">
          <button className="button button-secondary" type="button" onClick={() => { setPageError(''); setPageSuccess(''); setIsReadingFormOpen(true) }}>
            <Gauge size={17} /> Record reading
          </button>
          <button className="button button-primary" type="button" onClick={() => { setRateFormError(''); setPageError(''); setPageSuccess(''); setRateForm(emptyRateForm()); setIsRateFormOpen(true) }}>
            <Plus size={17} /> Set electricity rate
          </button>
        </div>
      </header>

      {pageError && <div className="electricity-alert electricity-alert--error" role="alert"><X size={17} /><span>{pageError}</span><button type="button" aria-label="Dismiss error" onClick={() => setPageError('')}><X size={16} /></button></div>}
      {pageSuccess && <div className="electricity-alert electricity-alert--success" role="status"><CheckCircle2 size={17} /><span>{pageSuccess}</span><button type="button" aria-label="Dismiss message" onClick={() => setPageSuccess('')}><X size={16} /></button></div>}

      <div className="electricity-stat-grid">
        <article className="electricity-stat-card"><span className="electricity-stat-icon electricity-stat-icon--blue"><FileText size={20} /></span><div><small>Issued bills</small><strong>{monthBills.length}</strong><span>{monthFilter === 'all' ? 'All historical months' : formatMonth(monthFilter)}</span></div></article>
        <article className="electricity-stat-card"><span className="electricity-stat-icon electricity-stat-icon--green"><Activity size={20} /></span><div><small>Recorded readings</small><strong>{monthReadings.length}</strong><span>{monthFilter === 'all' ? 'All historical months' : formatMonth(monthFilter)}</span></div></article>
        <article className="electricity-stat-card"><span className="electricity-stat-icon electricity-stat-icon--purple"><CircleDollarSign size={20} /></span><div><small>Total billed</small><strong>{formatTaka(monthTotalBilledMinor)}</strong><span>{monthFilter === 'all' ? 'All historical issued totals' : `${formatMonth(monthFilter)} total`}</span></div></article>
      </div>

      {isLoading ? (
        <div className="electricity-loading"><LoaderCircle className="electricity-spin" size={25} /><span>Loading electricity records…</span></div>
      ) : (
        <div className="electricity-content-grid">
          <section className="electricity-panel electricity-reading-panel">
            <div className="electricity-panel-heading"><div><h2>Record a reading</h2><p>Save a meter reading and issue its electricity bill.</p></div><span className="electricity-panel-icon"><Gauge size={20} /></span></div>
            <div className="electricity-info-note electricity-reading-note">Readings must be entered in date order and each new reading must be higher than the previous one. Every saved reading creates its own bill.</div>
            {currentAssignments.length === 0 ? <div className="electricity-empty-inline"><Gauge size={24} /><strong>No current meter assignments</strong><p>Assign an available meter to a room in the Meters module before recording readings.</p></div> : <form className="electricity-quick-form electricity-reading-form" onSubmit={handleReadingSubmit}>
              <div className="electricity-field electricity-reading-assignment"><label htmlFor="electricity-assignment">Current meter assignment <span>*</span></label><select id="electricity-assignment" value={readingForm.meterAssignmentId} onChange={(event) => setReadingForm((current) => ({ ...current, meterAssignmentId: event.target.value }))} required><option value="">Select tenant, room and property</option>{currentAssignments.map((assignment) => <option value={assignment.id} key={assignment.id}>{readAssignmentLabel(assignment)}</option>)}</select></div>
              <div className="electricity-field electricity-reading-date"><label htmlFor="electricity-reading-date">Reading date <span>*</span></label><input id="electricity-reading-date" type="date" value={readingForm.readingDate} onChange={(event) => setReadingForm((current) => ({ ...current, readingDate: event.target.value }))} required /></div>
              <div className="electricity-field electricity-reading-current"><label htmlFor="electricity-current-reading">Current meter reading <span>*</span></label><input id="electricity-current-reading" type="number" inputMode="decimal" min={selectedPreviousReading + 0.000001} max="1000000000" step="any" placeholder="e.g. 1250.5" value={readingForm.currentReading} onChange={(event) => setReadingForm((current) => ({ ...current, currentReading: event.target.value }))} required /></div>
              <div className="electricity-preview-grid electricity-reading-preview"><span><small>Previous reading</small><strong>{selectedAssignment ? formatReading(selectedPreviousReading) : '—'}</strong></span><span><small>Applicable rate</small><strong>{selectedRate ? `${formatTaka(selectedRate.pricePerUnitMinor)} / unit${selectedRate.roomId === null ? ' · shared fallback' : ''}` : 'No rate configured for this room'}</strong></span></div>
              <div className="electricity-field electricity-reading-notes"><label htmlFor="electricity-reading-notes">Notes <small>(optional)</small></label><textarea id="electricity-reading-notes" rows={2} maxLength={1000} placeholder="Reading or billing notes" value={readingForm.notes} onChange={(event) => setReadingForm((current) => ({ ...current, notes: event.target.value }))} /></div>
              {readingFormError && <p className="electricity-form-error electricity-reading-error" role="alert">{readingFormError}</p>}
              <button className="button button-primary electricity-full-button electricity-reading-submit" type="submit" disabled={isSavingReading}>{isSavingReading ? <LoaderCircle className="electricity-spin" size={17} /> : <FileText size={17} />}{isSavingReading ? 'Saving reading…' : 'Save reading & issue bill'}</button>
            </form>}
          </section>

          <section className="electricity-panel electricity-rate-history-panel">
            <div className="electricity-panel-heading"><div><h2>Electricity rate history</h2><p>Room-specific rates remain effective until a newer rate is added for that room.</p></div><span className="electricity-panel-icon"><CircleDollarSign size={20} /></span></div>
            {visibleRates.length === 0 ? <div className="electricity-empty-inline"><Zap size={24} /><strong>No custom electricity rates to display</strong><p>Rates set to the default ৳10.00 per unit are hidden here. Other saved rates remain visible.</p><button className="button button-primary" type="button" onClick={() => setIsRateFormOpen(true)}><Plus size={16} /> Add rate</button></div> : <div className="electricity-rate-list">{visibleRates.map((rate) => {
              const room = rate.roomId ? roomById.get(rate.roomId) : undefined
              const tenantAssignment = rate.roomId ? currentTenantByRoomId.get(rate.roomId) : undefined
              const roomNumber = room?.roomNumber || tenantAssignment?.roomNumber || rate.roomCode || 'Unknown'
              const tenantName = tenantAssignment?.tenantName?.trim() || 'No current tenant'
              const roomCode = room?.roomCode || rate.roomCode

              return <article className="electricity-rate-card" key={rate.id}>
                <div>
                  <strong>{rate.roomId ? `Room ${roomNumber}` : 'Legacy shared rate'}</strong>
                  <span>{rate.roomId ? tenantName : 'Fallback for rooms without a specific rate'}</span>
                  <small>{rate.roomId && roomCode ? `${roomCode} · ` : ''}Effective {formatDate(rate.effectiveFrom)}</small>
                  {rate.notes && <small className="electricity-rate-notes">{rate.notes}</small>}
                </div>
                <b>{formatTaka(rate.pricePerUnitMinor)} <small>/ unit</small></b>
              </article>
            })}</div>}
          </section>
        </div>
      )}

      <section className="electricity-panel electricity-bills-panel">
        <div className="electricity-panel-heading"><div><h2>Issued electricity bills</h2><p>Saved readings, rates, and amounts remain historical snapshots.</p></div><span className="electricity-record-count">{filteredBills.length} shown</span></div>
        <div className="electricity-bills-toolbar"><SearchInput value={billSearch} onChange={setBillSearch} placeholder="Search tenant, room, property, or month…" /><label className="electricity-filter-field"><span>Month · summary & bills</span><select value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)}><option value="all">All months · Full history</option>{months.map((month) => <option key={month} value={month}>{formatMonth(month)}</option>)}</select></label><button className="button button-secondary electricity-refresh-button" type="button" onClick={() => void loadData()} disabled={isLoading}><RefreshCw size={16} /> Refresh</button><button className="button button-secondary electricity-report-button" type="button" onClick={() => void handleDownloadElectricityReport()} disabled={isLoading || isDownloadingReport || monthFilter === 'all' || !bills.some((bill) => bill.billingMonth === monthFilter)} title={monthFilter === 'all' ? 'Choose one month to download a monthly report' : 'Download only this month’s issued electricity bills'}>{isDownloadingReport ? <LoaderCircle className="electricity-spin" size={16} /> : <Download size={16} />} {isDownloadingReport ? 'Preparing PDF…' : 'Download PDF'}</button></div>
        {filteredBills.length === 0 ? <div className="electricity-empty-state"><FileText size={28} /><strong>{billSearch.trim() ? 'No matching electricity bills' : monthFilter === 'all' ? 'No electricity bills found' : `No electricity bills for ${formatMonth(monthFilter)}`}</strong><p>{billSearch.trim() ? 'Try a different search term.' : monthFilter !== 'all' && bills.length > 0 ? 'Older bills are saved and have not been removed. Choose another billing month to view them.' : 'Add an electricity rate, select a current meter assignment, and save its meter reading to issue a bill.'}</p></div> : <div className="electricity-bill-list">{filteredBills.map((bill) => <article className="electricity-bill-card" key={bill.id}><div className="electricity-bill-top"><div className="electricity-bill-title"><strong>{billDisplayLabel(bill)}</strong><small>{formatMonth(bill.billingMonth)} · Read {formatDate(bill.readingDate)}</small></div><div className="electricity-bill-amount"><strong>{formatTaka(bill.amountMinor)}</strong><span>Issued</span></div></div><div className="electricity-bill-details"><span><small>Previous</small><b>{formatReading(bill.previousReading)}</b></span><span><small>Current</small><b>{formatReading(bill.currentReading)}</b></span><span><small>Units</small><b>{formatReading(bill.unitsConsumed)}</b></span><span><small>Rate</small><b>{formatTaka(bill.pricePerUnitMinor)} / unit</b></span></div>{bill.notes && <p className="electricity-bill-notes">{bill.notes}</p>}</article>)}</div>}
      </section>

      {isRateFormOpen && <div className="electricity-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSavingRate) setIsRateFormOpen(false) }}><section className="electricity-dialog" role="dialog" aria-modal="true" aria-labelledby="electricity-rate-title"><div className="electricity-dialog-heading"><div><h2 id="electricity-rate-title">Set electricity rate</h2><p>Add an immutable per-unit rate record.</p></div><button className="electricity-icon-button" type="button" aria-label="Close rate form" onClick={() => setIsRateFormOpen(false)} disabled={isSavingRate}><X size={19} /></button></div><form onSubmit={handleRateSubmit}><div className="electricity-field"><label htmlFor="electricity-rate-room">Room <span>*</span></label><select id="electricity-rate-room" value={rateForm.roomId} onChange={(event) => setRateForm((current) => ({ ...current, roomId: event.target.value }))} required><option value="">Select room</option>{selectableRooms.map((room) => { const tenantName = currentTenantByRoomId.get(room.id)?.tenantName?.trim() || 'No current tenant'; const propertyName = propertyById.get(room.propertyId)?.name || room.propertyCode; return <option key={room.id} value={room.id}>{tenantName} - Room {room.roomNumber} - {propertyName}</option> })}</select><small>This rate applies only to the selected room and remains active until a newer rate is set for that room.</small></div><div className="electricity-field"><label htmlFor="electricity-rate-date">Effective from <span>*</span></label><input id="electricity-rate-date" type="date" value={rateForm.effectiveFrom} onChange={(event) => setRateForm((current) => ({ ...current, effectiveFrom: event.target.value }))} required /></div><div className="electricity-field"><label htmlFor="electricity-rate-value">Rate per unit (৳) <span>*</span></label><input id="electricity-rate-value" type="number" min="0.01" max="100000" step="0.01" placeholder="e.g. 12.50" value={rateForm.pricePerUnit} onChange={(event) => setRateForm((current) => ({ ...current, pricePerUnit: event.target.value }))} required /><small>Values are stored in integer poisha for accurate calculations.</small></div><div className="electricity-field"><label htmlFor="electricity-rate-notes">Notes <small>(optional)</small></label><textarea id="electricity-rate-notes" rows={3} maxLength={1000} placeholder="Tariff details or source" value={rateForm.notes} onChange={(event) => setRateForm((current) => ({ ...current, notes: event.target.value }))} /></div>{rateFormError && <p className="electricity-form-error" role="alert">{rateFormError}</p>}<div className="electricity-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setIsRateFormOpen(false)} disabled={isSavingRate}>Cancel</button><button className="button button-primary" type="submit" disabled={isSavingRate}>{isSavingRate ? <LoaderCircle className="electricity-spin" size={17} /> : <Plus size={17} />}{isSavingRate ? 'Saving…' : 'Save rate'}</button></div></form></section></div>}

      {isReadingFormOpen && <div className="electricity-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSavingReading) setIsReadingFormOpen(false) }}><section className="electricity-dialog" role="dialog" aria-modal="true" aria-labelledby="electricity-reading-title"><div className="electricity-dialog-heading"><div><h2 id="electricity-reading-title">Record meter reading</h2><p>A bill is issued atomically with the saved reading.</p></div><button className="electricity-icon-button" type="button" aria-label="Close reading form" onClick={() => setIsReadingFormOpen(false)} disabled={isSavingReading}><X size={19} /></button></div><form onSubmit={handleReadingSubmit}><div className="electricity-field"><label htmlFor="electricity-modal-assignment">Meter assignment <span>*</span></label><select id="electricity-modal-assignment" value={readingForm.meterAssignmentId} onChange={(event) => setReadingForm((current) => ({ ...current, meterAssignmentId: event.target.value }))} required><option value="">Select tenant, room and property</option>{currentAssignments.map((assignment) => <option value={assignment.id} key={assignment.id}>{readAssignmentLabel(assignment)}</option>)}</select></div><div className="electricity-field"><label htmlFor="electricity-modal-date">Reading date <span>*</span></label><input id="electricity-modal-date" type="date" value={readingForm.readingDate} onChange={(event) => setReadingForm((current) => ({ ...current, readingDate: event.target.value }))} required /></div><div className="electricity-field"><label htmlFor="electricity-modal-value">Current reading <span>*</span></label><input id="electricity-modal-value" type="number" inputMode="decimal" min={selectedPreviousReading + 0.000001} step="any" value={readingForm.currentReading} onChange={(event) => setReadingForm((current) => ({ ...current, currentReading: event.target.value }))} required /></div><div className="electricity-field"><label htmlFor="electricity-modal-notes">Notes <small>(optional)</small></label><textarea id="electricity-modal-notes" rows={2} maxLength={1000} value={readingForm.notes} onChange={(event) => setReadingForm((current) => ({ ...current, notes: event.target.value }))} /></div>{readingFormError && <p className="electricity-form-error" role="alert">{readingFormError}</p>}<div className="electricity-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setIsReadingFormOpen(false)} disabled={isSavingReading}>Cancel</button><button className="button button-primary" type="submit" disabled={isSavingReading || currentAssignments.length === 0}>{isSavingReading ? <LoaderCircle className="electricity-spin" size={17} /> : <FileText size={17} />}{isSavingReading ? 'Saving…' : 'Save reading & bill'}</button></div></form></section></div>}
    </section>
  )
}
