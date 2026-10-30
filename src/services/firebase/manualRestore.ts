import { invalidateOwnerDataCache } from './listCache'
import {
  Bytes,
  DocumentReference,
  GeoPoint,
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  runTransaction,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore'

import { getFirebaseServices } from './client'
import { resetPropertyCodeMigration } from './properties'

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type BackupDocument = { id: string; data: JsonValue }
type ArchiveMetadata = {
  projectId: string
  ownerUid: string
  exportedAt: string
  documentCount: number
  encoding: string
  collectionCounts?: Record<string, number>
}
type BackupArchive = {
  format: string
  formatVersion: number
  metadata: ArchiveMetadata
  collections: Record<string, BackupDocument[]>
}
type RestoreCollection = (typeof RESTORE_COLLECTIONS)[number]
type PendingRestoreDocument = {
  collectionName: RestoreCollection
  id: string
  data: DocumentData
}

export type ManualRestoreProgress = {
  current: number
  total: number
  label: string
}

export type ManualRestorePlan = {
  file: File
  archive: BackupArchive
  destinationUid: string
  sourceUid: string
  exportedAt: string
  projectId: string
  totalDocuments: number
  newDocuments: number
  alreadyPresentDocuments: number
  collectionCounts: Record<string, number>
  conflicts: string[]
  pendingDocuments: PendingRestoreDocument[]
}

export type ManualRestoreResult = {
  restoredDocuments: number
  alreadyPresentDocuments: number
  collectionCounts: Record<string, number>
}

const RESTORE_COLLECTIONS = [
  'auditEvents',
  'billBalances',
  'creditApplications',
  'noteTasks',
  'notes',
  'openingBalanceAdjustments',
  'openingBalanceCreditApplications',
  'openingBalances',
  'currentAssignmentByMeter',
  'currentMeterByRoom',
  'currentRoomByTenant',
  'currentTenantByRoom',
  'electricityBills',
  'electricityRates',
  'electricityReadings',
  'electricityReadingState',
  'meterAssignments',
  'meters',
  'payments',
  'properties',
  'propertyNameIndex',
  'rentBills',
  'roomNameIndex',
  'roomRentRates',
  'settings',
  'rooms',
  'tenantAssignments',
  'tenantCredits',
  'tenants',
  'transactionReferences',
  'system',
] as const

const BUSINESS_UNIQUE_FIELDS: Record<string, string[]> = {
  properties: ['propertyCode'],
  rooms: ['roomCode'],
  tenants: ['tenantCode'],
  meters: ['meterCode'],
}

const SEQUENCE_DOCUMENT_IDS = [
  'propertySequence',
  'tenantSequence',
  'roomSequence',
  'meterSequence',
] as const

const RESTORE_SESSION_MINUTES = 10
const MAX_BACKUP_BYTES = 100 * 1024 * 1024
const MAX_CONFLICT_MESSAGES = 50

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (isRecord(item)) {
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(item).sort()) output[key] = normalize(item[key])
      return output
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

function encodeFirestoreValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : { __propertyOSFirestoreType: 'special-number', value: String(value) }
  }
  if (value instanceof Timestamp) {
    return { __propertyOSFirestoreType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds }
  }
  if (value instanceof Date) {
    return { __propertyOSFirestoreType: 'date', value: value.toISOString() }
  }
  if (value instanceof GeoPoint) {
    return { __propertyOSFirestoreType: 'geo-point', latitude: value.latitude, longitude: value.longitude }
  }
  if (value instanceof DocumentReference) {
    return { __propertyOSFirestoreType: 'document-reference', path: value.path }
  }
  if (value instanceof Bytes) {
    return { __propertyOSFirestoreType: 'bytes', base64: value.toBase64() }
  }
  if (Array.isArray(value)) return value.map(encodeFirestoreValue)
  if (typeof value === 'object' && isPlainObject(value)) {
    const output: Record<string, JsonValue> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      if (nestedValue === undefined) throw new Error('A Firestore document contains an undefined value; comparison stopped safely.')
      output[key] = encodeFirestoreValue(nestedValue)
    }
    return output
  }
  throw new Error('The backup contains a value type this restore version cannot safely encode.')
}

