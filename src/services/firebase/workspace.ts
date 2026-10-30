import {
  Timestamp,
  collection,
  deleteField,
  doc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import type { User } from 'firebase/auth'

import { getFirebaseServices } from './client'
import { recordAuditEvent } from './audit'

const INVITATION_LIFETIME_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export type WorkspaceMemberRecord = {
  uid: string
  email: string
  displayName: string
  role: 'full_access'
  status: 'active' | 'revoked'
  invitationId: string
  invitedBy: string
  invitedByEmail: string
  isWorkspaceOwner: boolean
  joinedAt: Timestamp | null
  createdAt: Timestamp | null
  revokedAt?: Timestamp | null
  revokedBy?: string
}

export type WorkspaceInvitationRecord = {
  id: string
  invitedEmail: string
  status: 'pending' | 'accepted' | 'revoked'
  createdBy: string
  createdByEmail: string
  createdAt: Timestamp | null
  expiresAt: Timestamp | null
  acceptedBy?: string
  acceptedAt?: Timestamp | null
  revokedBy?: string
  revokedAt?: Timestamp | null
}

export type CreatedWorkspaceInvitation = {
  invitation: WorkspaceInvitationRecord
  link: string
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function readMember(uid: string, value: Record<string, unknown>): WorkspaceMemberRecord {
  if (
    value.uid !== uid ||
    typeof value.email !== 'string' ||
    typeof value.displayName !== 'string' ||
    value.role !== 'full_access' ||
    (value.status !== 'active' && value.status !== 'revoked') ||
    typeof value.invitationId !== 'string' ||
    typeof value.invitedBy !== 'string' ||
    typeof value.invitedByEmail !== 'string' ||
    typeof value.isWorkspaceOwner !== 'boolean'
  ) {
    throw new Error(`Workspace member ${uid} contains invalid data.`)
  }

  return {
    uid,
    email: value.email,
    displayName: value.displayName,
    role: 'full_access',
    status: value.status,
    invitationId: value.invitationId,
    invitedBy: value.invitedBy,
    invitedByEmail: value.invitedByEmail,
    isWorkspaceOwner: value.isWorkspaceOwner,
    joinedAt: value.joinedAt instanceof Timestamp ? value.joinedAt : null,
    createdAt: value.createdAt instanceof Timestamp ? value.createdAt : null,
    revokedAt: value.revokedAt instanceof Timestamp ? value.revokedAt : null,
    revokedBy: typeof value.revokedBy === 'string' ? value.revokedBy : undefined,
  }
}

function readInvitation(id: string, value: Record<string, unknown>): WorkspaceInvitationRecord {
  if (
    value.invitationId !== id ||
    typeof value.invitedEmail !== 'string' ||
    !['pending', 'accepted', 'revoked'].includes(String(value.status)) ||
    typeof value.createdBy !== 'string' ||
    typeof value.createdByEmail !== 'string'
  ) {
    throw new Error(`Workspace invitation ${id} contains invalid data.`)
  }

  return {
    id,
    invitedEmail: value.invitedEmail,
    status: value.status as WorkspaceInvitationRecord['status'],
    createdBy: value.createdBy,
    createdByEmail: value.createdByEmail,
    createdAt: value.createdAt instanceof Timestamp ? value.createdAt : null,
    expiresAt: value.expiresAt instanceof Timestamp ? value.expiresAt : null,
    acceptedBy: typeof value.acceptedBy === 'string' ? value.acceptedBy : undefined,
    acceptedAt: value.acceptedAt instanceof Timestamp ? value.acceptedAt : null,
    revokedBy: typeof value.revokedBy === 'string' ? value.revokedBy : undefined,
    revokedAt: value.revokedAt instanceof Timestamp ? value.revokedAt : null,
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function currentUserOrThrow(): User {
  const { auth } = getFirebaseServices()
  if (!auth.currentUser) throw new Error('Sign in before accessing the shared workspace.')
  return auth.currentUser
}

function displayNameForUser(user: User, email: string): string {
  const value = user.displayName?.trim() || email || 'Workspace member'
  return value.slice(0, 120) || 'Workspace member'
}

function memberRef(workspaceUid: string, memberUid: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', workspaceUid, 'workspaceMembers', memberUid)
}

function invitationCollection(workspaceUid: string) {
  const { db } = getFirebaseServices()
  return collection(db, 'users', workspaceUid, 'workspaceInvitations')
}

/** Watches the signed-in member record so revocation hides the workspace promptly. */
export function observeWorkspaceMembership(
  workspaceUid: string,
  actorUid: string,
  onMemberChanged: (member: WorkspaceMemberRecord | null) => void,
  onError?: (error: Error) => void,
): () => void {
  const user = currentUserOrThrow()
  if (user.uid !== actorUid || user.uid === workspaceUid) {
    return () => undefined
  }

  return onSnapshot(
    memberRef(workspaceUid, actorUid),
    { includeMetadataChanges: true },
    (snapshot) => {
      // The App has already verified membership against the server before
      // rendering the workspace. Ignore the initial IndexedDB snapshot; only
      // server-confirmed changes may revoke the active session.
      if (snapshot.metadata.fromCache) return
      if (!snapshot.exists()) {
        onMemberChanged(null)
        return
      }
      try {
        onMemberChanged(readMember(snapshot.id, snapshot.data() as Record<string, unknown>))
      } catch (error: unknown) {
        onError?.(error instanceof Error ? error : new Error('Workspace membership data is invalid.'))
      }
    },
    (error) => onError?.(error),
  )
}

/** Reads the current user's membership from the server, never from IndexedDB cache. */
export async function getWorkspaceMembership(
  workspaceUid: string,
  actorUid?: string,
): Promise<WorkspaceMemberRecord | null> {
  const user = currentUserOrThrow()
  const targetUid = actorUid ?? user.uid
  if (!workspaceUid.trim() || targetUid !== user.uid) {
    throw new Error('Workspace membership can only be checked for the signed-in account.')
  }

  if (user.uid === workspaceUid) {
    return {
      uid: user.uid,
      email: normalizeEmail(user.email ?? ''),
      displayName: displayNameForUser(user, normalizeEmail(user.email ?? 'Workspace owner')),
      role: 'full_access',
      status: 'active',
      invitationId: '',
      invitedBy: user.uid,
      invitedByEmail: normalizeEmail(user.email ?? ''),
      isWorkspaceOwner: true,
      joinedAt: null,
      createdAt: null,
    }
  }

  const snapshot = await getDocFromServer(memberRef(workspaceUid, user.uid))
  if (!snapshot.exists()) return null
  return readMember(snapshot.id, snapshot.data() as Record<string, unknown>)
}

/** Client-side guard only. Firestore rules remain the security boundary. */
export async function assertWorkspaceAccess(workspaceUid: string): Promise<void> {
  const user = currentUserOrThrow()
  if (!workspaceUid.trim()) throw new Error('The shared workspace is not configured.')
  if (user.uid === workspaceUid) return

  const member = await getWorkspaceMembership(workspaceUid, user.uid)
  if (!member || member.status !== 'active') {
    throw new Error('Your access to this shared workspace is not active. Ask a workspace member for an invitation.')
  }
}

export async function ensureWorkspaceOwnerMember(workspaceUid: string): Promise<void> {
  const user = currentUserOrThrow()
  if (user.uid !== workspaceUid) {
    throw new Error('Only the original workspace account can initialize its owner profile.')
  }

  const { db } = getFirebaseServices()
  const ref = memberRef(workspaceUid, workspaceUid)
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (snapshot.exists()) return
    const email = normalizeEmail(user.email ?? '')
    transaction.set(ref, {
      uid: user.uid,
      email,
      displayName: displayNameForUser(user, email || 'Workspace owner'),
      role: 'full_access',
      status: 'active',
      invitationId: '',
      invitedBy: user.uid,
      invitedByEmail: email,
      isWorkspaceOwner: true,
      joinedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    })
  })
}

export async function listWorkspaceMembers(workspaceUid: string): Promise<WorkspaceMemberRecord[]> {
  await assertWorkspaceAccess(workspaceUid)
  const snapshot = await getDocs(collection(getFirebaseServices().db, 'users', workspaceUid, 'workspaceMembers'))
  return snapshot.docs
    .map((item) => readMember(item.id, item.data() as Record<string, unknown>))
    .sort((a, b) => a.email.localeCompare(b.email))
}

export async function listWorkspaceInvitations(workspaceUid: string): Promise<WorkspaceInvitationRecord[]> {
  await assertWorkspaceAccess(workspaceUid)
  const snapshot = await getDocs(query(invitationCollection(workspaceUid), orderBy('createdAt', 'desc')))
  return snapshot.docs.map((item) => readInvitation(item.id, item.data() as Record<string, unknown>))
}

export async function createWorkspaceInvitation(
  workspaceUid: string,
  rawEmail: string,
): Promise<CreatedWorkspaceInvitation> {
  const actor = currentUserOrThrow()
  await assertWorkspaceAccess(workspaceUid)

  const invitedEmail = normalizeEmail(rawEmail)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitedEmail) || invitedEmail.length > 254) {
    throw new Error('Enter a valid email address for the invitation.')
  }
  if (normalizeEmail(actor.email ?? '') === invitedEmail) {
    throw new Error('You are already signed in to this workspace. Use another email address to invite a different person.')
  }

  const [members, invitations] = await Promise.all([
    listWorkspaceMembers(workspaceUid),
    listWorkspaceInvitations(workspaceUid),
  ])
  if (members.some((member) => member.status === 'active' && normalizeEmail(member.email) === invitedEmail)) {
    throw new Error('This email address already has access to the workspace.')
  }
  const now = Date.now()
  if (invitations.some((invite) =>
    invite.status === 'pending' &&
    normalizeEmail(invite.invitedEmail) === invitedEmail &&
    (invite.expiresAt?.toMillis() ?? 0) > now
  )) {
    throw new Error('There is already an active invitation for this email address.')
  }

  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = Timestamp.fromMillis(now + INVITATION_LIFETIME_DAYS * DAY_MS)
  const { db } = getFirebaseServices()
  const invitationRef = doc(invitationCollection(workspaceUid), tokenHash)
  const invitationData = {
    invitationId: tokenHash,
    workspaceUid,
    invitedEmail,
    status: 'pending',
    createdBy: actor.uid,
    createdByEmail: normalizeEmail(actor.email ?? ''),
    createdAt: serverTimestamp(),
    expiresAt,
  }
  await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(invitationRef)
    if (existing.exists()) throw new Error('Unable to create a unique invitation. Please try again.')
    transaction.set(invitationRef, invitationData)
  })

  await recordAuditEvent(workspaceUid, {
    action: 'invitation_created',
    entityType: 'invitation',
    entityId: tokenHash,
    entityLabel: invitedEmail,
    summary: `${invitedEmail} was invited by ${normalizeEmail(actor.email ?? 'a workspace member')}.`,
  })

  const linkUrl = new URL(window.location.href)
  linkUrl.search = ''
  linkUrl.hash = ''
  linkUrl.searchParams.set('workspaceInvite', workspaceUid)
  linkUrl.searchParams.set('inviteToken', token)

  return {
    invitation: {
      id: tokenHash,
      invitedEmail,
      status: 'pending',
      createdBy: actor.uid,
      createdByEmail: normalizeEmail(actor.email ?? ''),
      createdAt: Timestamp.now(),
      expiresAt,
    },
    link: linkUrl.toString(),
  }
}

