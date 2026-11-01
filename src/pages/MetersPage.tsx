import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type FormEvent,
} from 'react'

import {
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
import type {
    MeterFormValues,
    MeterAssignmentFormValues,
    MeterReplacementFormValues,
    MeterStatus,
} from '../schemas/meter'

type MetersPageProps = {
    ownerUid: string
}

type DialogMode = 'create' | 'assign' | 'replace' | null

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
    available: 'Available',
    assigned: 'Assigned',
    retired: 'Retired',
}

const replacementReasonLabels = {
    damaged: 'Damaged',
    overreading: 'Overreading',
    slow_reading: 'Slow reading',
    other: 'Other',
}

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
        setMeterForm({ ...emptyMeterForm })
        setFormError('')
        setDialogMode('create')
    }

    function openAssignDialog(meter: MeterRecord) {
        setSelectedMeter(meter)
        setAssignmentForm({
            ...emptyAssignmentForm(),
            roomId: assignableRooms[0]?.id ?? '',
        })
        setFormError('')
        setDialogMode('assign')
    }

    function openReplaceDialog(meter: MeterRecord) {
        setSelectedMeter(meter)
        setReplacementForm(emptyReplacementForm())
        setFormError('')
        setDialogMode('replace')
    }

    function closeDialog() {
        if (isSaving) return

        setDialogMode(null)
        setSelectedMeter(null)
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

            <section className="meters-toolbar">
                <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search meters, rooms, or serial numbers..."
                />

                <select
                    className="meter-filter"
                    aria-label="Filter meters by status"
                    value={statusFilter}
                    onChange={(event) =>
                        setStatusFilter(event.target.value as 'all' | MeterStatus)
                    }
                >
                    <option value="all">All meters</option>
                    <option value="available">Available</option>
                    <option value="assigned">Assigned</option>
                    <option value="retired">Retired</option>
                </select>

                <span className="meters-count">
                    {filteredMeters.length}{' '}
                    {filteredMeters.length === 1 ? 'meter' : 'meters'}
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
                                        <button
                                            className="button button-secondary meter-action"
                                            type="button"
                                            onClick={() => openReplaceDialog(meter)}
                                        >
                                            <RefreshCw size={15} aria-hidden="true" />
                                            Replace meter
                                        </button>
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
                                            assignableRooms.length === 0)
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
                                    ) : (
                                        <Plus size={17} aria-hidden="true" />
                                    )}

                                    {isSaving
                                        ? 'Saving...'
                                        : dialogMode === 'create'
                                            ? 'Register meter'
                                            : dialogMode === 'assign'
                                                ? 'Assign meter'
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