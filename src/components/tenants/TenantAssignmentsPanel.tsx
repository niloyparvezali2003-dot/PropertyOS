import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRightLeft, CalendarDays, CheckCircle2, Clock3, DoorOpen, LogOut, RefreshCw, UserRound, Users } from 'lucide-react'

import { listRooms, type RoomRecord } from '../../services/firebase/rooms'
import { recordAuditEvent } from '../../services/firebase/audit'
import { listTenants, type TenantRecord } from '../../services/firebase/tenants'
import { listProperties, type PropertyRecord } from '../../services/firebase/properties'
import {
  createTenantAssignment,
  endTenantAssignment,
  getTenantAssignmentErrorMessage,
  listTenantAssignments,
  type TenantAssignmentRecord,
} from '../../services/firebase/tenantAssignments'
import type { TenantAssignmentFormValues, TenantMoveOutFormValues } from '../../schemas/tenantAssignment'

import './tenant-assignments.css'

type TenantAssignmentsPanelProps = {
  ownerUid: string
}

function getLocalToday(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const emptyForm = (): TenantAssignmentFormValues => ({
  tenantId: '',
  roomId: '',
  moveInDate: getLocalToday(),
  notes: '',
})

const emptyMoveOutForm = (): TenantMoveOutFormValues => ({
  moveOutDate: getLocalToday(),
  moveOutNotes: '',
})

function roomDisplayName(room: RoomRecord, propertyName: string): string {
  return `${room.roomCode} · ${propertyName} · ${room.floorName} · Room ${room.roomNumber}`
}

export function TenantAssignmentsPanel({ ownerUid }: TenantAssignmentsPanelProps) {
  const [tenants, setTenants] = useState<TenantRecord[]>([])
  const [rooms, setRooms] = useState<RoomRecord[]>([])
  const [properties, setProperties] = useState<PropertyRecord[]>([])
  const [assignments, setAssignments] = useState<TenantAssignmentRecord[]>([])
  const [form, setForm] = useState<TenantAssignmentFormValues>(emptyForm)
  const [moveOutForm, setMoveOutForm] = useState<TenantMoveOutFormValues>(emptyMoveOutForm)
  const [moveOutAssignmentId, setMoveOutAssignmentId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [pageError, setPageError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setPageError('')

    try {
      const [nextTenants, nextRooms, nextProperties, nextAssignments] = await Promise.all([
        listTenants(ownerUid),
        listRooms(ownerUid),
        listProperties(ownerUid),
        listTenantAssignments(ownerUid),
      ])
      setTenants(nextTenants)
      setRooms(nextRooms)
      setProperties(nextProperties)
      setAssignments(nextAssignments)
    } catch (error: unknown) {
      setPageError(getTenantAssignmentErrorMessage(error))
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

  const currentAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.status === 'current'),
    [assignments],
  )

  const endedAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.status === 'ended'),
    [assignments],
  )

  const assignedRoomIds = useMemo(
    () => new Set(currentAssignments.map((assignment) => assignment.roomId)),
    [currentAssignments],
  )

  // A tenant can occupy several rooms at once. The room, not the tenant,
  // is the unique side of the current occupancy relationship.
  const availableTenants = useMemo(
    () => tenants.filter((tenant) => tenant.status === 'active'),
    [tenants],
  )

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === form.tenantId) ?? null,
    [form.tenantId, tenants],
  )

  const selectedTenantCurrentAssignments = useMemo(
    () => currentAssignments
      .filter((assignment) => assignment.tenantId === form.tenantId)
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true })),
    [currentAssignments, form.tenantId],
  )

  const currentRoomCountByTenant = useMemo(() => {
    const counts = new Map<string, number>()
    currentAssignments.forEach((assignment) => {
      counts.set(assignment.tenantId, (counts.get(assignment.tenantId) ?? 0) + 1)
    })
    return counts
  }, [currentAssignments])

  const availableRooms = useMemo(
    () => rooms.filter((room) => {
      const property = propertyById.get(room.propertyId)
      return room.status === 'vacant' && !assignedRoomIds.has(room.id) && property?.status === 'active'
    }),
    [assignedRoomIds, propertyById, rooms],
  )

  function updateForm<K extends keyof TenantAssignmentFormValues>(
    field: K,
    value: TenantAssignmentFormValues[K],
  ) {
    setForm((current) => ({ ...current, [field]: value }))
    setFormError('')
    setSuccessMessage('')
  }

  async function handleAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSaving(true)
    setFormError('')
    setSuccessMessage('')

    try {
      const assignmentId = await createTenantAssignment(ownerUid, form)
      const tenant = tenants.find((item) => item.id === form.tenantId)
      const room = rooms.find((item) => item.id === form.roomId)
      const roomName = room ? `${room.roomCode} · Room ${room.roomNumber}` : 'selected room'
      const tenantName = tenant?.fullName ?? 'Selected tenant'
      await recordAuditEvent(ownerUid, {
        action: 'assigned',
        entityType: 'tenant_assignment',
        entityId: assignmentId,
        entityLabel: `${tenantName} → ${roomName}`,
        summary: `Assigned ${tenantName} to ${roomName} from ${form.moveInDate}.`,
      })
      setForm(emptyForm())
      setSuccessMessage('Tenant assigned successfully. The assignment history has been saved.')
      await loadData()
    } catch (error: unknown) {
      setFormError(getTenantAssignmentErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleMoveOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!moveOutAssignmentId) return

    setIsSaving(true)
    setFormError('')
    setSuccessMessage('')

    try {
      const endingAssignment = assignments.find((item) => item.id === moveOutAssignmentId)
      await endTenantAssignment(ownerUid, moveOutAssignmentId, moveOutForm)
      if (endingAssignment) {
        await recordAuditEvent(ownerUid, {
          action: 'moved_out',
          entityType: 'tenant_assignment',
          entityId: endingAssignment.id,
          entityLabel: `${endingAssignment.tenantName} → ${endingAssignment.roomCode}`,
          summary: `Recorded move-out for ${endingAssignment.tenantName} from ${endingAssignment.roomCode} / Room ${endingAssignment.roomNumber} on ${moveOutForm.moveOutDate}.`,
        })
      }
      setMoveOutAssignmentId(null)
      setMoveOutForm(emptyMoveOutForm())
      setSuccessMessage('Move-out recorded. The completed assignment remains in history.')
      await loadData()
    } catch (error: unknown) {
      setFormError(getTenantAssignmentErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="tenant-assignment-panel" aria-labelledby="tenant-assignment-heading">
      <div className="tenant-assignment-heading-row">
        <div>
          <p className="tenant-assignment-eyebrow">Occupancy management</p>
          <h2 id="tenant-assignment-heading">Tenant–Room Assignments</h2>
          <p className="tenant-assignment-intro">
            One tenant can occupy multiple rooms. Each room keeps its own occupancy, rent and meter history under the same tenant profile.
          </p>
        </div>
        <button
          type="button"
          className="tenant-assignment-secondary-button"
          onClick={() => void loadData()}
          disabled={isLoading || isSaving}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div className="tenant-assignment-stats" aria-label="Assignment totals">
        <div className="tenant-assignment-stat">
          <span className="tenant-assignment-stat-icon"><Users size={18} aria-hidden="true" /></span>
          <span className="tenant-assignment-stat-copy"><strong>{currentAssignments.length}</strong><small>Occupied rooms</small></span>
        </div>
        <div className="tenant-assignment-stat">
          <span className="tenant-assignment-stat-icon"><DoorOpen size={18} aria-hidden="true" /></span>
          <span className="tenant-assignment-stat-copy"><strong>{availableRooms.length}</strong><small>Available rooms</small></span>
        </div>
        <div className="tenant-assignment-stat">
          <span className="tenant-assignment-stat-icon"><Clock3 size={18} aria-hidden="true" /></span>
          <span className="tenant-assignment-stat-copy"><strong>{endedAssignments.length}</strong><small>Past stays</small></span>
        </div>
      </div>

      <div className="tenant-assignment-layout">
        <form className="tenant-assignment-card tenant-assignment-form" onSubmit={handleAssign}>
          <div className="tenant-assignment-card-heading">
            <span className="tenant-assignment-heading-icon"><ArrowRightLeft size={18} aria-hidden="true" /></span>
            <div>
              <h3>Assign a tenant</h3>
              <p>Create a new occupancy period.</p>
            </div>
          </div>

          <label className="tenant-assignment-field">
            <span>Tenant</span>
            <select
              value={form.tenantId}
              onChange={(event) => updateForm('tenantId', event.target.value)}
              required
              disabled={isLoading || isSaving}
            >
              <option value="">Select an active tenant</option>
              {availableTenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.fullName}{(currentRoomCountByTenant.get(tenant.id) ?? 0) > 0
                    ? ` · ${currentRoomCountByTenant.get(tenant.id)} current room${currentRoomCountByTenant.get(tenant.id) === 1 ? '' : 's'}`
                    : ' · No current room'}
                </option>
              ))}
            </select>
            {availableTenants.length === 0 && <small>No active tenants available.</small>}
          </label>

          {selectedTenant && (
            <div className="tenant-assignment-selected-occupancy" aria-live="polite">
              <div className="tenant-assignment-selected-occupancy-heading">
                <strong>{selectedTenant.fullName}</strong>
                <span>
                  {selectedTenantCurrentAssignments.length} current room{selectedTenantCurrentAssignments.length === 1 ? '' : 's'}
                </span>
              </div>
              {selectedTenantCurrentAssignments.length === 0 ? (
                <p>No room is currently assigned to this tenant.</p>
              ) : (
                <ul>
                  {selectedTenantCurrentAssignments.map((assignment) => (
                    <li key={assignment.id}>
                      <strong>Room {assignment.roomNumber}</strong>
                      <span>{propertyById.get(assignment.propertyId)?.name ?? assignment.propertyCode} · {assignment.floorName} · Since {assignment.moveInDate}</span>
                    </li>
                  ))}
                </ul>
              )}
              <small>Adding another room creates a separate room assignment under this same tenant account.</small>
            </div>
          )}

          <label className="tenant-assignment-field">
            <span>Vacant room</span>
            <select
              value={form.roomId}
              onChange={(event) => updateForm('roomId', event.target.value)}
              required
              disabled={isLoading || isSaving}
            >
              <option value="">Select a vacant room</option>
              {availableRooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {roomDisplayName(room, propertyById.get(room.propertyId)?.name ?? room.propertyCode)}
                </option>
              ))}
            </select>
            {availableRooms.length === 0 && <small>No vacant rooms in active properties are available.</small>}
          </label>

          <label className="tenant-assignment-field">
            <span>Move-in date</span>
            <span className="tenant-assignment-input-with-icon">
              <CalendarDays size={16} aria-hidden="true" />
              <input
                type="date"
                value={form.moveInDate}
                onChange={(event) => updateForm('moveInDate', event.target.value)}
                required
                disabled={isSaving}
              />
            </span>
          </label>

          <label className="tenant-assignment-field">
            <span>Notes <small>(optional)</small></span>
            <textarea
              value={form.notes}
              onChange={(event) => updateForm('notes', event.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Agreement notes or occupancy details"
              disabled={isSaving}
            />
          </label>

          {formError && <p className="tenant-assignment-message is-error" role="alert">{formError}</p>}
          {successMessage && <p className="tenant-assignment-message is-success" role="status">{successMessage}</p>}

          <button
            type="submit"
            className="tenant-assignment-primary-button"
            disabled={isLoading || isSaving || availableTenants.length === 0 || availableRooms.length === 0}
          >
            {isSaving ? 'Saving…' : 'Assign tenant'}
          </button>
          <p className="tenant-assignment-footnote">Each room gets its own permanent assignment history and separate rent / meter billing. All rooms stay linked to one tenant profile.</p>
        </form>

        <div className="tenant-assignment-card tenant-assignment-current-card">
          <div className="tenant-assignment-card-heading">
            <span className="tenant-assignment-heading-icon"><CheckCircle2 size={18} aria-hidden="true" /></span>
            <div>
              <h3>Current assignments</h3>
              <p>A tenant may occupy several rooms; each room can have only one current tenant. Move-out applies to one room at a time.</p>
            </div>
          </div>

          {isLoading ? (
            <div className="tenant-assignment-empty">Loading assignments…</div>
          ) : pageError ? (
            <div className="tenant-assignment-message is-error" role="alert">{pageError}</div>
          ) : currentAssignments.length === 0 ? (
            <div className="tenant-assignment-empty">
              <Users size={22} aria-hidden="true" />
              <strong>No current assignments</strong>
              <span>Choose a tenant and a vacant room to record a room assignment.</span>
            </div>
          ) : (
            <div className="tenant-assignment-list">
              {currentAssignments.map((assignment) => {
                const propertyName = propertyById.get(assignment.propertyId)?.name ?? assignment.propertyCode
                const isMovingOut = moveOutAssignmentId === assignment.id

                return (
                  <article className="tenant-assignment-item" key={assignment.id}>
                    <div className="tenant-assignment-item-topline">
                      <div className="tenant-assignment-person">
                        <span className="tenant-assignment-avatar"><UserRound size={18} aria-hidden="true" /></span>
                        <div>
                          <strong>{assignment.tenantName}</strong>
                          <span>{assignment.tenantCode}</span>
                        </div>
                      </div>
                      <span className="tenant-assignment-status is-current">Current</span>
                    </div>

                    <div className="tenant-assignment-item-details">
                      <div><small>Room</small><strong>{assignment.roomNumber}</strong></div>
                      <div><small>Property / floor</small><strong>{propertyName} · {assignment.floorName}</strong></div>
                      <div><small>Move-in</small><strong>{assignment.moveInDate}</strong></div>
                    </div>

                    {assignment.notes && <p className="tenant-assignment-note">{assignment.notes}</p>}

                    {isMovingOut ? (
                      <form className="tenant-assignment-moveout-form" onSubmit={handleMoveOut}>
                        <label className="tenant-assignment-field">
                          <span>Move-out date</span>
                          <input
                            type="date"
                            value={moveOutForm.moveOutDate}
                            min={assignment.moveInDate}
                            onChange={(event) => setMoveOutForm((current) => ({ ...current, moveOutDate: event.target.value }))}
                            required
                            disabled={isSaving}
                          />
                        </label>
                        <label className="tenant-assignment-field">
                          <span>Move-out notes <small>(optional)</small></span>
                          <textarea
                            value={moveOutForm.moveOutNotes}
                            onChange={(event) => setMoveOutForm((current) => ({ ...current, moveOutNotes: event.target.value }))}
                            rows={2}
                            maxLength={1000}
                            placeholder="Reason or handover notes"
                            disabled={isSaving}
                          />
                        </label>
                        <div className="tenant-assignment-inline-actions">
                          <button type="button" className="tenant-assignment-secondary-button" onClick={() => setMoveOutAssignmentId(null)} disabled={isSaving}>Cancel</button>
                          <button type="submit" className="tenant-assignment-danger-button" disabled={isSaving}>{isSaving ? 'Saving…' : 'Confirm move-out'}</button>
                        </div>
                      </form>
                    ) : (
                      <div className="tenant-assignment-item-actions">
                        <button
                          type="button"
                          className="tenant-assignment-danger-button"
                          onClick={() => {
                            setFormError('')
                            setMoveOutForm(emptyMoveOutForm())
                            setMoveOutAssignmentId(assignment.id)
                          }}
                          disabled={isSaving}
                        >
                          <LogOut size={15} aria-hidden="true" />
                          Move out
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="tenant-assignment-card tenant-assignment-history-card">
        <div className="tenant-assignment-card-heading">
          <span className="tenant-assignment-heading-icon"><Clock3 size={18} aria-hidden="true" /></span>
          <div>
            <h3>Assignment history</h3>
            <p>Past occupancy records remain available after move-out.</p>
          </div>
        </div>

        {isLoading ? (
          <div className="tenant-assignment-empty">Loading history…</div>
        ) : endedAssignments.length === 0 ? (
          <div className="tenant-assignment-history-empty">No completed assignments yet.</div>
        ) : (
          <div className="tenant-assignment-history-list">
            {endedAssignments.map((assignment) => (
              <article className="tenant-assignment-history-item" key={assignment.id}>
                <div className="tenant-assignment-history-main">
                  <strong>{assignment.tenantName}</strong>
                  <span>{assignment.tenantCode} · {assignment.roomCode} · {assignment.roomNumber}</span>
                </div>
                <div className="tenant-assignment-history-dates">
                  <span>{assignment.moveInDate}</span>
                  <span aria-hidden="true">→</span>
                  <span>{assignment.moveOutDate}</span>
                </div>
                <span className="tenant-assignment-status is-ended">Ended</span>
                {assignment.moveOutNotes && <p>{assignment.moveOutNotes}</p>}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