export async function acceptWorkspaceInvitation(
  workspaceUid: string,
  token: string,
): Promise<void> {
  const user = currentUserOrThrow()
  if (!user.emailVerified) throw new Error('Verify your email address before accepting this invitation.')
  const email = normalizeEmail(user.email ?? '')
  if (!email) throw new Error('Your signed-in account does not have a verified email address.')

  const tokenHash = await sha256Hex(token)
  const { db } = getFirebaseServices()
  const inviteRef = doc(db, 'users', workspaceUid, 'workspaceInvitations', tokenHash)
  const memberDocument = memberRef(workspaceUid, user.uid)
  let wasPreviouslyRevoked = false
  let wasAlreadyAccepted = false
  let previousMemberDisplayName = ''

  await runTransaction(db, async (transaction) => {
    wasPreviouslyRevoked = false
    wasAlreadyAccepted = false
    previousMemberDisplayName = ''
    const [inviteSnapshot, memberSnapshot] = await Promise.all([
      transaction.get(inviteRef),
      transaction.get(memberDocument),
    ])

    if (!inviteSnapshot.exists()) throw new Error('This invitation link is invalid or has already been removed.')
    const invitation = readInvitation(inviteSnapshot.id, inviteSnapshot.data() as Record<string, unknown>)
    if (invitation.status === 'accepted' && invitation.acceptedBy === user.uid && memberSnapshot.exists()) {
      const existingMember = readMember(memberSnapshot.id, memberSnapshot.data() as Record<string, unknown>)
      if (existingMember.status === 'active' && existingMember.invitationId === tokenHash) {
        wasAlreadyAccepted = true
        return
      }
    }
    if (invitation.status !== 'pending') throw new Error('This invitation has already been used or cancelled.')
    if (!invitation.expiresAt || invitation.expiresAt.toMillis() <= Date.now()) {
      throw new Error('This invitation has expired. Ask a workspace member to send a new one.')
    }
    if (normalizeEmail(invitation.invitedEmail) !== email) {
      throw new Error(`This invitation was sent to ${invitation.invitedEmail}. Sign in with that verified email address.`)
    }
    if (memberSnapshot.exists()) {
      const existingMember = readMember(memberSnapshot.id, memberSnapshot.data() as Record<string, unknown>)
      if (existingMember.status === 'active') {
        throw new Error('This account already has an active workspace membership.')
      }
      wasPreviouslyRevoked = true
      previousMemberDisplayName = existingMember.displayName
    }

    const memberData = {
      email,
      displayName: wasPreviouslyRevoked
        ? previousMemberDisplayName
        : displayNameForUser(user, email),
      role: 'full_access' as const,
      status: 'active' as const,
      invitationId: tokenHash,
      invitedBy: invitation.createdBy,
      invitedByEmail: invitation.createdByEmail,
      isWorkspaceOwner: false,
      joinedAt: serverTimestamp(),
    }
    if (memberSnapshot.exists()) {
      // A previously revoked account can rejoin only through this new,
      // verified, single-use invitation. Keep its original UID and createdAt.
      transaction.update(memberDocument, {
        ...memberData,
        revokedBy: deleteField(),
        revokedAt: deleteField(),
      })
    } else {
      transaction.set(memberDocument, {
        uid: user.uid,
        ...memberData,
        createdAt: serverTimestamp(),
      })
    }
    transaction.update(inviteRef, {
      status: 'accepted',
      acceptedBy: user.uid,
      acceptedAt: serverTimestamp(),
    })
  })

  if (!wasAlreadyAccepted) {
    await recordAuditEvent(workspaceUid, {
      action: 'invitation_accepted',
      entityType: 'member',
      entityId: user.uid,
      entityLabel: user.displayName?.trim() || email,
      summary: wasPreviouslyRevoked
        ? `${email} regained workspace access after accepting a new invitation.`
        : `${email} accepted a shared workspace invitation.`,
    })
  }
}