function decodeFirestoreValue(
  value: unknown,
  db: Firestore,
  sourceUid: string,
  destinationUid: string,
): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeFirestoreValue(item, db, sourceUid, destinationUid))
  if (!isRecord(value)) return value

  const tag = value.__propertyOSFirestoreType
  if (typeof tag === 'string') {
    switch (tag) {
      case 'timestamp':
        if (typeof value.seconds !== 'number' || typeof value.nanoseconds !== 'number') throw new Error('Backup contains a malformed Timestamp value.')
        return new Timestamp(value.seconds, value.nanoseconds)
      case 'date':
        if (typeof value.value !== 'string' || Number.isNaN(Date.parse(value.value))) throw new Error('Backup contains a malformed Date value.')
        return new Date(value.value)
      case 'geo-point':
        if (typeof value.latitude !== 'number' || typeof value.longitude !== 'number') throw new Error('Backup contains a malformed GeoPoint value.')
        return new GeoPoint(value.latitude, value.longitude)
      case 'document-reference': {
        if (typeof value.path !== 'string' || !value.path || value.path.startsWith('/')) throw new Error('Backup contains a malformed document reference.')
        const sourcePrefix = `users/${sourceUid}/`
        const rewrittenPath = value.path.startsWith(sourcePrefix)
          ? `users/${destinationUid}/${value.path.slice(sourcePrefix.length)}`
          : value.path
        return doc(db, rewrittenPath)
      }
      case 'bytes':
        if (typeof value.base64 !== 'string') throw new Error('Backup contains malformed bytes data.')
        return Bytes.fromBase64String(value.base64)
      case 'special-number':
        if (value.value === 'NaN') return Number.NaN
        if (value.value === 'Infinity') return Number.POSITIVE_INFINITY
        if (value.value === '-Infinity') return Number.NEGATIVE_INFINITY
        if (value.value === '-0') return -0
        throw new Error('Backup contains an unsupported special number.')
      default:
        throw new Error(`Backup contains an unsupported Firestore type tag: ${tag}`)
    }
  }

  const output: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = decodeFirestoreValue(nestedValue, db, sourceUid, destinationUid)
  }
  return output
}

