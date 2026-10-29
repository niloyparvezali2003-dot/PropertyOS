import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'

import {
  commitIdentifierReservation,
  IdentifierLimitReachedError,
  InvalidIdentifierSequenceError,
  parseIdentifierNumber,
  reserveNextIdentifier,
} from './identifiers'

import { getFirebaseServices } from './client'
import { listProperties } from './properties'

import {
  roomFormSchema,
  type RoomFormValues,
  type RoomStatus,
} from '../../schemas/room'

export type RoomRecord = {
  id: string
  roomCode: string
  propertyId: string
  propertyCode: string
  floorName: string
  roomNumber: string
  normalizedFloorName: string
  normalizedRoomNumber: string
  notes: string
  status: RoomStatus
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  updatedBy: string
}

export class DuplicateRoomLocationError extends Error {
  constructor() {
    super('This room number already exists on the selected property and floor.')
    this.name = 'DuplicateRoomLocationError'
  }
}

export class RoomNotFoundError extends Error {
  constructor() {
    super('This room no longer exists. Refresh the list and try again.')
    this.name = 'RoomNotFoundError'
  }
}

export class PropertyUnavailableError extends Error {
  constructor() {
    super('The selected property does not exist or is not active.')
    this.name = 'PropertyUnavailableError'
  }
}

function normalizeFloorName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function normalizeRoomNumber(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

function prepareRoomInput(
  rawInput: RoomFormValues,
): RoomFormValues {
  const input = roomFormSchema.parse(rawInput)

  return {
    ...input,
    floorName: input.floorName
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' '),
    roomNumber: normalizeRoomNumber(input.roomNumber),
    notes: input.notes.trim(),
  }
}

function getRoomRef(ownerUid: string, roomId: string) {
  const { db } = getFirebaseServices()

  return doc(db, 'users', ownerUid, 'rooms', roomId)
}

function getPropertyRef(ownerUid: string, propertyId: string) {
  const { db } = getFirebaseServices()

  return doc(
    db,
    'users',
    ownerUid,
    'properties',
    propertyId,
  )
}

function getRoomIndexRef(
  ownerUid: string,
  propertyId: string,
  floorName: string,
  roomNumber: string,
) {
  const { db } = getFirebaseServices()

  const indexId = encodeURIComponent(
    [
      propertyId,
      normalizeFloorName(floorName),
      normalizeRoomNumber(roomNumber),
    ].join('::'),
  )

  return doc(db, 'users', ownerUid, 'roomNameIndex', indexId)
}

export async function listRooms(
  ownerUid: string,
): Promise<RoomRecord[]> {
  const { db } = getFirebaseServices()

  const roomsRef = collection(db, 'users', ownerUid, 'rooms')

  const snapshot = await getDocs(
    query(roomsRef, orderBy('createdAt', 'desc')),
  )

  return snapshot.docs.map((roomDocument) => {
    const data = roomDocument.data()

    if (
      typeof data.roomCode !== 'string' ||
      parseIdentifierNumber('room', data.roomCode) === null ||
      typeof data.propertyId !== 'string' ||
      typeof data.propertyCode !== 'string' ||
      parseIdentifierNumber('property', data.propertyCode) === null ||
      typeof data.floorName !== 'string' ||
      typeof data.roomNumber !== 'string' ||
      typeof data.normalizedFloorName !== 'string' ||
      typeof data.normalizedRoomNumber !== 'string' ||
      typeof data.notes !== 'string' ||
      typeof data.createdBy !== 'string' ||
      typeof data.updatedBy !== 'string' ||
      !['vacant', 'maintenance', 'inactive'].includes(data.status)
    ) {
      throw new Error(
        `Room ${roomDocument.id} contains invalid stored data.`,
      )
    }

    return {
      id: roomDocument.id,
      roomCode: data.roomCode,
      propertyId: data.propertyId,
      propertyCode: data.propertyCode,
      floorName: data.floorName,
      roomNumber: data.roomNumber,
      normalizedFloorName: data.normalizedFloorName,
      normalizedRoomNumber: data.normalizedRoomNumber,
      notes: data.notes,
      status: data.status as RoomStatus,
      createdAt:
        data.createdAt instanceof Timestamp ? data.createdAt : null,
      updatedAt:
        data.updatedAt instanceof Timestamp ? data.updatedAt : null,
      createdBy: data.createdBy,
      updatedBy: data.updatedBy,
    }
  })
}

