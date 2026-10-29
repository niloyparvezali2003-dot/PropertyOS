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
import {
  createElectricityBillFromReading,
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
import './electricity.css'

type ElectricityPageProps = { ownerUid: string }
type RateFormState = { roomId: string; effectiveFrom: string; pricePerUnit: string; notes: string }
type ReadingFormState = { meterAssignmentId: string; readingDate: string; currentReading: string; notes: string }

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
  const [monthFilter, setMonthFilter] = useState('all')

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setPageError('')
    try {
      const [nextRates, nextReadings, nextBills, nextAssignments, nextRooms, nextProperties] = await Promise.all([
        listElectricityRates(ownerUid),
        listElectricityReadings(ownerUid),
        listElectricityBills(ownerUid),
        listMeterAssignments(ownerUid),
        listRooms(ownerUid),
        listProperties(ownerUid),
      ])
      setRates(nextRates)
      setReadings(nextReadings)
      setBills(nextBills)
      setAssignments(nextAssignments)
      setRooms(nextRooms)
      setProperties(nextProperties)
    } catch (error: unknown) {
      setPageError(getElectricityErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => { void loadData() }, [loadData])

  const currentAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.status === 'current').sort((a, b) => a.roomCode.localeCompare(b.roomCode)),
    [assignments],
  )
  const roomById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms])
  const propertyById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties])
  const selectableRooms = useMemo(
    () => [...rooms].sort((a, b) => a.roomCode.localeCompare(b.roomCode)),
    [rooms],
  )
  const months = useMemo(() => [...new Set(bills.map((bill) => bill.billingMonth))].sort().reverse(), [bills])
  const filteredBills = useMemo(() => {
    const term = billSearch.trim().toLowerCase()
    return bills.filter((bill) => {
      if (monthFilter !== 'all' && bill.billingMonth !== monthFilter) return false
      if (!term) return true
      return [bill.meterCode, bill.roomCode, bill.propertyCode, bill.billingMonth, bill.readingDate].join(' ').toLowerCase().includes(term)
    })
  }, [billSearch, bills, monthFilter])
  const selectedAssignment = currentAssignments.find((assignment) => assignment.id === readingForm.meterAssignmentId)
  const selectedRate = selectedAssignment
    ? getApplicableRate(rates, selectedAssignment.roomId, readingForm.readingDate)
    : undefined
  const totalBilledMinor = bills.reduce((sum, bill) => sum + bill.amountMinor, 0)

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
      setReadingForm(emptyReadingForm())
      setIsReadingFormOpen(false)
      await loadData()
    } catch (error: unknown) {
      setReadingFormError(getElectricityErrorMessage(error))
    } finally {
      setIsSavingReading(false)
    }
  }

  const readRoomLabel = (assignment: MeterAssignmentRecord) => {
    const room = roomById.get(assignment.roomId)
    const property = room ? propertyById.get(room.propertyId) : undefined
    return `${assignment.roomCode} · ${room?.roomNumber ?? ''}${property ? ` — ${property.name}` : ''}`
  }

  return (
    <section className="electricity-page">
      <header className="electricity-heading">
        <div>
          <p className="eyebrow">FINANCE</p>
          <h1>Electricity</h1>
          <p className="page-description">Maintain dated electricity rates, record meter readings, and issue immutable monthly electricity bills.</p>
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
        <article className="electricity-stat-card"><span className="electricity-stat-icon electricity-stat-icon--blue"><FileText size={20} /></span><div><small>Issued bills</small><strong>{bills.length}</strong><span>Saved monthly snapshots</span></div></article>
        <article className="electricity-stat-card"><span className="electricity-stat-icon electricity-stat-icon--green"><Activity size={20} /></span><div><small>Recorded readings</small><strong>{readings.length}</strong><span>Immutable reading records</span></div></article>
        <article className="electricity-stat-card"><span className="electricity-stat-icon electricity-stat-icon--purple"><CircleDollarSign size={20} /></span><div><small>Total billed</small><strong>{formatTaka(totalBilledMinor)}</strong><span>Historical issued totals</span></div></article>
      </div>

      {isLoading ? (
        <div className="electricity-loading"><LoaderCircle className="electricity-spin" size={25} /><span>Loading electricity records…</span></div>
      ) : (
        <div className="electricity-content-grid">
          <section className="electricity-panel">
            <div className="electricity-panel-heading"><div><h2>Electricity rate history</h2><p>Each room has its own effective-dated rate. A rate stays active until a newer rate is added for that room.</p></div><span className="electricity-panel-icon"><CircleDollarSign size={20} /></span></div>
            {rates.length === 0 ? <div className="electricity-empty-inline"><Zap size={24} /><strong>No electricity rates yet</strong><p>Add a rate effective on or before the date you record a reading.</p><button className="button button-primary" type="button" onClick={() => setIsRateFormOpen(true)}><Plus size={16} /> Add first rate</button></div> : <div className="electricity-rate-list">{rates.map((rate) => <article className="electricity-rate-card" key={rate.id}><div><strong>{rate.roomId ? `${rate.roomCode ?? roomById.get(rate.roomId)?.roomCode ?? 'Room'}${roomById.get(rate.roomId)?.roomNumber ? ` · ${roomById.get(rate.roomId)?.roomNumber}` : ''}` : 'Legacy shared rate'}</strong><span>Effective {formatDate(rate.effectiveFrom)}{rate.roomId === null ? ' · fallback for rooms without a specific rate' : ''}</span>{rate.notes && <small>{rate.notes}</small>}</div><b>{formatTaka(rate.pricePerUnitMinor)} <small>/ unit</small></b></article>)}</div>}
          </section>

          <section className="electricity-panel">
            <div className="electricity-panel-heading"><div><h2>Record a reading</h2><p>Saving a reading also issues its bill in one transaction.</p></div><span className="electricity-panel-icon"><Gauge size={20} /></span></div>
            <div className="electricity-info-note">The first bill compares against the meter assignment’s initial reading. Later bills compare against the latest saved reading. Each room uses its own rate history; existing shared rates remain only as a fallback until a room-specific rate is entered.</div>
            {currentAssignments.length === 0 ? <div className="electricity-empty-inline"><Gauge size={24} /><strong>No current meter assignments</strong><p>Assign an available meter to a room in the Meters module before recording readings.</p></div> : <form className="electricity-quick-form" onSubmit={handleReadingSubmit}>
              <div className="electricity-field"><label htmlFor="electricity-assignment">Current meter assignment <span>*</span></label><select id="electricity-assignment" value={readingForm.meterAssignmentId} onChange={(event) => setReadingForm((current) => ({ ...current, meterAssignmentId: event.target.value }))} required><option value="">Select meter and room</option>{currentAssignments.map((assignment) => <option value={assignment.id} key={assignment.id}>{assignment.meterCode} · {readRoomLabel(assignment)}</option>)}</select></div>
              <div className="electricity-field-grid"><div className="electricity-field"><label htmlFor="electricity-reading-date">Reading date <span>*</span></label><input id="electricity-reading-date" type="date" value={readingForm.readingDate} onChange={(event) => setReadingForm((current) => ({ ...current, readingDate: event.target.value }))} required /></div><div className="electricity-field"><label htmlFor="electricity-current-reading">Current meter reading <span>*</span></label><input id="electricity-current-reading" type="number" inputMode="decimal" min="0" max="1000000000" step="any" placeholder="e.g. 1250.5" value={readingForm.currentReading} onChange={(event) => setReadingForm((current) => ({ ...current, currentReading: event.target.value }))} required /></div></div>
              <div className="electricity-preview-grid"><span><small>Previous reading</small><strong>{selectedAssignment ? formatReading(readings.find((item) => item.meterAssignmentId === selectedAssignment.id)?.currentReading ?? selectedAssignment.initialReading) : '—'}</strong></span><span><small>Applicable rate</small><strong>{selectedRate ? `${formatTaka(selectedRate.pricePerUnitMinor)} / unit${selectedRate.roomId === null ? ' · legacy fallback' : ''}` : 'No rate configured for this room'}</strong></span></div>
              <div className="electricity-field"><label htmlFor="electricity-reading-notes">Notes <small>(optional)</small></label><textarea id="electricity-reading-notes" rows={2} maxLength={1000} placeholder="Reading or billing notes" value={readingForm.notes} onChange={(event) => setReadingForm((current) => ({ ...current, notes: event.target.value }))} /></div>
              {readingFormError && <p className="electricity-form-error" role="alert">{readingFormError}</p>}
              <button className="button button-primary electricity-full-button" type="submit" disabled={isSavingReading}>{isSavingReading ? <LoaderCircle className="electricity-spin" size={17} /> : <FileText size={17} />}{isSavingReading ? 'Saving reading…' : 'Save reading & issue bill'}</button>
            </form>}
          </section>
        </div>
      )}

      <section className="electricity-panel electricity-bills-panel">
        <div className="electricity-panel-heading"><div><h2>Issued electricity bills</h2><p>Saved readings, rates, and amounts remain historical snapshots.</p></div><span className="electricity-record-count">{filteredBills.length} shown</span></div>
        <div className="electricity-bills-toolbar"><SearchInput value={billSearch} onChange={setBillSearch} placeholder="Search meter, room, or month…" /><label className="electricity-filter-field"><span>Month</span><select value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)}><option value="all">All months</option>{months.map((month) => <option key={month} value={month}>{formatMonth(month)}</option>)}</select></label><button className="button button-secondary electricity-refresh-button" type="button" onClick={() => void loadData()} disabled={isLoading}><RefreshCw size={16} /> Refresh</button></div>
        {filteredBills.length === 0 ? <div className="electricity-empty-state"><FileText size={28} /><strong>No electricity bills yet</strong><p>Add an electricity rate, select a current meter assignment, and save its meter reading to issue a bill.</p></div> : <div className="electricity-bill-list">{filteredBills.map((bill) => <article className="electricity-bill-card" key={bill.id}><div className="electricity-bill-top"><div className="electricity-bill-title"><strong>{bill.meterCode} <span>· {bill.roomCode}</span></strong><small>{formatMonth(bill.billingMonth)} · Read {formatDate(bill.readingDate)}</small></div><div className="electricity-bill-amount"><strong>{formatTaka(bill.amountMinor)}</strong><span>Issued</span></div></div><div className="electricity-bill-details"><span><small>Previous</small><b>{formatReading(bill.previousReading)}</b></span><span><small>Current</small><b>{formatReading(bill.currentReading)}</b></span><span><small>Units</small><b>{formatReading(bill.unitsConsumed)}</b></span><span><small>Rate</small><b>{formatTaka(bill.pricePerUnitMinor)} / unit</b></span></div>{bill.notes && <p className="electricity-bill-notes">{bill.notes}</p>}</article>)}</div>}
      </section>

      {isRateFormOpen && <div className="electricity-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSavingRate) setIsRateFormOpen(false) }}><section className="electricity-dialog" role="dialog" aria-modal="true" aria-labelledby="electricity-rate-title"><div className="electricity-dialog-heading"><div><h2 id="electricity-rate-title">Set electricity rate</h2><p>Add an immutable per-unit rate record.</p></div><button className="electricity-icon-button" type="button" aria-label="Close rate form" onClick={() => setIsRateFormOpen(false)} disabled={isSavingRate}><X size={19} /></button></div><form onSubmit={handleRateSubmit}><div className="electricity-field"><label htmlFor="electricity-rate-room">Room <span>*</span></label><select id="electricity-rate-room" value={rateForm.roomId} onChange={(event) => setRateForm((current) => ({ ...current, roomId: event.target.value }))} required><option value="">Select room</option>{selectableRooms.map((room) => { const property = propertyById.get(room.propertyId); return <option key={room.id} value={room.id}>{room.roomCode} · {room.roomNumber}{property ? ` — ${property.name}` : ''}</option> })}</select><small>This rate applies only to the selected room and remains active until a newer rate is set for that room.</small></div><div className="electricity-field"><label htmlFor="electricity-rate-date">Effective from <span>*</span></label><input id="electricity-rate-date" type="date" value={rateForm.effectiveFrom} onChange={(event) => setRateForm((current) => ({ ...current, effectiveFrom: event.target.value }))} required /></div><div className="electricity-field"><label htmlFor="electricity-rate-value">Rate per unit (৳) <span>*</span></label><input id="electricity-rate-value" type="number" min="0.01" max="100000" step="0.01" placeholder="e.g. 12.50" value={rateForm.pricePerUnit} onChange={(event) => setRateForm((current) => ({ ...current, pricePerUnit: event.target.value }))} required /><small>Values are stored in integer poisha for accurate calculations.</small></div><div className="electricity-field"><label htmlFor="electricity-rate-notes">Notes <small>(optional)</small></label><textarea id="electricity-rate-notes" rows={3} maxLength={1000} placeholder="Tariff details or source" value={rateForm.notes} onChange={(event) => setRateForm((current) => ({ ...current, notes: event.target.value }))} /></div>{rateFormError && <p className="electricity-form-error" role="alert">{rateFormError}</p>}<div className="electricity-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setIsRateFormOpen(false)} disabled={isSavingRate}>Cancel</button><button className="button button-primary" type="submit" disabled={isSavingRate}>{isSavingRate ? <LoaderCircle className="electricity-spin" size={17} /> : <Plus size={17} />}{isSavingRate ? 'Saving…' : 'Save rate'}</button></div></form></section></div>}

      {isReadingFormOpen && <div className="electricity-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSavingReading) setIsReadingFormOpen(false) }}><section className="electricity-dialog" role="dialog" aria-modal="true" aria-labelledby="electricity-reading-title"><div className="electricity-dialog-heading"><div><h2 id="electricity-reading-title">Record meter reading</h2><p>A bill is issued atomically with the saved reading.</p></div><button className="electricity-icon-button" type="button" aria-label="Close reading form" onClick={() => setIsReadingFormOpen(false)} disabled={isSavingReading}><X size={19} /></button></div><form onSubmit={handleReadingSubmit}><div className="electricity-field"><label htmlFor="electricity-modal-assignment">Meter assignment <span>*</span></label><select id="electricity-modal-assignment" value={readingForm.meterAssignmentId} onChange={(event) => setReadingForm((current) => ({ ...current, meterAssignmentId: event.target.value }))} required><option value="">Select meter and room</option>{currentAssignments.map((assignment) => <option value={assignment.id} key={assignment.id}>{assignment.meterCode} · {readRoomLabel(assignment)}</option>)}</select></div><div className="electricity-field"><label htmlFor="electricity-modal-date">Reading date <span>*</span></label><input id="electricity-modal-date" type="date" value={readingForm.readingDate} onChange={(event) => setReadingForm((current) => ({ ...current, readingDate: event.target.value }))} required /></div><div className="electricity-field"><label htmlFor="electricity-modal-value">Current reading <span>*</span></label><input id="electricity-modal-value" type="number" inputMode="decimal" min="0" step="any" value={readingForm.currentReading} onChange={(event) => setReadingForm((current) => ({ ...current, currentReading: event.target.value }))} required /></div><div className="electricity-field"><label htmlFor="electricity-modal-notes">Notes <small>(optional)</small></label><textarea id="electricity-modal-notes" rows={2} maxLength={1000} value={readingForm.notes} onChange={(event) => setReadingForm((current) => ({ ...current, notes: event.target.value }))} /></div>{readingFormError && <p className="electricity-form-error" role="alert">{readingFormError}</p>}<div className="electricity-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setIsReadingFormOpen(false)} disabled={isSavingReading}>Cancel</button><button className="button button-primary" type="submit" disabled={isSavingReading || currentAssignments.length === 0}>{isSavingReading ? <LoaderCircle className="electricity-spin" size={17} /> : <FileText size={17} />}{isSavingReading ? 'Saving…' : 'Save reading & bill'}</button></div></form></section></div>}
    </section>
  )
}
