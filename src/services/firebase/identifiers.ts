import {
  doc,
  serverTimestamp,
  type DocumentReference,
  type Transaction,
} from 'firebase/firestore'

import { getFirebaseServices } from './client'

export type IdentifierKind =
  | 'property'
  | 'tenant'
  | 'room'
  | 'meter'

type IdentifierPolicy = {
  sequenceDocumentId: string
  start: number
  maximum: number
  width: number
}

const TENANT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const TENANT_NUMBERS_PER_LETTER = 100_000

const IDENTIFIER_POLICIES: Record<
  IdentifierKind,
  IdentifierPolicy
> = {
  property: {
    sequenceDocumentId: 'propertySequence',
    start: 1,
    maximum: 99,
    width: 2,
  },
  tenant: {
    sequenceDocumentId: 'tenantSequence',
    start: 0,
    maximum: 2_599_999,
    width: 5,
  },
  room: {
    sequenceDocumentId: 'roomSequence',
    start: 1,
    maximum: 9_999,
    width: 4,
  },
  meter: {
    sequenceDocumentId: 'meterSequence',
    start: 1,
    maximum: 9_999,
    width: 4,
  },
}

export class IdentifierLimitReachedError extends Error {
  constructor(kind: IdentifierKind) {
    const labels: Record<IdentifierKind, string> = {
      property: 'Property',
      tenant: 'Tenant',
      room: 'Room',
      meter: 'Meter',
    }

    super(`${labels[kind]} ID limit has been reached.`)
    this.name = 'IdentifierLimitReachedError'
  }
}

export class InvalidIdentifierSequenceError extends Error {
  constructor(kind: IdentifierKind) {
    super(`The ${kind} ID sequence is invalid. No new ID was assigned.`)
    this.name = 'InvalidIdentifierSequenceError'
  }
}

export type IdentifierReservation = {
  kind: IdentifierKind
  code: string
  number: number
  nextNumber: number
  sequenceRef: DocumentReference
}

export function formatIdentifier(
  kind: IdentifierKind,
  number: number,
): string {
  const policy = IDENTIFIER_POLICIES[kind]

  if (
    !Number.isInteger(number) ||
    number < policy.start ||
    number > policy.maximum
  ) {
    throw new IdentifierLimitReachedError(kind)
  }

  if (kind === 'tenant') {
    const letterIndex = Math.floor(
      number / TENANT_NUMBERS_PER_LETTER,
    )

    const digits = number % TENANT_NUMBERS_PER_LETTER
    const letter = TENANT_LETTERS[letterIndex]

    if (!letter) {
      throw new IdentifierLimitReachedError(kind)
    }

    return `T${String(digits).padStart(5, '0')}${letter}`
  }

  const prefix = {
    property: 'P',
    room: 'R',
    meter: 'M',
  }[kind]

  return `${prefix}${String(number).padStart(policy.width, '0')}`
}

export function parseIdentifierNumber(
  kind: IdentifierKind,
  code: unknown,
): number | null {
  if (typeof code !== 'string') {
    return null
  }

  if (kind === 'tenant') {
    const match = /^T(\d{5})([A-Z])$/.exec(code)

    if (!match) {
      return null
    }

    const letterIndex = TENANT_LETTERS.indexOf(match[2])

    if (letterIndex < 0) {
      return null
    }

    const number =
      letterIndex * TENANT_NUMBERS_PER_LETTER +
      Number(match[1])

    return number <= IDENTIFIER_POLICIES.tenant.maximum
      ? number
      : null
  }

  const patterns: Record<
    Exclude<IdentifierKind, 'tenant'>,
    RegExp
  > = {
    property: /^P(\d{2})$/,
    room: /^R(\d{4})$/,
    meter: /^M(\d{4})$/,
  }

  const match = patterns[kind].exec(code)

  if (!match) {
    return null
  }

  const number = Number(match[1])
  const policy = IDENTIFIER_POLICIES[kind]

  return number >= policy.start && number <= policy.maximum
    ? number
    : null
}

export function getIdentifierSequenceRef(
  ownerUid: string,
  kind: IdentifierKind,
): DocumentReference {
  const { db } = getFirebaseServices()
  const policy = IDENTIFIER_POLICIES[kind]

  return doc(
    db,
    'users',
    ownerUid,
    'system',
    policy.sequenceDocumentId,
  )
}

export async function reserveNextIdentifier(
  transaction: Transaction,
  ownerUid: string,
  kind: IdentifierKind,
): Promise<IdentifierReservation> {
  const policy = IDENTIFIER_POLICIES[kind]
  const sequenceRef = getIdentifierSequenceRef(ownerUid, kind)

  const sequenceSnapshot = await transaction.get(sequenceRef)

  const number = sequenceSnapshot.exists()
    ? sequenceSnapshot.data().nextNumber
    : policy.start

  if (!Number.isInteger(number) || number < policy.start) {
    throw new InvalidIdentifierSequenceError(kind)
  }

  if (number > policy.maximum) {
    if (number === policy.maximum + 1) {
      throw new IdentifierLimitReachedError(kind)
    }

    throw new InvalidIdentifierSequenceError(kind)
  }

  return {
    kind,
    code: formatIdentifier(kind, number),
    number,
    nextNumber: number + 1,
    sequenceRef,
  }
}

export function commitIdentifierReservation(
  transaction: Transaction,
  reservation: IdentifierReservation,
): void {
  transaction.set(reservation.sequenceRef, {
    nextNumber: reservation.nextNumber,
    updatedAt: serverTimestamp(),
  })
}