export async function createRoom(
  ownerUid: string,
  rawInput: RoomFormValues,
): Promise<string> {
  const input = prepareRoomInput(rawInput)

  // Verify that the property's code and status are current.
  const properties = await listProperties(ownerUid)
  const selectedProperty = properties.find(
    (property) =>
      property.id === input.propertyId &&
      property.status === 'active',
  )

  if (!selectedProperty) {
    throw new PropertyUnavailableError()
  }

  const { db } = getFirebaseServices()

  const roomsRef = collection(db, 'users', ownerUid, 'rooms')
  const roomRef = doc(roomsRef)

  const propertyRef = getPropertyRef(ownerUid, input.propertyId)

  const nameIndexRef = getRoomIndexRef(
    ownerUid,
    input.propertyId,
    input.floorName,
    input.roomNumber,
  )

  await runTransaction(db, async (transaction) => {
    const [propertySnapshot, indexSnapshot] = await Promise.all([
      transaction.get(propertyRef),
      transaction.get(nameIndexRef),
    ])

    if (
      !propertySnapshot.exists() ||
      propertySnapshot.data().status !== 'active' ||
      propertySnapshot.data().propertyCode !== selectedProperty.propertyCode
    ) {
      throw new PropertyUnavailableError()
    }

    if (indexSnapshot.exists()) {
      throw new DuplicateRoomLocationError()
    }

    const reservation = await reserveNextIdentifier(
      transaction,
      ownerUid,
      'room',
    )

    transaction.set(roomRef, {
      roomCode: reservation.code,
      propertyId: input.propertyId,
      propertyCode: selectedProperty.propertyCode,
      floorName: input.floorName,
      roomNumber: input.roomNumber,
      normalizedFloorName: normalizeFloorName(input.floorName),
      normalizedRoomNumber: normalizeRoomNumber(input.roomNumber),
      notes: input.notes,
      status: input.status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ownerUid,
      updatedBy: ownerUid,
    })

    transaction.set(nameIndexRef, {
      roomId: roomRef.id,
      propertyId: input.propertyId,
      normalizedFloorName: normalizeFloorName(input.floorName),
      normalizedRoomNumber: normalizeRoomNumber(input.roomNumber),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    commitIdentifierReservation(transaction, reservation)
  })

  return roomRef.id
}

export async function updateRoom(
  ownerUid: string,
  roomId: string,
  rawInput: RoomFormValues,
): Promise<void> {
  const input = prepareRoomInput(rawInput)
  const { db } = getFirebaseServices()

  const roomRef = getRoomRef(ownerUid, roomId)

  await runTransaction(db, async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef)

    if (!roomSnapshot.exists()) {
      throw new RoomNotFoundError()
    }

    const current = roomSnapshot.data()

    if (
      typeof current.propertyId !== 'string' ||
      typeof current.propertyCode !== 'string' ||
      typeof current.roomCode !== 'string' ||
      typeof current.normalizedFloorName !== 'string' ||
      typeof current.normalizedRoomNumber !== 'string'
    ) {
      throw new Error(
        'The saved room data is invalid. No changes were made.',
      )
    }

    // A room belongs permanently to its original property.
    if (input.propertyId !== current.propertyId) {
      throw new Error(
        'A room cannot be moved to another property. Create a new room instead.',
      )
    }

    const currentIndexRef = getRoomIndexRef(
      ownerUid,
      current.propertyId,
      current.normalizedFloorName,
      current.normalizedRoomNumber,
    )

    const nextIndexRef = getRoomIndexRef(
      ownerUid,
      current.propertyId,
      input.floorName,
      input.roomNumber,
    )

    const currentKeyChanged =
      current.normalizedFloorName !==
        normalizeFloorName(input.floorName) ||
      current.normalizedRoomNumber !==
        normalizeRoomNumber(input.roomNumber)

    const nextIndexSnapshot = await transaction.get(nextIndexRef)

    const currentIndexSnapshot = currentKeyChanged
      ? await transaction.get(currentIndexRef)
      : nextIndexSnapshot

    if (
      nextIndexSnapshot.exists() &&
      nextIndexSnapshot.data().roomId !== roomId
    ) {
      throw new DuplicateRoomLocationError()
    }

    if (
      currentKeyChanged &&
      currentIndexSnapshot.exists() &&
      currentIndexSnapshot.data().roomId === roomId
    ) {
      transaction.delete(currentIndexRef)
    }

    const previousCreatedAt = nextIndexSnapshot.data()?.createdAt

    transaction.set(nextIndexRef, {
      roomId,
      propertyId: current.propertyId,
      normalizedFloorName: normalizeFloorName(input.floorName),
      normalizedRoomNumber: normalizeRoomNumber(input.roomNumber),
      createdAt:
        previousCreatedAt instanceof Timestamp
          ? previousCreatedAt
          : serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    // Permanent room code, property reference and creation metadata stay unchanged.
    transaction.update(roomRef, {
      floorName: input.floorName,
      roomNumber: input.roomNumber,
      normalizedFloorName: normalizeFloorName(input.floorName),
      normalizedRoomNumber: normalizeRoomNumber(input.roomNumber),
      notes: input.notes,
      status: input.status,
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    })
  })
}

export function getRoomErrorMessage(error: unknown): string {
  if (
    error instanceof DuplicateRoomLocationError ||
    error instanceof RoomNotFoundError ||
    error instanceof PropertyUnavailableError ||
    error instanceof IdentifierLimitReachedError ||
    error instanceof InvalidIdentifierSequenceError
  ) {
    return error.message
  }

  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : ''

  switch (code) {
    case 'permission-denied':
    case 'firestore/permission-denied':
      return 'Database access was denied. Check the published Firestore rules and owner UID.'

    case 'unavailable':
    case 'firestore/unavailable':
      return 'Firestore is unavailable. Check your internet connection and try again.'

    case 'unauthenticated':
      return 'Your session has expired. Sign in again.'

    case 'resource-exhausted':
      return 'The Firebase quota or resource limit has been reached.'

    default:
      return error instanceof Error
        ? error.message
        : 'Something went wrong while accessing rooms.'
  }
}