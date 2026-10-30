import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type FormEvent,
} from 'react'

import {
    DoorOpen,
    LoaderCircle,
    MapPin,
    Pencil,
    Plus,
    X,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { recordAuditEvent } from '../services/firebase/audit'
import type { AppPage } from '../types/navigation'

import {
    listProperties,
    type PropertyRecord,
} from '../services/firebase/properties'

import {
    createRoom,
    getRoomErrorMessage,
    listRooms,
    updateRoom,
    type RoomRecord,
} from '../services/firebase/rooms'

import {
    listTenantAssignments,
    type TenantAssignmentRecord,
} from '../services/firebase/tenantAssignments'

import {
    roomFormSchema,
    type RoomFormValues,
    type RoomStatus,
} from '../schemas/room'

type RoomsPageProps = {
    ownerUid: string
    onNavigate: (page: AppPage) => void
}

const emptyForm: RoomFormValues = {
    propertyId: '',
    floorName: '',
    roomNumber: '',
    notes: '',
    status: 'vacant',
}

const statusLabels: Record<RoomStatus, string> = {
    vacant: 'Vacant',
    maintenance: 'Maintenance',
    inactive: 'Inactive',
}

export function RoomsPage({
    ownerUid,
    onNavigate,
}: RoomsPageProps) {
    const [rooms, setRooms] = useState<RoomRecord[]>([])
    const [properties, setProperties] = useState<PropertyRecord[]>([])
    const [tenantAssignments, setTenantAssignments] =
        useState<TenantAssignmentRecord[]>([])
    const [search, setSearch] = useState('')
    const [selectedPropertyId, setSelectedPropertyId] = useState('all')

    const [isLoading, setIsLoading] = useState(true)
    const [pageError, setPageError] = useState('')

    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingRoom, setEditingRoom] = useState<RoomRecord | null>(null)
    const [form, setForm] = useState<RoomFormValues>(emptyForm)
    const [formError, setFormError] = useState('')
    const [isSaving, setIsSaving] = useState(false)

    const activeProperties = useMemo(
        () => properties.filter((property) => property.status === 'active'),
        [properties],
    )

    const propertyById = useMemo(
        () => new Map(properties.map((property) => [property.id, property])),
        [properties],
    )

    const occupiedRoomIds = useMemo(
        () =>
            new Set(
                tenantAssignments
                    .filter((assignment) => assignment.status === 'current')
                    .map((assignment) => assignment.roomId),
            ),
        [tenantAssignments],
    )

    const loadData = useCallback(async () => {
        setIsLoading(true)
        setPageError('')

        try {
            const [nextProperties, nextRooms, nextAssignments] =
                await Promise.all([
                    listProperties(ownerUid),
                    listRooms(ownerUid),
                    listTenantAssignments(ownerUid),
                ])

            setProperties(nextProperties)
            setRooms(nextRooms)
            setTenantAssignments(nextAssignments)

            setSelectedPropertyId((current) =>
                current === 'all' ||
                    nextProperties.some((property) => property.id === current)
                    ? current
                    : 'all',
            )
        } catch (error: unknown) {
            setPageError(getRoomErrorMessage(error))
        } finally {
            setIsLoading(false)
        }
    }, [ownerUid])

    useEffect(() => {
        void loadData()
    }, [loadData])

    const filteredRooms = useMemo(() => {
        const searchTerm = search.trim().toLowerCase()

        return rooms.filter((room) => {
            const matchesProperty =
                selectedPropertyId === 'all' ||
                room.propertyId === selectedPropertyId

            if (!matchesProperty) return false
            if (!searchTerm) return true

            const propertyName =
                propertyById.get(room.propertyId)?.name ?? ''

            return [
                room.roomCode,
                room.propertyCode,
                propertyName,
                room.floorName,
                room.roomNumber,
                room.notes,
                room.status === 'vacant' && occupiedRoomIds.has(room.id)
                    ? 'Occupied'
                    : statusLabels[room.status],
            ]
                .join(' ')
                .toLowerCase()
                .includes(searchTerm)
        })
    }, [rooms, search, selectedPropertyId, propertyById, occupiedRoomIds])

    function openCreateDialog() {
        setEditingRoom(null)

        setForm({
            ...emptyForm,
            propertyId: activeProperties[0]?.id ?? '',
        })

        setFormError('')
        setIsDialogOpen(true)
    }

    function openEditDialog(room: RoomRecord) {
        setEditingRoom(room)

        setForm({
            propertyId: room.propertyId,
            floorName: room.floorName,
            roomNumber: room.roomNumber,
            notes: room.notes,
            status: room.status,
        })

        setFormError('')
        setIsDialogOpen(true)
    }

    function closeDialog() {
        if (isSaving) return

        setIsDialogOpen(false)
        setEditingRoom(null)
        setForm({ ...emptyForm })
        setFormError('')
    }

    function updateField<K extends keyof RoomFormValues>(
        field: K,
        value: RoomFormValues[K],
    ) {
        setForm((current) => ({
            ...current,
            [field]: value,
        }))
    }

    async function handleSubmit(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault()

        if (isSaving) return

        setFormError('')

        const result = roomFormSchema.safeParse(form)

        if (!result.success) {
            setFormError(
                result.error.issues[0]?.message ??
                'Please review the room information.',
            )
            return
        }

        setIsSaving(true)

        try {
            const property = properties.find((item) => item.id === result.data.propertyId)
            const roomLabel = `${property?.name ? `${property.name} · ` : ''}Room ${result.data.roomNumber}`
            if (editingRoom) {
                await updateRoom(ownerUid, editingRoom.id, result.data)
                await recordAuditEvent(ownerUid, {
                    action: 'updated',
                    entityType: 'room',
                    entityId: editingRoom.id,
                    entityLabel: roomLabel,
                    summary: `Updated ${roomLabel} on floor ${result.data.floorName}.`,
                })
            } else {
                const roomId = await createRoom(ownerUid, result.data)
                await recordAuditEvent(ownerUid, {
                    action: 'created',
                    entityType: 'room',
                    entityId: roomId,
                    entityLabel: roomLabel,
                    summary: `Created ${roomLabel} on floor ${result.data.floorName}.`,
                })
            }

            setIsDialogOpen(false)
            setEditingRoom(null)
            setForm({ ...emptyForm })

            await loadData()
        } catch (error: unknown) {
            setFormError(getRoomErrorMessage(error))
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <>
            <header className="page-heading">
                <div>
                    <p className="eyebrow">Property management</p>
                    <h1>Rooms & Floors</h1>
                    <p className="page-description">
                        Organize rooms by property and floor, with permanent room IDs.
                    </p>
                </div>

                <button
                    className="button button-primary"
                    type="button"
                    onClick={openCreateDialog}
                    disabled={activeProperties.length === 0}
                >
                    <Plus size={18} aria-hidden="true" />
                    Add room
                </button>
            </header>

            <section className="rooms-toolbar">
                <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search rooms, floors, or properties..."
                />

                <select
                    className="rooms-property-filter"
                    aria-label="Filter rooms by property"
                    value={selectedPropertyId}
                    onChange={(event) => setSelectedPropertyId(event.target.value)}
                >
                    <option value="all">All properties</option>

                    {properties.map((property) => (
                        <option key={property.id} value={property.id}>
                            {property.propertyCode} · {property.name}
                        </option>
                    ))}
                </select>

                <span className="rooms-count">
                    {filteredRooms.length}{' '}
                    {filteredRooms.length === 1 ? 'room' : 'rooms'}
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
                    <p>Loading rooms...</p>
                </div>
            ) : activeProperties.length === 0 ? (
                <section className="properties-empty">
                    <span className="properties-empty-icon">
                        <DoorOpen size={25} aria-hidden="true" />
                    </span>

                    <h2>Create a property first</h2>

                    <p>
                        Every room must belong to an existing property.
                    </p>

                    <button
                        className="button button-primary"
                        type="button"
                        onClick={() => onNavigate('Properties')}
                    >
                        <Plus size={17} aria-hidden="true" />
                        Go to properties
                    </button>
                </section>
            ) : filteredRooms.length === 0 ? (
                <section className="properties-empty">
                    <span className="properties-empty-icon">
                        <DoorOpen size={25} aria-hidden="true" />
                    </span>

                    <h2>
                        {rooms.length === 0
                            ? 'No rooms yet'
                            : 'No matching rooms'}
                    </h2>

                    <p>
                        {rooms.length === 0
                            ? 'Add the first room to a property.'
                            : 'Try a different search or property filter.'}
                    </p>

                    {rooms.length === 0 && (
                        <button
                            className="button button-primary"
                            type="button"
                            onClick={openCreateDialog}
                        >
                            <Plus size={17} aria-hidden="true" />
                            Add first room
                        </button>
                    )}
                </section>
            ) : (
                <section className="rooms-grid" aria-label="Rooms">
                    {filteredRooms.map((room) => {
                        const property = propertyById.get(room.propertyId)

                        const isOccupied =
                            room.status === 'vacant' && occupiedRoomIds.has(room.id)

                        const displayedStatus = isOccupied ? 'occupied' : room.status

                        return (
                            <article className="room-card" key={room.id}>
                                <div className="room-card-heading">
                                    <span className="room-card-icon">
                                        <DoorOpen size={21} aria-hidden="true" />
                                    </span>

                                    <span className={`room-status room-status--${displayedStatus}`}>
                                        {isOccupied ? 'Occupied' : statusLabels[room.status]}
                                    </span>
                                </div>

                                <div className="room-title-row">
                                    <h2>Room {room.roomNumber}</h2>
                                    <span className="room-code">{room.roomCode}</span>
                                </div>

                                <p className="room-property-name">
                                    {property?.propertyCode ?? room.propertyCode}
                                    {' · '}
                                    {property?.name ?? 'Unknown property'}
                                </p>

                                <p className="room-floor">
                                    <MapPin size={15} aria-hidden="true" />
                                    {room.floorName}
                                </p>

                                {room.notes && (
                                    <p className="room-notes">{room.notes}</p>
                                )}

                                <div className="room-card-footer">
                                    <span className="room-internal-id" title={room.id}>
                                        Permanent room ID
                                    </span>

                                    <button
                                        className="button button-secondary room-edit-button"
                                        type="button"
                                        onClick={() => openEditDialog(room)}
                                        aria-label={`Edit room ${room.roomNumber}`}
                                    >
                                        <Pencil size={15} aria-hidden="true" />
                                        Edit
                                    </button>
                                </div>
                            </article>
                        )
                    })}
                </section>
            )}

            {isDialogOpen && (
                <div className="modal-overlay">
                    <section
                        className="property-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="room-dialog-title"
                    >
                        <header className="property-modal-heading">
                            <div>
                                <p className="eyebrow">Room details</p>

                                <h2 id="room-dialog-title">
                                    {editingRoom ? 'Edit room' : 'Add room'}
                                </h2>
                            </div>

                            <button
                                className="icon-button"
                                type="button"
                                onClick={closeDialog}
                                disabled={isSaving}
                                aria-label="Close room form"
                            >
                                <X size={20} aria-hidden="true" />
                            </button>
                        </header>

                        {editingRoom && (
                            <div className="property-id-note">
                                Permanent room ID: {editingRoom.roomCode}
                                <br />
                                Property: {editingRoom.propertyCode}
                            </div>
                        )}

                        <form
                            className="property-form"
                            onSubmit={handleSubmit}
                            noValidate
                        >
                            <div className="property-form-field">
                                <label htmlFor="room-property">
                                    Property <span aria-hidden="true">*</span>
                                </label>

                                <select
                                    id="room-property"
                                    value={form.propertyId}
                                    onChange={(event) =>
                                        updateField('propertyId', event.target.value)
                                    }
                                    required
                                    disabled={isSaving || Boolean(editingRoom)}
                                >
                                    <option value="" disabled>
                                        Select a property
                                    </option>

                                    {activeProperties.map((property) => (
                                        <option key={property.id} value={property.id}>
                                            {property.propertyCode} · {property.name}
                                        </option>
                                    ))}
                                </select>

                                {editingRoom && (
                                    <small className="field-hint">
                                        A room remains linked to its original property.
                                    </small>
                                )}
                            </div>

                            <div className="room-form-row">
                                <div className="property-form-field">
                                    <label htmlFor="room-floor">
                                        Floor / level <span aria-hidden="true">*</span>
                                    </label>

                                    <input
                                        id="room-floor"
                                        type="text"
                                        value={form.floorName}
                                        onChange={(event) =>
                                            updateField('floorName', event.target.value)
                                        }
                                        placeholder="e.g. 1st Floor"
                                        maxLength={80}
                                        required
                                        disabled={isSaving}
                                    />
                                </div>

                                <div className="property-form-field">
                                    <label htmlFor="room-number">
                                        Room number <span aria-hidden="true">*</span>
                                    </label>

                                    <input
                                        id="room-number"
                                        type="text"
                                        value={form.roomNumber}
                                        onChange={(event) =>
                                            updateField('roomNumber', event.target.value)
                                        }
                                        placeholder="e.g. 101"
                                        maxLength={30}
                                        required
                                        disabled={isSaving}
                                    />
                                </div>
                            </div>

                            <div className="property-form-field">
                                <label htmlFor="room-status">Room status</label>

                                <select
                                    id="room-status"
                                    value={form.status}
                                    onChange={(event) =>
                                        updateField('status', event.target.value as RoomStatus)
                                    }
                                    disabled={isSaving}
                                >
                                    <option value="vacant">Vacant</option>
                                    <option value="maintenance">Maintenance</option>
                                    <option value="inactive">Inactive</option>
                                </select>

                                <small className="field-hint">
                                    Occupancy is calculated automatically from current tenant assignments.
                                </small>
                            </div>

                            <div className="property-form-field">
                                <label htmlFor="room-notes">Notes</label>

                                <textarea
                                    id="room-notes"
                                    value={form.notes}
                                    onChange={(event) =>
                                        updateField('notes', event.target.value)
                                    }
                                    placeholder="Optional room notes"
                                    maxLength={1000}
                                    rows={3}
                                    disabled={isSaving}
                                />
                            </div>

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
                                    disabled={isSaving || activeProperties.length === 0}
                                >
                                    {isSaving ? (
                                        <LoaderCircle
                                            className="auth-spinner"
                                            size={17}
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <Plus size={17} aria-hidden="true" />
                                    )}

                                    {isSaving
                                        ? 'Saving...'
                                        : editingRoom
                                            ? 'Save changes'
                                            : 'Create room'}
                                </button>
                            </div>
                        </form>
                    </section>
                </div>
            )}
        </>
    )
}