export async function cancelWorkspaceInvitation(workspaceUid: string, invitationId: string): Promise<void> {
  const actor = currentUserOrThrow()
  await assertWorkspaceAccess(workspaceUid)
  const ref = doc(getFirebaseServices().db, 'users', workspaceUid, 'workspaceInvitations', invitationId)
  await runTransaction(getFirebaseServices().db, async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists()) throw new Error('Invitation not found.')
    if (snapshot.data().status !== 'pending') throw new Error('Only pending invitations can be cancelled.')
    transaction.update(ref, {
      status: 'revoked',
      revokedBy: actor.uid,
      revokedAt: serverTimestamp(),
    })
  })
  await recordAuditEvent(workspaceUid, {
    action: 'invitation_cancelled',
    entityType: 'invitation',
    entityId: invitationId,
    entityLabel: 'Invitation',
    summary: `A pending invitation was cancelled by ${normalizeEmail(actor.email ?? 'a workspace member')}.`,
  })
}

export async function revokeWorkspaceMember(workspaceUid: string, memberUid: string): Promise<void> {
  const actor = currentUserOrThrow()
  await assertWorkspaceAccess(workspaceUid)
  if (memberUid === workspaceUid || memberUid === actor.uid) {
    throw new Error('The workspace owner and your current account cannot be removed from this screen.')
  }
  const ref = memberRef(workspaceUid, memberUid)
  let revokedMemberEmail = ''
  await runTransaction(getFirebaseServices().db, async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists()) throw new Error('Workspace member not found.')
    const member = readMember(snapshot.id, snapshot.data() as Record<string, unknown>)
    if (member.isWorkspaceOwner) throw new Error('The original workspace owner cannot be removed.')
    if (member.status !== 'active') throw new Error('This member is already inactive.')
    revokedMemberEmail = member.email
    transaction.update(ref, {
      status: 'revoked',
      revokedBy: actor.uid,
      revokedAt: serverTimestamp(),
    })
  })
  await recordAuditEvent(workspaceUid, {
    action: 'member_revoked',
    entityType: 'member',
    entityId: memberUid,
    entityLabel: revokedMemberEmail,
    summary: `${revokedMemberEmail} was removed from the shared workspace.`,
  })
}

export function getInvitationUrlState(): { workspaceUid: string; token: string } | null {
  const params = new URLSearchParams(window.location.search)
  const workspaceUid = params.get('workspaceInvite')?.trim() ?? ''
  const token = params.get('inviteToken')?.trim() ?? ''
  if (!workspaceUid || !/^[a-fA-F0-9]{64}$/.test(token)) return null
  return { workspaceUid, token }
}

export function clearInvitationUrlState(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('workspaceInvite')
  url.searchParams.delete('inviteToken')
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
}

export function isWorkspaceInvitationExpired(invitation: WorkspaceInvitationRecord): boolean {
  return !invitation.expiresAt || invitation.expiresAt.toMillis() <= Date.now()
}

export function getWorkspaceInvitationExpiryDays(invitation: WorkspaceInvitationRecord): number {
  if (!invitation.expiresAt) return 0
  return Math.max(0, Math.ceil((invitation.expiresAt.toMillis() - Date.now()) / DAY_MS))
}
