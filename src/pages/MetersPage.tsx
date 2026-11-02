import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type FormEvent,
} from 'react'

import {
    ArrowLeftRight,
    AlertTriangle,
    Gauge,
    LoaderCircle,
    Pencil,
    Plus,
    RefreshCw,
    X,
    UserRound,
    Zap,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { recordAuditEvent } from '../services/firebase/audit'
import {
    createMeter,
    assignMeter,
    correctMeterRoomAssignment,
    cancelMistakenMeter,
    listMeters,
    listMeterAssignments,
    replaceMeter,
    getMeterErrorMessage,
    type MeterRecord,
    type MeterAssignmentRecord,
} from '../services/firebase/meters'
import { listRooms, type RoomRecord } from '../services/firebase/rooms'
import {
    listTenantAssignments,
    type TenantAssignmentRecord,
} from '../services/firebase/tenantAssignments'
import {
    listProperties,
    type PropertyRecord,
} from '../services/firebase/properties'
import { compareTenantNames } from '../utils/tenantNameSort'
import './meters-safety.css'
import type {
    MeterFormValues,
    MeterAssignmentFormValues,
    MeterReplacementFormValues,
    MeterStatus,
} from '../schemas/meter'

type MetersPageProps = {
    ownerUid: string
}

type DialogMode = 'create' | 'assign' | 'correct' | 'cancel' | 'replace' | null

function getToday(): string {
    const date = new Date()
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')

    return `${year}-${month}-${day}`
}

const emptyMeterForm: MeterFormValues = {
    serialNumber: '',
    notes: '',
}

function emptyAssignmentForm(): MeterAssignmentFormValues {
    return {
        roomId: '',
        assignedOn: getToday(),
        initialReading: 0,
    }
}

function emptyReplacementForm(): MeterReplacementFormValues {
    return {
        replacementDate: getToday(),
        finalReading: 0,
        newInitialReading: 0,
        reason: 'damaged',
        newSerialNumber: '',
        notes: '',
    }
}

const meterStatusLabels: Record<MeterStatus, string> = {
    available: 'Unassigned',
    assigned: 'Assigned',
    retired: 'Retired',
    voided: 'Cancelled',
}

const replacementReasonLabels = {
    damaged: 'Damaged',
    overreading: 'Overreading',
    slow_reading: 'Slow reading',
    other: 'Other',
}

const meterStatusFilters: Array<{ value: 'all' | MeterStatus; label: string }> = [
    { value: 'all', label: 'All meters' },
    { value: 'assigned', label: 'Assigned' },
    { value: 'available', label: 'Unassigned' },
    { value: 'retired', label: 'Retired' },
    { value: 'voided', label: 'Cancelled' },
]

export function MetersPage({ ownerUid }: MetersPageProps) {
    const [meters, setMeters] = useState<MeterRecord[]>([])
    const [assignments, setAssignments] =
        useState<MeterAssignmentRecord[]>([])
    const [rooms, setRooms] = useState<RoomRecord[]>([])
    const [tenantAssignments, setTenantAssignments] =
        useState<TenantAssignmentRecord[]>([])
    const [properties, setProperties] = useState<PropertyRecord[]>([])

    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] =
        useState<'all' | MeterStatus>('all')

    const [isLoading, setIsLoading] = useState(true)
    const [pageError, setPageError] = useState('')
    const [dialogMode, setDialogMode] = useState<DialogMode>(null)
    const [selectedMeter, setSelectedMeter] =
        useState<MeterRecord | null>(null)
    const [selectedAssignment, setSelectedAssignment] =
        useState<MeterAssignmentRecord | null>(null)
    const [correctionRoomId, setCorrectionRoomId] = useState('')
    const [processStep, setProcessStep] = useState<'details' | 'review'>('details')
    const [processReason, setProcessReason] = useState('')
    const [processAcknowledged, setProcessAcknowledged] = useState(false)
    const [confirmationText, setConfirmationText] = useState('')

    const [meterForm, setMeterForm] =
        useState<MeterFormValues>(emptyMeterForm)
    const [assignmentForm, setAssignmentForm] =
        useState<MeterAssignmentFormValues>(emptyAssignmentForm())
    const [replacementForm, setReplacementForm] =
        useState<MeterReplacementFormValues>(emptyReplacementForm())

    const [formError, setFormError] = useState('')
    const [isSaving, setIsSaving] = useState(false)

    const loadData = useCallback(async () => {
        setIsLoading(true)
        setPageError('')

        try {
            const [
                nextMeters,
                nextAssignments,
                nextRooms,
                nextTenantAssignments,
                nextProperties,
            ] = await Promise.all([
                listMeters(ownerUid),
                listMeterAssignments(ownerUid),
                listRooms(ownerUid),
                listTenantAssignments(ownerUid),
                listProperties(ownerUid),
            ])

            setMeters(nextMeters)
            setAssignments(nextAssignments)
            setRooms(nextRooms)
            setTenantAssignments(nextTenantAssignments)
            setProperties(nextProperties)
        } catch (error: unknown) {
            setPageError(getMeterErrorMessage(error))
        } finally {
            setIsLoading(false)
        }
    }, [ownerUid])

    useEffect(() => {
        void loadData()
    }, [loadData])

    const roomById = useMemo(
        () => new Map(rooms.map((room) => [room.id, room])),
        [rooms],
    )

    const propertyById = useMemo(
        () => new Map(properties.map((property) => [property.id, property])),
        [properties],
    )

    const currentTenantAssignmentByRoom = useMemo(() => {
        const map = new Map<string, TenantAssignmentRecord>()

        for (const tenantAssignment of tenantAssignments) {
            if (
                tenantAssignment.status === 'current' &&
                !map.has(tenantAssignment.roomId)
            ) {
                map.set(tenantAssignment.roomId, tenantAssignment)
            }
        }

        return map
    }, [tenantAssignments])

    const currentAssignmentByMeter = useMemo(() => {
        const map = new Map<string, MeterAssignmentRecord>()

        for (const assignment of assignments) {
            if (assignment.status === 'current') {
                map.set(assignment.meterId, assignment)
            }
        }

        return map
    }, [assignments])

    const latestAssignmentByMeter = useMemo(() => {
        const map = new Map<string, MeterAssignmentRecord>()

        for (const assignment of assignments) {
            if (!map.has(assignment.meterId)) {
                map.set(assignment.meterId, assignment)
            }
        }

        return map
    }, [assignments])

    const assignedRoomIds = useMemo(
        () =>
            new Set(
                assignments
                    .filter((assignment) => assignment.status === 'current')
                    .map((assignment) => assignment.roomId),
            ),
        [assignments],
    )

    const assignableRooms = useMemo(
        () =>
            rooms
                .filter(
                    (room) =>
                        room.status !== 'inactive' &&
                        !assignedRoomIds.has(room.id) &&
                        propertyById.get(room.propertyId)?.status === 'active',
                )
                .sort((left, right) =>
                    compareTenantNames(
                        currentTenantAssignmentByRoom.get(left.id)?.tenantName,
                        currentTenantAssignmentByRoom.get(right.id)?.tenantName,
                    ),
                ),
        [rooms, assignedRoomIds, propertyById, currentTenantAssignmentByRoom],
    )

    const meterStatusCounts = useMemo(() => {
        const counts: Record<MeterStatus, number> = {
            available: 0,
            assigned: 0,
            retired: 0,
            voided: 0,
        }

        for (const meter of meters) {
            counts[meter.status] += 1
        }

        return counts
    }, [meters])

    const filteredMeters = useMemo(() => {
        const query = search.trim().toLowerCase()

        return meters.filter((meter) => {
            if (statusFilter !== 'all' && meter.status !== statusFilter) {
                return false
            }

            const current = currentAssignmentByMeter.get(meter.id)
            const latest = latestAssignmentByMeter.get(meter.id)
            const assignment = current ?? latest

            const room = assignment
                ? roomById.get(assignment.roomId)
                : undefined

            const property = assignment
                ? propertyById.get(assignment.propertyId)
                : undefined

            if (!query) return true

            return [
                meter.meterCode,
                meter.serialNumber,
                meter.notes,
                meterStatusLabels[meter.status],
                assignment?.roomCode ?? '',
                room?.roomNumber ?? '',
                room?.floorName ?? '',
                (assignment && current
                    ? currentTenantAssignmentByRoom.get(assignment.roomId)?.tenantName
                    : '') ?? '',
                (assignment && current
                    ? currentTenantAssignmentByRoom.get(assignment.roomId)?.tenantCode
                    : '') ?? '',
                property?.name ?? '',
                property?.propertyCode ?? '',
            ]
                .join(' ')
                .toLowerCase()
                .includes(query)
        })
    }, [
        meters,
        search,
        statusFilter,
        currentAssignmentByMeter,
        latestAssignmentByMeter,
        roomById,
        propertyById,
        currentTenantAssignmentByRoom,
    ])

    function openCreateDialog() {
        setSelectedMeter(null)
        setSelectedAssignment(null)
        setMeterForm({ ...emptyMeterForm })
        setFormError('')
        setDialogMode('create')
    }

    function openAssignDialog(meter: MeterRecord) {
        setSelectedMeter(meter)
        setSelectedAssignment(null)
        setAssignmentForm({
            ...emptyAssignmentForm(),
            roomId: assignableRooms[0]?.id ?? '',
        })
        setFormError('')
        setDialogMode('assign')
    }

    function openReplaceDialog(meter: MeterRecord) {
        setSelectedMeter(meter)
        setSelectedAssignment(null)
        setReplacementForm(emptyReplacementForm())
        setFormError('')
        setDialogMode('replace')
    }

    function openCorrectRoomDialog(meter: MeterRecord, assignment: MeterAssignmentRecord) {
        setSelectedMeter(meter)
        setSelectedAssignment(assignment)
        setCorrectionRoomId(assignableRooms[0]?.id ?? '')
        setProcessStep('details')
        setProcessReason('')
        setProcessAcknowledged(false)
        setConfirmationText('')
        setFormError('')
        setDialogMode('correct')
    }

    function openCancelMeterDialog(meter: MeterRecord, assignment: MeterAssignmentRecord) {
        setSelectedMeter(meter)
        setSelectedAssignment(assignment)
        setProcessStep('details')
        setProcessReason('')
        setProcessAcknowledged(false)
        setConfirmationText('')
        setFormError('')
        setDialogMode('cancel')
    }

    function closeDialog() {
        if (isSaving) return

        setDialogMode(null)
        setSelectedMeter(null)
        setSelectedAssignment(null)
        setCorrectionRoomId('')
        setProcessStep('details')
        setProcessReason('')
        setProcessAcknowledged(false)
        setConfirmationText('')
        setFormError('')
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()

        if (isSaving || !dialogMode) return

        setFormError('')
        setIsSaving(true)

        try {
            if (dialogMode === 'create') {
                const meterId = await createMeter(ownerUid, meterForm)
                await recordAuditEvent(ownerUid, {
                    action: 'created',
                    entityType: 'meter',
                    entityId: meterId,
                    entityLabel: meterForm.serialNumber.trim() || 'New meter',
                    summary: `Registered a meter with serial number ${meterForm.serialNumber.trim()}.`,
                })
            } else if (dialogMode === 'assign') {
                if (!selectedMeter) {
                    throw new Error('Select a meter before assigning it.')
                }

                const assignmentId = await assignMeter(
                    ownerUid,
                    selectedMeter.id,
                    assignmentForm,
                )
                const targetRoom = rooms.find((room) => room.id === assignmentForm.roomId)
                const roomLabel = targetRoom ? `Room ${targetRoom.roomNumber}` : 'selected room'
                await recordAuditEvent(ownerUid, {
                    action: 'assigned',
                    entityType: 'meter_assignment',
                    entityId: assignmentId,
                    entityLabel: `${selectedMeter.serialNumber.trim() || 'Meter'} → ${roomLabel}`,
                    summary: `Assigned meter ${selectedMeter.serialNumber.trim() || 'meter'} to ${roomLabel} from ${assignmentForm.assignedOn}.`,
                })
            } else if (dialogMode === 'correct' || dialogMode === 'cancel') {
                if (!selectedMeter || !selectedAssignment) {
                    throw new Error('The selected meter assignment is unavailable. Close this window and refresh the meter list.')
                }
                if (processStep === 'details') {
                    if (processReason.trim().length < 10) {
                        throw new Error('Enter a reason with at least 10 characters before reviewing this action.')
                    }
                    if (dialogMode === 'correct' && !correctionRoomId) {
                        throw new Error('Select the correct room before reviewing this action.')
                    }
                    setProcessAcknowledged(false)
                    setConfirmationText('')
                    setProcessStep('review')
                    return
                }

                const requiredPhrase = `${dialogMode === 'cancel' ? 'CANCEL' : 'CORRECT'} ${selectedMeter.meterCode}`
                if (!processAcknowledged || confirmationText.trim().toUpperCase() !== requiredPhrase) {
                    throw new Error(`Review the details, tick the confirmation box, and type ${requiredPhrase} exactly to continue.`)
                }

                if (dialogMode === 'correct') {
                    const correctedAssignmentId = await correctMeterRoomAssignment(
                        ownerUid,
                        selectedMeter.id,
                        selectedAssignment,
                        correctionRoomId,
                        processReason,
                    )
                    const targetRoom = rooms.find((room) => room.id === correctionRoomId)
                    const oldRoom = rooms.find((room) => room.id === selectedAssignment.roomId)
                    const targetLabel = targetRoom ? `Room ${targetRoom.roomNumber}` : 'the selected room'
                    const oldLabel = oldRoom ? `Room ${oldRoom.roomNumber}` : selectedAssignment.roomCode
                    await recordAuditEvent(ownerUid, {
                        action: 'updated',
                        entityType: 'meter_assignment',
                        entityId: correctedAssignmentId,
                        entityLabel: `${selectedMeter.meterCode} → ${targetLabel}`,
                        summary: `Corrected meter ${selectedMeter.meterCode} from ${oldLabel} to ${targetLabel} before any readings or bills were saved. The same meter ID and initial reading were retained. Reason: ${processReason.trim()}`,
                    })
                } else {
                    await cancelMistakenMeter(
                        ownerUid,
                        selectedMeter.id,
                        selectedAssignment,
                        processReason,
                    )
                    const oldRoom = rooms.find((room) => room.id === selectedAssignment.roomId)
                    const oldLabel = oldRoom ? `Room ${oldRoom.roomNumber}` : selectedAssignment.roomCode
                    await recordAuditEvent(ownerUid, {
                        action: 'updated',
                        entityType: 'meter',
                        entityId: selectedMeter.id,
                        entityLabel: `${selectedMeter.meterCode} cancelled`,
                        summary: `Cancelled mistaken meter ${selectedMeter.meterCode}, previously assigned to ${oldLabel}. The meter ID and assignment history were retained, active room links were removed, and no readings or bills existed. Reason: ${processReason.trim()}`,
                    })
                }
            } else {
                if (!selectedMeter) {
                    throw new Error('Select a meter before replacing it.')
                }

                const newMeterId = await replaceMeter(
                    ownerUid,
                    selectedMeter.id,
                    replacementForm,
                )
                await recordAuditEvent(ownerUid, {
                    action: 'replaced',
                    entityType: 'meter',
                    entityId: newMeterId,
                    entityLabel: `${selectedMeter.serialNumber.trim() || 'Meter'} replacement`,
                    summary: `Replaced ${selectedMeter.serialNumber.trim() || 'meter'} with serial number ${replacementForm.newSerialNumber.trim()}. Reason: ${replacementReasonLabels[replacementForm.reason]}.`,
                })
            }

            setDialogMode(null)
            setSelectedMeter(null)
            setSelectedAssignment(null)
            setCorrectionRoomId('')
            setProcessStep('details')
            setProcessReason('')
            setProcessAcknowledged(false)
            setConfirmationText('')

            await loadData()
        } catch (error: unknown) {
            setFormError(getMeterErrorMessage(error))
        } finally {
            setIsSaving(false)
        }
    }

    function updateMeterField<K extends keyof MeterFormValues>(
        field: K,
        value: MeterFormValues[K],
    ) {
        setMeterForm((current) => ({ ...current, [field]: value }))
    }

    function updateAssignmentField<
        K extends keyof MeterAssignmentFormValues,
    >(
        field: K,
        value: MeterAssignmentFormValues[K],
    ) {
        setAssignmentForm((current) => ({
            ...current,
            [field]: value,
        }))
    }

    function updateReplacementField<
        K extends keyof MeterReplacementFormValues,
    >(
        field: K,
        value: MeterReplacementFormValues[K],
    ) {
        setReplacementForm((current) => ({
            ...current,
            [field]: value,
        }))
    }

    return (
        <>
            <header className="page-heading">
                <div>
                    <p className="eyebrow">Property management</p>
                    <h1>Meters</h1>
                    <p className="page-description">
                        Manage registered meters, room assignments, and replacements.
                    </p>
                </div>

                <button
                    className="button button-primary"
                    type="button"
                    onClick={openCreateDialog}
                >
                    <Plus size={18} aria-hidden="true" />
                    Add meter
                </button>
            </header>

            <nav className="meter-status-overview" aria-label="Filter meters by status">
                {meterStatusFilters.map((filter) => {
                    const count = filter.value === 'all'
                        ? meters.length
                        : meterStatusCounts[filter.value]

                    return (
                        <button
                            className={`meter-status-filter${statusFilter === filter.value ? ' is-active' : ''}`}
                            type="button"
                            key={filter.value}
                            aria-pressed={statusFilter === filter.value}
                            onClick={() => setStatusFilter(filter.value)}
                        >
                            <span>{filter.label}</span>
                            <strong>{count}</strong>
                        </button>
                    )
                })}
            </nav>

            <label className="meter-status-mobile" htmlFor="meter-status-mobile-select">
                <span>Filter by status</span>
                <select
                    id="meter-status-mobile-select"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value as 'all' | MeterStatus)}
                >
                    {meterStatusFilters.map((filter) => {
                        const count = filter.value === 'all'
                            ? meters.length
                            : meterStatusCounts[filter.value]
                        return (
                            <option key={filter.value} value={filter.value}>
                                {filter.label} ({count})
                            </option>
                        )
                    })}
                </select>
            </label>

            <section className="meters-toolbar">
                <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search meters, rooms, or serial numbers..."
                />
                <span className="meters-count">
                    {filteredMeters.length} of {meters.length} shown
                </span>
            </section>

            {pageError && (
                <div className="properties-error" role="alert">
                    <p>{pageError}</p>
                    <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => void loadData()}
                    >
                        Retry
                    </button>
                </div>
            )}

            {isLoading ? (
                <div className="properties-state" role="status">
                    <LoaderCircle size={22} aria-hidden="true" />
                    <p>Loading meters...</p>
                </div>
            ) : filteredMeters.length === 0 ? (
                <section className="properties-empty">
                    <span className="properties-empty-icon">
                        <Gauge size={25} aria-hidden="true" />
                    </span>
                    <h2>
                        {meters.length === 0
                            ? 'No meters yet'
                            : 'No matching meters'}
                    </h2>
                    <p>
                        {meters.length === 0
                            ? 'Register a meter first. You can assign it to a room now or later.'
                            : 'Try another search term or status filter.'}
                    </p>

                    {meters.length === 0 && (
                        <button
                            className="button button-primary"
                            type="button"
                            onClick={openCreateDialog}
                        >
                            <Plus size={17} aria-hidden="true" />
                            Add first meter
                        </button>
                    )}
                </section>
            ) : (
                <section className="meters-grid" aria-label="Meters">
                    {filteredMeters.map((meter) => {
                        const current = currentAssignmentByMeter.get(meter.id)
                        const latest = latestAssignmentByMeter.get(meter.id)
                        const assignment = current ?? latest

                        const room = assignment
                            ? roomById.get(assignment.roomId)
                            : undefined

                        const currentTenant = current
                            ? currentTenantAssignmentByRoom.get(current.roomId)
                            : undefined

                        const property = assignment
                            ? propertyById.get(assignment.propertyId)
                            : undefined

                        return (
                            <article className="meter-card" key={meter.id}>
                                <div className="meter-card-heading">
                                    <span className="meter-card-icon">
                                        <Zap size={21} aria-hidden="true" />
                                    </span>

                                    <span className={`meter-status meter-status--${meter.status}`}>
                                        {meterStatusLabels[meter.status]}
                                    </span>
                                </div>

                                <div className="meter-title-row">
                                    <h2>{meter.serialNumber || 'No serial number'}</h2>
                                </div>

                                {current ? (
                                    <div className="meter-assignment-summary">
                                        <strong>Current room</strong>
                                        <div
                                            className="room-tenant-name"
                                            title={currentTenant?.tenantName ?? 'No current tenant assigned'}
                                        >
                                            <UserRound size={13} aria-hidden="true" />
                                            <span>
                                                {currentTenant?.tenantName ?? 'No current tenant assigned'}
                                            </span>
                                        </div>
                                        <span>
                                            {room
                                                ? `Room ${room.roomNumber}`
                                                : 'Room details unavailable'}
                                        </span>
                                        <small>
                                            {property
                                                ? `${property.propertyCode} · ${property.name}`
                                                : 'Property details unavailable'}
                                        </small>
                                        <small>
                                            {room?.floorName ?? 'Floor unavailable'}
                                        </small>
                                    </div>
                                ) : latest ? (
                                    <div className="meter-assignment-summary">
                                        <strong>Previous room</strong>
                                        <span>
                                            {room ? `Room ${room.roomNumber}` : 'Room details unavailable'}
                                        </span>
                                        <small>
                                            {latest.endedOn
                                                ? `Assignment ended ${latest.endedOn}`
                                                : 'No current assignment'}
                                        </small>
                                    </div>
                                ) : (
                                    <p className="meter-unassigned">
                                        Not assigned to a room
                                    </p>
                                )}

                                {meter.notes && (
                                    <p className="meter-notes">{meter.notes}</p>
                                )}

                                <div className="meter-card-footer">
                                    <span className="meter-history-label">
                                        {assignments.filter(
                                            (item) => item.meterId === meter.id,
                                        ).length}{' '}
                                        assignment(s)
                                    </span>

                                    {meter.status === 'available' && (
                                        <button
                                            className="button button-secondary meter-action"
                                            type="button"
                                            onClick={() => openAssignDialog(meter)}
                                        >
                                            <Pencil size={15} aria-hidden="true" />
                                            Assign
                                        </button>
                                    )}

                                    {meter.status === 'assigned' && current && (
                                        <>
                                            <button
                                                className="button button-secondary meter-action"
                                                type="button"
                                                onClick={() => openCorrectRoomDialog(meter, current)}
                                            >
                                                <ArrowLeftRight size={15} aria-hidden="true" />
                                                
                                            </button>
                                            <button
                                                className="button button-secondary meter-action text-danger"
                                                type="button"
                                                onClick={() => openCancelMeterDialog(meter, current)}
                                            >
                                                <AlertTriangle size={15} aria-hidden="true" />
                                                
                                            </button>
                                            <button
                                                className="button button-secondary meter-action"
                                                type="button"
                                                onClick={() => openReplaceDialog(meter)}
                                            >
                                                <RefreshCw size={15} aria-hidden="true" />
                                                
                                            </button>
                                        </>
                                    )}
                                </div>
                            </article>
                        )
                    })}
                </section>
            )}

            {dialogMode && (
                <div className="modal-overlay">
                    <section
                        className="property-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="meter-dialog-title"
                    >
                        <header className="property-modal-heading">
                            <div>
                                <p className="eyebrow">Meter management</p>
                                <h2 id="meter-dialog-title">
                                    {dialogMode === 'create'
                                        ? 'Register meter'
                                        : dialogMode === 'assign'
                                            ? `Assign ${selectedMeter?.serialNumber || 'meter'}`
                                            : dialogMode === 'correct'
                                                ? `Correct ${selectedMeter?.meterCode || 'meter'} room`
                                                : dialogMode === 'cancel'
                                                    ? `Cancel ${selectedMeter?.meterCode || 'meter'}`
                                                    : `Replace ${selectedMeter?.serialNumber || 'meter'}`}
                                </h2>
                            </div>

                            <button
                                className="icon-button"
                                type="button"
                                onClick={closeDialog}
                                disabled={isSaving}
                                aria-label="Close meter form"
                            >
                                <X size={20} aria-hidden="true" />
                            </button>
                        </header>

                        <form className="property-form" onSubmit={handleSubmit}>
                            {dialogMode === 'create' && (
                                <>
                                    <div className="property-form-field">
                                        <label htmlFor="meter-serial">
                                            Physical serial number
                                        </label>
                                        <input
                                            id="meter-serial"
                                            value={meterForm.serialNumber}
                                            onChange={(event) =>
                                                updateMeterField('serialNumber', event.target.value)
                                            }
                                            placeholder="Optional manufacturer serial"
                                            maxLength={80}
                                            disabled={isSaving}
                                        />
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-notes">Notes</label>
                                        <textarea
                                            id="meter-notes"
                                            value={meterForm.notes}
                                            onChange={(event) =>
                                                updateMeterField('notes', event.target.value)
                                            }
                                            placeholder="Optional meter details"
                                            rows={3}
                                            maxLength={1000}
                                            disabled={isSaving}
                                        />
                                    </div>
                                </>
                            )}

                            {dialogMode === 'assign' && (
                                <>
                                    <div className="property-form-field">
                                        <label htmlFor="meter-room">
                                            Room <span aria-hidden="true">*</span>
                                        </label>
                                        <select
                                            id="meter-room"
                                            value={assignmentForm.roomId}
                                            onChange={(event) =>
                                                updateAssignmentField('roomId', event.target.value)
                                            }
                                            required
                                            disabled={isSaving}
                                        >
                                            <option value="" disabled>
                                                Select a room
                                            </option>

                                            {assignableRooms.map((room) => {
                                                const property = propertyById.get(room.propertyId)
                                                const tenantAssignment = currentTenantAssignmentByRoom.get(room.id)
                                                const tenantName = tenantAssignment?.tenantName?.trim() || 'No current tenant'

                                                return (
                                                    <option key={room.id} value={room.id}>
                                                        {tenantName} - Room {room.roomNumber} - {room.floorName} - {property?.name ?? room.propertyCode}
                                                    </option>
                                                )
                                            })}
                                        </select>

                                        {assignableRooms.length === 0 && (
                                            <small className="field-hint">
                                                No eligible rooms are available. A room can have only one current meter.
                                            </small>
                                        )}
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-assigned-on">
                                            Assignment date <span aria-hidden="true">*</span>
                                        </label>
                                        <input
                                            id="meter-assigned-on"
                                            type="date"
                                            value={assignmentForm.assignedOn}
                                            onChange={(event) =>
                                                updateAssignmentField('assignedOn', event.target.value)
                                            }
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-initial-reading">
                                            Initial meter reading <span aria-hidden="true">*</span>
                                        </label>
                                        <input
                                            id="meter-initial-reading"
                                            type="number"
                                            min="0"
                                            step="any"
                                            value={assignmentForm.initialReading}
                                            onChange={(event) =>
                                                updateAssignmentField(
                                                    'initialReading',
                                                    event.target.value === ''
                                                        ? 0
                                                        : Number(event.target.value),
                                                )
                                            }
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>
                                </>
                            )}

                            {dialogMode === 'correct' && processStep === 'details' && (
                                <>
                                    <div className="property-id-note">
                                        <strong>Step 1 of 2 · Prepare correction</strong>
                                        <br />
                                        Meter ID: {selectedMeter?.meterCode}
                                        <br />
                                        Currently assigned: Room {roomById.get(selectedAssignment?.roomId ?? '')?.roomNumber ?? selectedAssignment?.roomCode ?? 'Unknown'}
                                        <br />
                                        This does not replace the physical meter. The old room assignment will remain in history, and the same meter ID, assignment date, and initial reading will be retained.
                                        <br />
                                        This action is locked if any reading, bill, or reading-state record exists.
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-correct-room">
                                            Correct room <span aria-hidden="true">*</span>
                                        </label>
                                        <select
                                            id="meter-correct-room"
                                            value={correctionRoomId}
                                            onChange={(event) => setCorrectionRoomId(event.target.value)}
                                            required
                                            disabled={isSaving}
                                        >
                                            <option value="" disabled>Select the correct room</option>
                                            {assignableRooms.map((room) => {
                                                const property = propertyById.get(room.propertyId)
                                                const tenantAssignment = currentTenantAssignmentByRoom.get(room.id)
                                                const tenantName = tenantAssignment?.tenantName?.trim() || 'No current tenant'
                                                return (
                                                    <option key={room.id} value={room.id}>
                                                        {tenantName} - Room {room.roomNumber} - {room.floorName} - {property?.name ?? room.propertyCode}
                                                    </option>
                                                )
                                            })}
                                        </select>
                                        {assignableRooms.length === 0 && (
                                            <small className="field-hint">
                                                No other eligible room is available. A room can have only one current meter.
                                            </small>
                                        )}
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-correction-reason">Why is this assignment incorrect? *</label>
                                        <textarea
                                            id="meter-correction-reason"
                                            value={processReason}
                                            onChange={(event) => setProcessReason(event.target.value)}
                                            minLength={10}
                                            maxLength={700}
                                            rows={3}
                                            placeholder="Example: The meter was linked to Room 302 by mistake. It belongs to Room 303."
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>
                                </>
                            )}

                            {dialogMode === 'cancel' && processStep === 'details' && (
                                <>
                                    <div className="property-id-note">
                                        <strong>Step 1 of 2 · Request cancellation</strong>
                                        <br />
                                        Meter ID: {selectedMeter?.meterCode}
                                        <br />
                                        Currently assigned: Room {roomById.get(selectedAssignment?.roomId ?? '')?.roomNumber ?? selectedAssignment?.roomCode ?? 'Unknown'}
                                        <br />
                                        Use this only when the meter was created by mistake and the physical meter never existed. The room will be freed, but the permanent meter ID and history will remain as Cancelled.
                                        <br />
                                        Cancellation is blocked when a reading, bill, or reading-state record exists.
                                    </div>
                                    <div className="property-form-field">
                                        <label htmlFor="meter-cancellation-reason">Why was this meter created by mistake? *</label>
                                        <textarea
                                            id="meter-cancellation-reason"
                                            value={processReason}
                                            onChange={(event) => setProcessReason(event.target.value)}
                                            minLength={10}
                                            maxLength={700}
                                            rows={3}
                                            placeholder="Example: M0008 was created accidentally. No physical meter was installed or used."
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>
                                </>
                            )}

                            {(dialogMode === 'correct' || dialogMode === 'cancel') && processStep === 'review' && (
                                <>
                                    <div className="property-id-note">
                                        <strong>Step 2 of 2 · Final review</strong>
                                        <br />
                                        Meter: {selectedMeter?.meterCode}
                                        <br />
                                        {dialogMode === 'correct' ? (
                                            <>
                                                From: Room {roomById.get(selectedAssignment?.roomId ?? '')?.roomNumber ?? selectedAssignment?.roomCode ?? 'Unknown'}
                                                <br />
                                                To: Room {rooms.find((room) => room.id === correctionRoomId)?.roomNumber ?? 'Selected room'}
                                                <br />
                                                The old assignment will be ended, and a new assignment will be created using the same meter ID and initial reading.
                                            </>
                                        ) : (
                                            <>
                                                Current room: Room {roomById.get(selectedAssignment?.roomId ?? '')?.roomNumber ?? selectedAssignment?.roomCode ?? 'Unknown'}
                                                <br />
                                                The assignment will be ended, the room will be freed, and the meter will be permanently marked Cancelled. The meter ID and history will not be deleted.
                                            </>
                                        )}
                                        <br />
                                        <strong>Reason:</strong> {processReason.trim()}
                                    </div>

                                    <label className="meter-process-check">
                                        <input
                                            type="checkbox"
                                            checked={processAcknowledged}
                                            onChange={(event) => setProcessAcknowledged(event.target.checked)}
                                            disabled={isSaving}
                                        />
                                        <span>{dialogMode === 'correct'
                                            ? 'I checked the old room and the new room. I understand this creates a permanent assignment-history entry.'
                                            : 'I confirm this meter was created by mistake, never physically existed, and has no saved readings or bills.'}</span>
                                    </label>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-process-confirmation">
                                            Type <strong>{dialogMode === 'cancel' ? 'CANCEL' : 'CORRECT'} {selectedMeter?.meterCode}</strong> to confirm.
                                        </label>
                                        <input
                                            id="meter-process-confirmation"
                                            value={confirmationText}
                                            onChange={(event) => setConfirmationText(event.target.value)}
                                            placeholder={`${dialogMode === 'cancel' ? 'CANCEL' : 'CORRECT'} ${selectedMeter?.meterCode ?? ''}`}
                                            autoComplete="off"
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>
                                </>
                            )}

                            {dialogMode === 'replace' && (
                                <>
                                    <div className="property-id-note">
                                        Old meter: {selectedMeter?.serialNumber || 'Selected meter'}
                                        <br />
                                        The existing room assignment will end. A new meter ID will be created, and historical assignments will be retained.
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-replacement-date">
                                            Replacement date <span aria-hidden="true">*</span>
                                        </label>
                                        <input
                                            id="meter-replacement-date"
                                            type="date"
                                            value={replacementForm.replacementDate}
                                            onChange={(event) =>
                                                updateReplacementField(
                                                    'replacementDate',
                                                    event.target.value,
                                                )
                                            }
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-final-reading">
                                            Old meter final reading <span aria-hidden="true">*</span>
                                        </label>
                                        <input
                                            id="meter-final-reading"
                                            type="number"
                                            min="0"
                                            step="any"
                                            value={replacementForm.finalReading}
                                            onChange={(event) =>
                                                updateReplacementField(
                                                    'finalReading',
                                                    event.target.value === ''
                                                        ? 0
                                                        : Number(event.target.value),
                                                )
                                            }
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-new-reading">
                                            New meter initial reading <span aria-hidden="true">*</span>
                                        </label>
                                        <input
                                            id="meter-new-reading"
                                            type="number"
                                            min="0"
                                            step="any"
                                            value={replacementForm.newInitialReading}
                                            onChange={(event) =>
                                                updateReplacementField(
                                                    'newInitialReading',
                                                    event.target.value === ''
                                                        ? 0
                                                        : Number(event.target.value),
                                                )
                                            }
                                            required
                                            disabled={isSaving}
                                        />
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-reason">
                                            Replacement reason <span aria-hidden="true">*</span>
                                        </label>
                                        <select
                                            id="meter-reason"
                                            value={replacementForm.reason}
                                            onChange={(event) =>
                                                updateReplacementField(
                                                    'reason',
                                                    event.target.value as MeterReplacementFormValues['reason'],
                                                )
                                            }
                                            disabled={isSaving}
                                        >
                                            {Object.entries(replacementReasonLabels).map(
                                                ([value, label]) => (
                                                    <option value={value} key={value}>
                                                        {label}
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-new-serial">
                                            New meter physical serial number
                                        </label>
                                        <input
                                            id="meter-new-serial"
                                            value={replacementForm.newSerialNumber}
                                            onChange={(event) =>
                                                updateReplacementField(
                                                    'newSerialNumber',
                                                    event.target.value,
                                                )
                                            }
                                            maxLength={80}
                                            placeholder="Optional serial number"
                                            disabled={isSaving}
                                        />
                                    </div>

                                    <div className="property-form-field">
                                        <label htmlFor="meter-replacement-notes">
                                            Replacement notes
                                        </label>
                                        <textarea
                                            id="meter-replacement-notes"
                                            value={replacementForm.notes}
                                            onChange={(event) =>
                                                updateReplacementField('notes', event.target.value)
                                            }
                                            rows={3}
                                            maxLength={1000}
                                            placeholder="Explain the damage or suspected reading issue"
                                            disabled={isSaving}
                                        />
                                    </div>
                                </>
                            )}

                            {formError && (
                                <p className="auth-error" role="alert">
                                    {formError}
                                </p>
                            )}

                            <div className="property-form-actions">
                                {(dialogMode === 'correct' || dialogMode === 'cancel') && processStep === 'review' && (
                                    <button
                                        className="button button-secondary"
                                        type="button"
                                        onClick={() => {
                                            setProcessStep('details')
                                            setProcessAcknowledged(false)
                                            setConfirmationText('')
                                            setFormError('')
                                        }}
                                        disabled={isSaving}
                                    >
                                        Back to details
                                    </button>
                                )}
                                <button
                                    className="button button-secondary"
                                    type="button"
                                    onClick={closeDialog}
                                    disabled={isSaving}
                                >
                                    Cancel
                                </button>

                                <button
                                    className="button button-primary"
                                    type="submit"
                                    disabled={
                                        isSaving ||
                                        (dialogMode === 'assign' &&
                                            assignableRooms.length === 0) ||
                                        (dialogMode === 'correct' && processStep === 'details' &&
                                            (!correctionRoomId || assignableRooms.length === 0)) ||
                                        ((dialogMode === 'correct' || dialogMode === 'cancel') && processStep === 'review' &&
                                            (!processAcknowledged || confirmationText.trim().toUpperCase() !== `${dialogMode === 'cancel' ? 'CANCEL' : 'CORRECT'} ${selectedMeter?.meterCode ?? ''}`))
                                    }
                                >
                                    {isSaving ? (
                                        <LoaderCircle
                                            className="auth-spinner"
                                            size={17}
                                            aria-hidden="true"
                                        />
                                    ) : dialogMode === 'replace' ? (
                                        <RefreshCw size={17} aria-hidden="true" />
                                    ) : dialogMode === 'correct' ? (
                                        <ArrowLeftRight size={17} aria-hidden="true" />
                                    ) : dialogMode === 'cancel' ? (
                                        <AlertTriangle size={17} aria-hidden="true" />
                                    ) : (
                                        <Plus size={17} aria-hidden="true" />
                                    )}

                                    {isSaving
                                        ? 'Saving...'
                                        : dialogMode === 'create'
                                            ? 'Register meter'
                                            : dialogMode === 'assign'
                                                ? 'Assign meter'
                                                : dialogMode === 'correct'
                                                    ? processStep === 'details' ? 'Review correction' : 'Confirm room correction'
                                                    : dialogMode === 'cancel'
                                                        ? processStep === 'details' ? 'Review cancellation' : 'Confirm meter cancellation'
                                                        : 'Confirm replacement'}
                                </button>
                            </div>
                        </form>
                    </section>
                </div>
            )}
        </>
    )
}