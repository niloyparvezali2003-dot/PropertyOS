import { getCachedList, invalidateOwnerDataCache } from './listCache'

import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'

import { getFirebaseServices } from './client'

const DAY_MS = 24 * 60 * 60 * 1000
export const NOTE_TASK_RETENTION_DAYS = 30

export type NoteRecord = {
  id: string
  title: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export type NoteTaskRecord = {
  id: string
  noteId: string
  text: string
  order: number
  completedAt: Timestamp | null
  expiresAt: Timestamp | null
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

function assertOwner(ownerUid: string): void {
  const { auth } = getFirebaseServices()
  if (!ownerUid || auth.currentUser?.uid !== ownerUid) {
    throw new Error('Your sign-in session does not match this workspace. Sign in again.')
  }
}

function readNote(id: string, value: Record<string, unknown>): NoteRecord {
  if (
    typeof value.title !== 'string' || value.title.trim().length === 0 || value.title.length > 120 ||
    typeof value.createdBy !== 'string' || typeof value.updatedBy !== 'string'
  ) throw new Error(`Note ${id} contains invalid saved data.`)
  return {
    id,
    title: value.title,
    createdAt: value.createdAt instanceof Timestamp ? value.createdAt : null,
    updatedAt: value.updatedAt instanceof Timestamp ? value.updatedAt : null,
    createdBy: value.createdBy,
    updatedBy: value.updatedBy,
  }
}

function readTask(id: string, value: Record<string, unknown>): NoteTaskRecord {
  const completedAt = value.completedAt instanceof Timestamp ? value.completedAt : null
  const expiresAt = value.expiresAt instanceof Timestamp ? value.expiresAt : null
  if (
    typeof value.noteId !== 'string' || !value.noteId ||
    typeof value.text !== 'string' || !value.text.trim() || value.text.length > 1000 ||
    !Number.isSafeInteger(value.order) || (value.order as number) < 0 ||
    (value.completedAt !== null && value.completedAt !== undefined && !completedAt) ||
    (value.expiresAt !== null && value.expiresAt !== undefined && !expiresAt) ||
    Boolean(completedAt) !== Boolean(expiresAt) ||
    typeof value.createdBy !== 'string' || typeof value.updatedBy !== 'string'
  ) throw new Error(`Checklist item ${id} contains invalid saved data.`)
  return {
    id,
    noteId: value.noteId,
    text: value.text,
    order: value.order as number,
    completedAt,
    expiresAt,
    createdAt: value.createdAt instanceof Timestamp ? value.createdAt : null,
    updatedAt: value.updatedAt instanceof Timestamp ? value.updatedAt : null,
    createdBy: value.createdBy,
    updatedBy: value.updatedBy,
  }
}

function noteCollection(ownerUid: string) {
  const { db } = getFirebaseServices()
  return collection(db, 'users', ownerUid, 'notes')
}

function taskCollection(ownerUid: string) {
  const { db } = getFirebaseServices()
  return collection(db, 'users', ownerUid, 'noteTasks')
}

export async function listNotes(ownerUid: string): Promise<NoteRecord[]> {
  assertOwner(ownerUid)

  return getCachedList(ownerUid, 'Notes', async () => {
    const snapshot = await getDocs(query(noteCollection(ownerUid), orderBy('updatedAt', 'desc')))
    return snapshot.docs.map((item) => readNote(item.id, item.data()))
  })
}

export async function listNoteTasks(ownerUid: string): Promise<NoteTaskRecord[]> {
  assertOwner(ownerUid)

  return getCachedList(ownerUid, 'NoteTasks', async () => {
    const snapshot = await getDocs(taskCollection(ownerUid))
    return snapshot.docs.map((item) => readTask(item.id, item.data()))
  })
}

export async function createNote(ownerUid: string, rawTitle = 'New note'): Promise<string> {
  assertOwner(ownerUid)
  const title = rawTitle.trim().replace(/\s+/g, ' ').slice(0, 120) || 'New note'
  const { db } = getFirebaseServices()
  const noteRef = doc(noteCollection(ownerUid))
  await runTransaction(db, async (transaction) => {
    transaction.set(noteRef, {
      title,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ownerUid,
      updatedBy: ownerUid,
    })
  })
  invalidateOwnerDataCache(ownerUid)
  return noteRef.id
}

export async function renameNote(ownerUid: string, noteId: string, rawTitle: string): Promise<void> {
  assertOwner(ownerUid)
  const title = rawTitle.trim().replace(/\s+/g, ' ')
  if (!title || title.length > 120) throw new Error('Note title must contain 1–120 characters.')
  const { db } = getFirebaseServices()
  await updateDoc(doc(db, 'users', ownerUid, 'notes', noteId), {
    title,
    updatedAt: serverTimestamp(),
    updatedBy: ownerUid,
  })
  invalidateOwnerDataCache(ownerUid)
}

export async function createNoteTask(ownerUid: string, noteId: string, rawText: string): Promise<string> {
  assertOwner(ownerUid)
  const text = rawText.trim()
  if (!text || text.length > 1000) throw new Error('Checklist text must contain 1–1,000 characters.')
  const { db } = getFirebaseServices()
  const noteRef = doc(db, 'users', ownerUid, 'notes', noteId)
  const taskRef = doc(taskCollection(ownerUid))
  const existing = await getDocs(query(taskCollection(ownerUid), where('noteId', '==', noteId)))
  const nextOrder = existing.docs
    .map((item) => item.data())
    .filter((item) => item.noteId === noteId)
    .reduce((maximum, item) => Math.max(maximum, Number.isSafeInteger(item.order) ? item.order as number : -1), -1) + 1
  await runTransaction(db, async (transaction) => {
    const noteSnapshot = await transaction.get(noteRef)
    if (!noteSnapshot.exists()) throw new Error('This note no longer exists. Refresh and try again.')
    transaction.set(taskRef, {
      noteId,
      text,
      order: nextOrder,
      completedAt: null,
      expiresAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ownerUid,
      updatedBy: ownerUid,
    })
    transaction.update(noteRef, { updatedAt: serverTimestamp(), updatedBy: ownerUid })
  })
  invalidateOwnerDataCache(ownerUid)
  return taskRef.id
}

export async function updateNoteTaskText(ownerUid: string, noteId: string, taskId: string, rawText: string): Promise<void> {
  assertOwner(ownerUid)
  const text = rawText.trim()
  if (!text || text.length > 1000) throw new Error('Checklist text must contain 1–1,000 characters.')
  const { db } = getFirebaseServices()
  const taskRef = doc(db, 'users', ownerUid, 'noteTasks', taskId)
  const noteRef = doc(db, 'users', ownerUid, 'notes', noteId)
  await runTransaction(db, async (transaction) => {
    const taskSnapshot = await transaction.get(taskRef)
    if (!taskSnapshot.exists() || taskSnapshot.data().noteId !== noteId) throw new Error('This checklist item no longer exists.')
    transaction.update(taskRef, { text, updatedAt: serverTimestamp(), updatedBy: ownerUid })
    transaction.update(noteRef, { updatedAt: serverTimestamp(), updatedBy: ownerUid })
  })
  invalidateOwnerDataCache(ownerUid)
}

export async function setNoteTaskCompleted(ownerUid: string, noteId: string, taskId: string, completed: boolean): Promise<void> {
  assertOwner(ownerUid)
  const { db } = getFirebaseServices()
  const taskRef = doc(db, 'users', ownerUid, 'noteTasks', taskId)
  const noteRef = doc(db, 'users', ownerUid, 'notes', noteId)
  await runTransaction(db, async (transaction) => {
    const taskSnapshot = await transaction.get(taskRef)
    if (!taskSnapshot.exists() || taskSnapshot.data().noteId !== noteId) throw new Error('This checklist item no longer exists.')
    const now = Timestamp.now()
    transaction.update(taskRef, {
      completedAt: completed ? now : null,
      expiresAt: completed ? Timestamp.fromMillis(now.toMillis() + NOTE_TASK_RETENTION_DAYS * DAY_MS) : null,
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    })
    transaction.update(noteRef, { updatedAt: serverTimestamp(), updatedBy: ownerUid })
  })
  invalidateOwnerDataCache(ownerUid)
}

export async function reorderNoteTasks(ownerUid: string, noteId: string, orderedTaskIds: string[]): Promise<void> {
  assertOwner(ownerUid)
  if (orderedTaskIds.length > 450 || new Set(orderedTaskIds).size !== orderedTaskIds.length) {
    throw new Error('The checklist order is invalid.')
  }
  const { db } = getFirebaseServices()
  const batch = writeBatch(db)
  orderedTaskIds.forEach((taskId, index) => {
    batch.update(doc(db, 'users', ownerUid, 'noteTasks', taskId), {
      order: index,
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    })
  })
  batch.update(doc(db, 'users', ownerUid, 'notes', noteId), {
    updatedAt: serverTimestamp(),
    updatedBy: ownerUid,
  })
  await batch.commit()
  invalidateOwnerDataCache(ownerUid)
}

export async function deleteNoteTask(ownerUid: string, noteId: string, taskId: string): Promise<void> {
  assertOwner(ownerUid)
  const { db } = getFirebaseServices()
  const batch = writeBatch(db)
  batch.delete(doc(db, 'users', ownerUid, 'noteTasks', taskId))
  batch.update(doc(db, 'users', ownerUid, 'notes', noteId), { updatedAt: serverTimestamp(), updatedBy: ownerUid })
  await batch.commit()
  invalidateOwnerDataCache(ownerUid)
}

export async function deleteNote(ownerUid: string, noteId: string): Promise<void> {
  assertOwner(ownerUid)
  const { db } = getFirebaseServices()
  const allTasks = await getDocs(taskCollection(ownerUid))
  const matching = allTasks.docs.filter((item) => item.data().noteId === noteId)
  for (let offset = 0; offset < matching.length; offset += 450) {
    const batch = writeBatch(db)
    matching.slice(offset, offset + 450).forEach((item) => batch.delete(item.ref))
    await batch.commit()
  }
  await deleteDoc(doc(db, 'users', ownerUid, 'notes', noteId))
  invalidateOwnerDataCache(ownerUid)
}

/** Deletes completed checklist items whose own 30-day expiry has elapsed. */
export async function cleanupExpiredNoteTasks(ownerUid: string): Promise<number> {
  assertOwner(ownerUid)
  const { db } = getFirebaseServices()
  const now = Timestamp.now()
  const snapshot = await getDocs(query(
    taskCollection(ownerUid),
    where('expiresAt', '<=', now),
  ))
  const expired = snapshot.docs.filter((item) => {
    const data = item.data()
    return data.completedAt instanceof Timestamp &&
      data.expiresAt instanceof Timestamp &&
      data.expiresAt.toMillis() <= now.toMillis()
  })
  for (let offset = 0; offset < expired.length; offset += 450) {
    const batch = writeBatch(db)
    expired.slice(offset, offset + 450).forEach((item) => batch.delete(item.ref))
    await batch.commit()
  }
  if (expired.length > 0) invalidateOwnerDataCache(ownerUid)
  return expired.length
}