function validateArchive(raw: unknown): BackupArchive {
  if (!isRecord(raw) || raw.format !== 'PropertyOS Firestore JSON Archive' || raw.formatVersion !== 1) {
    throw new Error('This file is not a supported PropertyOS Firestore JSON Archive (version 1).')
  }
  if (!isRecord(raw.metadata) || !isRecord(raw.collections)) throw new Error('Backup metadata or collections are missing.')
  const metadata = raw.metadata
  if (
    typeof metadata.projectId !== 'string' || !metadata.projectId ||
    typeof metadata.ownerUid !== 'string' || !metadata.ownerUid ||
    typeof metadata.exportedAt !== 'string' || Number.isNaN(Date.parse(metadata.exportedAt)) ||
    typeof metadata.documentCount !== 'number' || !Number.isSafeInteger(metadata.documentCount) || metadata.documentCount < 0 ||
    metadata.encoding !== 'tagged-firestore-values'
  ) {
    throw new Error('Backup metadata is incomplete or uses an unsupported encoding.')
  }

  const archiveCollections = raw.collections as Record<string, unknown>
  // Earlier version-1 archives may predate these newer workspace modules.
  // Treat their missing collections as empty to keep old backups restorable.
  for (const optionalCollection of [
    'settings',
    'transactionReferences',
    'notes',
    'noteTasks',
    'openingBalances',
    'openingBalanceAdjustments',
    'openingBalanceCreditApplications',
  ]) {
    if (!(optionalCollection in archiveCollections)) {
      archiveCollections[optionalCollection] = []
    }
  }

  const actualKeys = Object.keys(archiveCollections).sort()
  const expectedKeys = [...RESTORE_COLLECTIONS].sort()
  if (stableStringify(actualKeys) !== stableStringify(expectedKeys)) {
    throw new Error('This backup does not contain the complete supported collection set. Nothing was restored.')
  }

  let total = 0
  const seenIdsByCollection = new Map<string, Set<string>>()
  for (const collectionName of RESTORE_COLLECTIONS) {
    const rawRecords = raw.collections[collectionName]
    if (!Array.isArray(rawRecords)) throw new Error(`Backup collection "${collectionName}" is not a record array.`)
    const seenIds = new Set<string>()
    seenIdsByCollection.set(collectionName, seenIds)
    for (const item of rawRecords) {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.includes('/') || !isRecord(item.data)) {
        throw new Error(`Backup collection "${collectionName}" contains a malformed document. Nothing was restored.`)
      }
      if (seenIds.has(item.id)) throw new Error(`Backup contains duplicate document ID "${item.id}" in "${collectionName}".`)
      seenIds.add(item.id)
      total += 1
    }
  }
  if (total !== metadata.documentCount) {
    throw new Error(`Backup document-count check failed (metadata: ${metadata.documentCount}, actual: ${total}). Nothing was restored.`)
  }
  for (const item of raw.collections.system as BackupDocument[]) {
    if (!(SEQUENCE_DOCUMENT_IDS as readonly string[]).includes(item.id)) {
      throw new Error(`Backup contains an unrecognized system document "${item.id}".`)
    }
  }

  // Business codes must be unique within the archive before it can be applied.
  for (const [collectionName, fieldNames] of Object.entries(BUSINESS_UNIQUE_FIELDS)) {
    const seenValues = new Map<string, string>()
    for (const item of raw.collections[collectionName] as BackupDocument[]) {
      const itemData = item.data as Record<string, JsonValue>
      for (const fieldName of fieldNames) {
        const value = itemData[fieldName]
        if (typeof value !== 'string' || !value) continue
        const priorId = seenValues.get(value)
        if (priorId && priorId !== item.id) {
          throw new Error(`Backup contains duplicate ${fieldName} "${value}" in ${collectionName}. Nothing was restored.`)
        }
        seenValues.set(value, item.id)
      }
    }
  }

  return raw as unknown as BackupArchive
}

function addConflict(conflicts: string[], message: string): void {
  if (conflicts.length < MAX_CONFLICT_MESSAGES) conflicts.push(message)
}

