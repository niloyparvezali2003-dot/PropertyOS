import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'

import { getFirebaseServices } from './client'

export type AuditAction =
  | 'created'
  | 'updated'
  | 'assigned'
  | 'moved_out'
  | 'replaced'
  | 'rate_added'
  | 'bills_generated'
  | 'bill_issued'
  | 'payment_recorded'
  | 'credit_applied'

export type AuditEntityType =
  | 'property'
  | 'room'
  | 'tenant'
  | 'meter'
  | 'tenant_assignment'
  | 'meter_assignment'
  | 'rent_rate'
  | 'rent_bills'
  | 'electricity_rate'
  | 'electricity_bill'
  | 'payment'
  | 'credit_application'

export type AuditEventInput = {
  action: AuditAction
  entityType: AuditEntityType
  entityId: string
  entityLabel: string
  summary: string
  /** Optional stable key for operations that intentionally support retries. */
  dedupeKey?: string
}

export type AuditEventRecord = Omit<AuditEventInput, 'dedupeKey'> & {
  id: string
  actorUid: string
  occurredAt: Timestamp | null
}

const allowedActions = new Set<AuditAction>([
  'created',
  'updated',
  'assigned',
  'moved_out',
  'replaced',
  'rate_added',
  'bills_generated',
  'bill_issued',
  'payment_recorded',
  'credit_applied',
])

const allowedEntityTypes = new Set<AuditEntityType>([
  'property',
  'room',
  'tenant',
  'meter',
  'tenant_assignment',
  'meter_assignment',
  'rent_rate',
  'rent_bills',
  'electricity_rate',
  'electricity_bill',
  'payment',
  'credit_application',
])

function isNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength
}

function readAuditEvent(id: string, value: Record<string, unknown>): AuditEventRecord | null {
  const actorUid = value.actorUid
  const action = value.action
  const entityType = value.entityType
  const entityId = value.entityId
  const entityLabel = value.entityLabel
  const summary = value.summary

  if (
    typeof actorUid !== 'string' ||
    !allowedActions.has(action as AuditAction) ||
    !allowedEntityTypes.has(entityType as AuditEntityType) ||
    !isNonEmptyString(entityId, 200) ||
    !isNonEmptyString(entityLabel, 160) ||
    !isNonEmptyString(summary, 320)
  ) {
    return null
  }

  return {
    id,
    actorUid,
    action: action as AuditAction,
    entityType: entityType as AuditEntityType,
    entityId,
    entityLabel,
    summary,
    occurredAt: value.occurredAt instanceof Timestamp ? value.occurredAt : null,
  }
}

/**
 * Audit events are append-only. Logging is deliberately best-effort after a
 * business operation has committed, so a history-write problem cannot cause
 * a saved payment or bill to be reported as failed and accidentally retried.
 */
export async function recordAuditEvent(
  ownerUid: string,
  input: AuditEventInput,
): Promise<boolean> {
  const { dedupeKey, ...eventInput } = input
  const entityId = eventInput.entityId.trim().slice(0, 200)
  const entityLabel = eventInput.entityLabel.trim().slice(0, 160)
  const summary = eventInput.summary.trim().slice(0, 320)

  if (!entityId || !entityLabel || !summary) return false

  try {
    const { db } = getFirebaseServices()
    const eventsRef = collection(db, 'users', ownerUid, 'auditEvents')
    const eventData = {
      ...eventInput,
      entityId,
      entityLabel,
      summary,
      actorUid: ownerUid,
      occurredAt: serverTimestamp(),
    }

    if (dedupeKey?.trim()) {
      const safeKey = dedupeKey.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 400)
      const eventRef = doc(eventsRef, `dedupe__${safeKey}`)
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(eventRef)
        if (!existing.exists()) transaction.set(eventRef, eventData)
      })
    } else {
      await addDoc(eventsRef, eventData)
    }
    return true
  } catch (error: unknown) {
    console.error(
      '[PropertyOS] A business action was saved, but its audit event could not be recorded.',
      error,
    )
    return false
  }
}

export async function listAuditEvents(ownerUid: string): Promise<AuditEventRecord[]> {
  const { db } = getFirebaseServices()
  const eventsRef = collection(db, 'users', ownerUid, 'auditEvents')
  const snapshot = await getDocs(
    query(eventsRef, orderBy('occurredAt', 'desc'), limit(500)),
  )

  const events: AuditEventRecord[] = []
  for (const document of snapshot.docs) {
    const event = readAuditEvent(document.id, document.data())
    if (event) events.push(event)
  }
  return events
}

export function getAuditErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    if (error.message.toLowerCase().includes('permission')) {
      return 'Access to activity history was denied. Publish the latest firestore.rules file, then refresh this page.'
    }
    return error.message
  }
  return 'Unable to load activity history. Check your connection and try again.'
}
