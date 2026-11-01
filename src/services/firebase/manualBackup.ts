import {
  Bytes,
  DocumentReference,
  GeoPoint,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
} from 'firebase/firestore'

import { getFirebaseServices } from './client'

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type BackupDocument = {
  id: string
  data: JsonValue
}

export type ManualBackupProgress = {
  current: number
  total: number
  collectionName: string
}

export type ManualBackupResult = {
  fileName: string
  json: string
  documentCount: number
  collectionCounts: Record<string, number>
  projectId: string
  exportedAt: string
}

const COLLECTIONS = [
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
  'rentBillRoomMonthLocks',
  'roomNameIndex',
  'roomRentRateUsageLocks',
  'roomRentRates',
  'rooms',
  'tenantAssignments',
  'tenantCredits',
  'tenants',
  'transactionReferences',
] as const

// These are the only system document IDs allowed by the current rules.
const SEQUENCE_DOCUMENT_IDS = [
  'propertySequence',
  'tenantSequence',
  'roomSequence',
  'meterSequence',
] as const

function encodeFirestoreValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value
    }

    return {
      __propertyOSFirestoreType: 'special-number',
      value: String(value),
    }
  }

  if (value instanceof Timestamp) {
    return {
      __propertyOSFirestoreType: 'timestamp',
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    }
  }

  if (value instanceof Date) {
    return {
      __propertyOSFirestoreType: 'date',
      value: value.toISOString(),
    }
  }

  if (value instanceof GeoPoint) {
    return {
      __propertyOSFirestoreType: 'geo-point',
      latitude: value.latitude,
      longitude: value.longitude,
    }
  }

  if (value instanceof DocumentReference) {
    return {
      __propertyOSFirestoreType: 'document-reference',
      path: value.path,
    }
  }

  if (value instanceof Bytes) {
    return {
      __propertyOSFirestoreType: 'bytes',
      base64: value.toBase64(),
    }
  }

  if (Array.isArray(value)) {
    return value.map(encodeFirestoreValue)
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new Error(
        'The backup encountered an unsupported Firestore value. ' +
        'The export was stopped to avoid silently losing data.',
      )
    }

    const output: Record<string, JsonValue> = {}

    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = encodeFirestoreValue(nestedValue)
    }

    return output
  }

  throw new Error(
    'The backup encountered an unsupported value. ' +
    'The export was stopped to avoid creating an incomplete backup.',
  )
}

function makeFileName(exportedAt: string): string {
  const safeDate = exportedAt.replace(/[:.]/g, '-')

  return `PropertyOS-Firestore-Backup-${safeDate}.json`
}

/**
 * Downloads no data itself: returns a typed JSON archive for the UI to save.
 *
 * This function only reads Firestore. It does not change or delete records.
 */
export async function createManualFirestoreBackup(
  ownerUid: string,
  onProgress?: (progress: ManualBackupProgress) => void,
): Promise<ManualBackupResult> {
  if (!ownerUid.trim()) {
    throw new Error('A signed-in owner UID is required.')
  }

  const { app, auth, db } = getFirebaseServices()

  if (!auth.currentUser || auth.currentUser.uid !== ownerUid) {
    throw new Error(
      'Backup denied: the signed-in account does not match this owner.',
    )
  }

  const projectId = app.options.projectId

  if (!projectId) {
    throw new Error('Unable to identify the Firebase project ID.')
  }

  const exportedAt = new Date().toISOString()
  const collections: Record<string, BackupDocument[]> = {}
  const collectionCounts: Record<string, number> = {}

  const totalTasks = COLLECTIONS.length + 2
  let current = 0
  let documentCount = 0

  for (const collectionName of COLLECTIONS) {
    onProgress?.({
      current: current + 1,
      total: totalTasks,
      collectionName,
    })

    let snapshot
    try {
      snapshot = await getDocs(
        collection(db, 'users', ownerUid, collectionName),
      )
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Backup could not read collection "${collectionName}". ${detail}`,
      )
    }

    const records: BackupDocument[] = snapshot.docs.map(
      (snapshotDocument) => ({
        id: snapshotDocument.id,
        data: encodeFirestoreValue(snapshotDocument.data()),
      }),
    )

    collections[collectionName] = records
    collectionCounts[collectionName] = records.length
    documentCount += records.length
    current += 1
  }

  // Workspace settings are restricted by Firestore rules to the exact
  // users/{uid}/settings/general document. Do not query the whole collection.
  onProgress?.({
    current: current + 1,
    total: totalTasks,
    collectionName: 'settings',
  })

  try {
    const settingsSnapshot = await getDoc(
      doc(db, 'users', ownerUid, 'settings', 'general'),
    )
    const settingsRecords: BackupDocument[] = settingsSnapshot.exists()
      ? [{
          id: settingsSnapshot.id,
          data: encodeFirestoreValue(settingsSnapshot.data()),
        }]
      : []

    collections.settings = settingsRecords
    collectionCounts.settings = settingsRecords.length
    documentCount += settingsRecords.length
    current += 1
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Backup could not read workspace settings. ${detail}`)
  }

  // Query known sequence documents individually. The security rules do not
  // permit unrestricted reads of arbitrary IDs in the system collection.
  onProgress?.({
    current: current + 1,
    total: totalTasks,
    collectionName: 'system',
  })

  const sequenceRecords: BackupDocument[] = []

  for (const sequenceId of SEQUENCE_DOCUMENT_IDS) {
    const sequenceSnapshot = await getDoc(
      doc(db, 'users', ownerUid, 'system', sequenceId),
    )

    if (sequenceSnapshot.exists()) {
      sequenceRecords.push({
        id: sequenceSnapshot.id,
        data: encodeFirestoreValue(sequenceSnapshot.data()),
      })
    }
  }

  collections.system = sequenceRecords
  collectionCounts.system = sequenceRecords.length
  documentCount += sequenceRecords.length

  const backupDocument = {
    format: 'PropertyOS Firestore JSON Archive',
    formatVersion: 1,
    metadata: {
      projectId,
      ownerUid,
      exportedAt,
      method: 'authenticated-client-read-only-export',
      documentCount,
      collectionCount: Object.keys(collections).length,
      collectionCounts,
      encoding: 'tagged-firestore-values',
      restoreStatus: 'archive-only-no-automatic-restore',
    },
    collections,
  }

  const json = JSON.stringify(backupDocument, null, 2)

  return {
    fileName: makeFileName(exportedAt),
    json,
    documentCount,
    collectionCounts,
    projectId,
    exportedAt,
  }
}