async function buildRestorePlan(
  archive: BackupArchive,
  file: File,
  destinationUid: string,
  projectId: string,
  db: Firestore,
  onProgress?: (progress: ManualRestoreProgress) => void,
): Promise<ManualRestorePlan> {
  if (archive.metadata.projectId !== projectId) {
    throw new Error(`This backup belongs to Firebase project "${archive.metadata.projectId}", not the current project "${projectId}". Restore was stopped.`)
  }

  const conflicts: string[] = []
  const pendingDocuments: PendingRestoreDocument[] = []
  const collectionCounts: Record<string, number> = {}
  let alreadyPresentDocuments = 0
  const totalTasks = RESTORE_COLLECTIONS.length
  let current = 0
  const { sourceUid } = { sourceUid: archive.metadata.ownerUid }

  for (const collectionName of RESTORE_COLLECTIONS) {
    onProgress?.({ current: current + 1, total: totalTasks, label: collectionName })
    const incomingRecords = archive.collections[collectionName]
    collectionCounts[collectionName] = incomingRecords.length
    const existingById = new Map<string, { canonical: string; raw: DocumentData }>()
    const existingUniqueValues = new Map<string, Map<string, string>>()

    if (collectionName === 'system') {
      for (const sequenceId of SEQUENCE_DOCUMENT_IDS) {
        const snapshot = await getDoc(doc(db, 'users', destinationUid, 'system', sequenceId))
        if (snapshot.exists()) {
          existingById.set(sequenceId, {
            canonical: stableStringify(encodeFirestoreValue(snapshot.data())),
            raw: snapshot.data(),
          })
        }
      }
    } else if (collectionName === 'settings') {
      // Firestore rules allow only a direct read of settings/general.
      const snapshot = await getDoc(doc(db, 'users', destinationUid, 'settings', 'general'))
      if (snapshot.exists()) {
        existingById.set(snapshot.id, {
          canonical: stableStringify(encodeFirestoreValue(snapshot.data())),
          raw: snapshot.data(),
        })
      }
    } else {
      const snapshot = await getDocs(collection(db, 'users', destinationUid, collectionName))
      for (const item of snapshot.docs) {
        existingById.set(item.id, {
          canonical: stableStringify(encodeFirestoreValue(item.data())),
          raw: item.data(),
        })
      }
      for (const fieldName of BUSINESS_UNIQUE_FIELDS[collectionName] ?? []) {
        const values = new Map<string, string>()
        for (const item of snapshot.docs) {
          const value = item.data()[fieldName]
          if (typeof value === 'string' && value) values.set(value, item.id)
        }
        existingUniqueValues.set(fieldName, values)
      }
    }

    for (const record of incomingRecords) {
      const decoded = decodeFirestoreValue(record.data, db, sourceUid, destinationUid)
      if (!isRecord(decoded)) throw new Error(`Document ${collectionName}/${record.id} did not decode to an object.`)
      const data = decoded as DocumentData
      const canonicalIncoming = stableStringify(encodeFirestoreValue(data))
      const existing = existingById.get(record.id)
      if (existing) {
        if (existing.canonical === canonicalIncoming) {
          alreadyPresentDocuments += 1
        } else {
          addConflict(conflicts, `${collectionName}/${record.id}: destination has a different document with the same ID.`)
        }
        continue
      }

      for (const fieldName of BUSINESS_UNIQUE_FIELDS[collectionName] ?? []) {
        const value = data[fieldName]
        const existingId = typeof value === 'string' ? existingUniqueValues.get(fieldName)?.get(value) : undefined
        if (existingId && existingId !== record.id) {
          addConflict(conflicts, `${collectionName}/${record.id}: ${fieldName} "${String(value)}" already belongs to ${existingId}.`)
        }
      }
      pendingDocuments.push({ collectionName, id: record.id, data })
    }
    current += 1
  }

  return {
    file,
    archive,
    destinationUid,
    sourceUid: archive.metadata.ownerUid,
    exportedAt: archive.metadata.exportedAt,
    projectId,
    totalDocuments: archive.metadata.documentCount,
    newDocuments: pendingDocuments.length,
    alreadyPresentDocuments,
    collectionCounts,
    conflicts,
    pendingDocuments,
  }
}

export async function inspectManualFirestoreBackup(
  file: File,
  destinationUid: string,
  onProgress?: (progress: ManualRestoreProgress) => void,
): Promise<ManualRestorePlan> {
  if (!file) throw new Error('Choose a JSON backup file first.')
  if (file.size > MAX_BACKUP_BYTES) throw new Error('This backup exceeds the 100 MB browser restore limit.')
  if (!destinationUid.trim()) throw new Error('A signed-in destination account is required.')

  const { app, auth, db } = getFirebaseServices()
  if (!auth.currentUser || auth.currentUser.uid !== destinationUid) {
    throw new Error('Restore denied: the signed-in account does not match the destination account.')
  }
  const projectId = app.options.projectId
  if (!projectId) throw new Error('Unable to identify the current Firebase project.')

  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('The selected file is not valid JSON.')
  }
  const archive = validateArchive(parsed)
  return buildRestorePlan(archive, file, destinationUid, projectId, db, onProgress)
}

