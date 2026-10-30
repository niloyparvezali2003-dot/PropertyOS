import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  Check,
  Copy,
  Link2,
  LoaderCircle,
  MailPlus,
  RefreshCw,
  ShieldCheck,
  UserMinus,
  Users,
  XCircle,
} from 'lucide-react'
import {
  cancelWorkspaceInvitation,
  createWorkspaceInvitation,
  getWorkspaceInvitationExpiryDays,
  isWorkspaceInvitationExpired,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  revokeWorkspaceMember,
  type WorkspaceInvitationRecord,
  type WorkspaceMemberRecord,
} from '../services/firebase/workspace'
import './users-access.css'

type UsersAccessPageProps = {
  ownerUid: string
}

function formatDate(value: WorkspaceInvitationRecord['createdAt']): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-BD', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value.toDate())
}

export function UsersAccessPage({ ownerUid }: UsersAccessPageProps) {
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([])
  const [invitations, setInvitations] = useState<WorkspaceInvitationRecord[]>([])
  const [email, setEmail] = useState('')
  const [newInviteLink, setNewInviteLink] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        listWorkspaceMembers(ownerUid),
        listWorkspaceInvitations(ownerUid),
      ])
      setMembers(nextMembers)
      setInvitations(nextInvitations)
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load workspace members.')
    } finally {
      setLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadData()
  }, [loadData])

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setError('')
    setNotice('')
    setNewInviteLink('')
    setCopied(false)
    setSubmitting(true)
    try {
      const result = await createWorkspaceInvitation(ownerUid, email)
      setNewInviteLink(result.link)
      setEmail('')
      setNotice(`Invitation link created for ${result.invitation.invitedEmail}. Copy and share it now.`)
      await loadData()
    } catch (inviteError: unknown) {
      setError(inviteError instanceof Error ? inviteError.message : 'Unable to create this invitation.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCopyLink() {
    if (!newInviteLink) return
    try {
      await navigator.clipboard.writeText(newInviteLink)
      setCopied(true)
    } catch {
      setError('Clipboard access was blocked. Select and copy the invitation link manually.')
    }
  }

  async function handleCancelInvitation(invitationId: string) {
    if (busyId) return
    setBusyId(invitationId)
    setError('')
    setNotice('')
    try {
      await cancelWorkspaceInvitation(ownerUid, invitationId)
      setNotice('Invitation cancelled. Its link can no longer be accepted.')
      await loadData()
    } catch (cancelError: unknown) {
      setError(cancelError instanceof Error ? cancelError.message : 'Unable to cancel this invitation.')
    } finally {
      setBusyId('')
    }
  }

  async function handleRevokeMember(member: WorkspaceMemberRecord) {
    if (busyId) return
    const confirmed = window.confirm(`Remove ${member.email} from this shared workspace? They will lose access to future server data immediately.`)
    if (!confirmed) return
    setBusyId(member.uid)
    setError('')
    setNotice('')
    try {
      await revokeWorkspaceMember(ownerUid, member.uid)
      setNotice(`${member.email} no longer has workspace access.`)
      await loadData()
    } catch (revokeError: unknown) {
      setError(revokeError instanceof Error ? revokeError.message : 'Unable to remove this member.')
    } finally {
      setBusyId('')
    }
  }

  const activeMembers = members.filter((member) => member.status === 'active')
  const formerMembers = members.filter((member) => member.status === 'revoked')
  const pendingInvitations = invitations.filter((invitation) =>
    invitation.status === 'pending' && !isWorkspaceInvitationExpired(invitation),
  )
  const expiredInvitations = invitations.filter((invitation) =>
    invitation.status === 'pending' && isWorkspaceInvitationExpired(invitation),
  )

  return (
    <div className="users-access-page">
      <header className="page-header users-access-header">
        <div>
          <p className="eyebrow">Management</p>
          <h1>Users &amp; Access</h1>
          <p className="page-description">Invite trusted people to manage the same property workspace with their own accounts.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </header>

      {error && <div className="users-access-alert is-error" role="alert"><XCircle size={17} />{error}</div>}
      {notice && <div className="users-access-alert is-success" role="status"><Check size={17} />{notice}</div>}

      <section className="users-access-card invite-card">
        <div className="users-access-card-heading">
          <span className="users-access-icon"><MailPlus size={20} /></span>
          <div>
            <h2>Invite a member</h2>
            <p>They will receive full access after verifying the invited email and accepting the link.</p>
          </div>
        </div>
        <form className="users-access-invite-form" onSubmit={handleInvite}>
          <label htmlFor="workspace-invite-email">Email address</label>
          <div className="users-access-invite-controls">
            <input
              id="workspace-invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              autoCapitalize="none"
              autoComplete="email"
              maxLength={254}
              required
              disabled={submitting}
            />
            <button className="button button-primary" type="submit" disabled={submitting || !email.trim()}>
              {submitting ? <LoaderCircle className="auth-spinner" size={17} /> : <MailPlus size={17} />}
              {submitting ? 'Creating...' : 'Create invitation'}
            </button>
          </div>
          <p className="users-access-hint">Invitation links are single-use and expire after 7 days.</p>
        </form>

        {newInviteLink && (
          <div className="users-access-link-panel">
            <div className="users-access-link-title"><Link2 size={17} />New invitation link</div>
            <input aria-label="New invitation link" readOnly value={newInviteLink} onFocus={(event) => event.currentTarget.select()} />
            <button className="button button-secondary" type="button" onClick={() => void handleCopyLink()}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <p className="users-access-hint">This raw link is shown only once. Copy it now and share it privately through WhatsApp or email.</p>
          </div>
        )}
      </section>

      <section className="users-access-card">
        <div className="users-access-section-title">
          <div>
            <h2><Users size={19} /> Workspace members</h2>
            <p>{activeMembers.length} active account{activeMembers.length === 1 ? '' : 's'} · Equal full access</p>
          </div>
          <span className="users-access-count">{activeMembers.length}</span>
        </div>

        {loading ? (
          <div className="users-access-loading"><LoaderCircle className="auth-spinner" size={20} />Loading members...</div>
        ) : activeMembers.length === 0 ? (
          <p className="users-access-empty">No active members were found.</p>
        ) : (
          <div className="users-access-member-list">
            {activeMembers.map((member) => (
              <article className="users-access-member" key={member.uid}>
                <span className="users-access-avatar">{(member.displayName || member.email).slice(0, 1).toUpperCase()}</span>
                <div className="users-access-member-copy">
                  <strong>{member.displayName || member.email}</strong>
                  <span>{member.email}</span>
                  <small>{member.isWorkspaceOwner ? 'Original workspace account' : `Joined ${formatDate(member.joinedAt)}`}</small>
                </div>
                <span className="users-access-role"><ShieldCheck size={14} />Full access</span>
                {!member.isWorkspaceOwner && (
                  <button
                    className="users-access-icon-button is-danger"
                    type="button"
                    onClick={() => void handleRevokeMember(member)}
                    disabled={Boolean(busyId)}
                    aria-label={`Remove ${member.email}`}
                    title="Remove access"
                  >
                    {busyId === member.uid ? <LoaderCircle className="auth-spinner" size={17} /> : <UserMinus size={17} />}
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {formerMembers.length > 0 && (
        <section className="users-access-card">
          <div className="users-access-section-title">
            <div>
              <h2><UserMinus size={19} /> Former members</h2>
              <p>Access has been removed. Invite the same verified email again to restore that account.</p>
            </div>
            <span className="users-access-count">{formerMembers.length}</span>
          </div>
          <div className="users-access-member-list">
            {formerMembers.map((member) => (
              <article className="users-access-member" key={member.uid}>
                <span className="users-access-avatar">{(member.displayName || member.email).slice(0, 1).toUpperCase()}</span>
                <div className="users-access-member-copy">
                  <strong>{member.displayName || member.email}</strong>
                  <span>{member.email}</span>
                  <small>Access removed{member.revokedAt ? ` · ${formatDate(member.revokedAt)}` : ''}</small>
                </div>
                <span className="users-access-role is-revoked">Revoked</span>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="users-access-card">
        <div className="users-access-section-title">
          <div>
            <h2><MailPlus size={19} /> Pending invitations</h2>
            <p>Links waiting for the invited person to accept.</p>
          </div>
          <span className="users-access-count">{pendingInvitations.length}</span>
        </div>
        {loading ? (
          <div className="users-access-loading"><LoaderCircle className="auth-spinner" size={20} />Loading invitations...</div>
        ) : pendingInvitations.length === 0 ? (
          <p className="users-access-empty">There are no active pending invitations.</p>
        ) : (
          <div className="users-access-invitation-list">
            {pendingInvitations.map((invitation) => (
              <article className="users-access-invitation" key={invitation.id}>
                <div>
                  <strong>{invitation.invitedEmail}</strong>
                  <span>Created {formatDate(invitation.createdAt)} · {getWorkspaceInvitationExpiryDays(invitation)} days left</span>
                </div>
                <button
                  className="button button-ghost users-access-cancel"
                  type="button"
                  onClick={() => void handleCancelInvitation(invitation.id)}
                  disabled={Boolean(busyId)}
                >
                  {busyId === invitation.id ? <LoaderCircle className="auth-spinner" size={15} /> : <XCircle size={15} />}
                  Cancel
                </button>
              </article>
            ))}
          </div>
        )}
        {expiredInvitations.length > 0 && (
          <p className="users-access-hint">{expiredInvitations.length} invitation{expiredInvitations.length === 1 ? '' : 's'} expired. Create a new invitation to share access again.</p>
        )}
      </section>

      <p className="users-access-security-note">
        <ShieldCheck size={16} /> Each member uses a separate account. Removing access blocks future Firestore access; it cannot erase information previously downloaded or copied to another device.
      </p>
    </div>
  )
}