function makeSessionToken(): string {
  const bytes = new Uint8Array(24)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

export async function restoreManualFirestoreBackup(
  plan: ManualRestorePlan,
  destinationUid: string,
  onProgress?: (progress: ManualRestoreProgress) => void,
): Promise<ManualRestoreResult> {
  const { app, auth, db } = getFirebaseServices()
  if (!auth.currentUser || auth.currentUser.uid !== destinationUid || plan.destinationUid !== destinationUid) {
    throw new Error('Restore denied: the signed-in account changed after the backup preview.')
  }
  const projectId = app.options.projectId
  if (!projectId || projectId !== plan.projectId) throw new Error('Firebase project changed. Re-preview the backup before restoring.')

  // Re-check conflicts immediately before writes so a stale preview cannot overwrite data.
  const freshPlan = await buildRestorePlan(plan.archive, plan.file, destinationUid, projectId, db, onProgress)
  if (freshPlan.conflicts.length > 0) {
    throw new Error(`Restore stopped because ${freshPlan.conflicts.length} destination conflict(s) were found. Re-select the file and review the conflicts before retrying.`)
  }
  if (freshPlan.pendingDocuments.length === 0) {
    return {
      restoredDocuments: 0,
      alreadyPresentDocuments: freshPlan.alreadyPresentDocuments,
      collectionCounts: freshPlan.collectionCounts,
    }
  }

  const sessionRef = doc(db, 'users', destinationUid, 'system', 'restoreMode')
  const sessionToken = makeSessionToken()
  const sessionCreatedAt = Timestamp.now()
  const sessionPayload = () => ({
    active: true,
    ownerUid: destinationUid,
    sessionToken,
    expiresAt: Timestamp.fromMillis(Date.now() + RESTORE_SESSION_MINUTES * 60 * 1000),
    createdAt: sessionCreatedAt,
  })
  // Acquire a per-account lock atomically so two tabs cannot start restore together.
  await runTransaction(db, async (transaction) => {
    const priorSession = await transaction.get(sessionRef)
    if (priorSession.exists()) {
      const expiry = priorSession.data().expiresAt
      if (expiry instanceof Timestamp && expiry.toMillis() > Date.now()) {
        throw new Error('Another restore session is active for this account. Wait for it to finish or expire, then retry.')
      }
    }
    transaction.set(sessionRef, sessionPayload())
  })

  const restoredCounts: Record<string, number> = {}
  let restoredDocuments = 0
  // Transactions enforce create-only semantics: if a record appears after the
  // preview, it is detected instead of being overwritten by a batch set.
  const chunkSize = 20
  try {
    for (let offset = 0; offset < freshPlan.pendingDocuments.length; offset += chunkSize) {
      const chunk = freshPlan.pendingDocuments.slice(offset, offset + chunkSize)
      await setDoc(sessionRef, sessionPayload())
      const results = await Promise.allSettled(chunk.map(async (item) => {
        const targetRef = doc(db, 'users', destinationUid, item.collectionName, item.id)
        await runTransaction(db, async (transaction) => {
          const targetSnapshot = await transaction.get(targetRef)
          if (targetSnapshot.exists()) {
            throw new Error(`Restore stopped: ${item.collectionName}/${item.id} appeared after the preview. No existing record was overwritten.`)
          }
          transaction.set(targetRef, item.data)
        })
      }))
      const failedWrite = results.find((result) => result.status === 'rejected')
      if (failedWrite && failedWrite.status === 'rejected') throw failedWrite.reason
      for (const item of chunk) {
        restoredCounts[item.collectionName] = (restoredCounts[item.collectionName] ?? 0) + 1
      }
      restoredDocuments += chunk.length
      onProgress?.({
        current: Math.min(offset + chunk.length, freshPlan.pendingDocuments.length),
        total: freshPlan.pendingDocuments.length,
        label: 'restoring records',
      })
    }
  } finally {
    // If the browser closes or network fails, the rule-side restore session expires automatically.
    await deleteDoc(sessionRef).catch(() => undefined)
  }

  invalidateOwnerDataCache(destinationUid)
  resetPropertyCodeMigration(destinationUid)

  return {
    restoredDocuments,
    alreadyPresentDocuments: freshPlan.alreadyPresentDocuments,
    collectionCounts: restoredCounts,
  }
}
