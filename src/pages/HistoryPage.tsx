import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Mail,
  Bolt,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  DoorOpen,
  Gauge,
  History,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import {
  getAuditErrorMessage,
  listAuditEvents,
  type AuditEntityType,
  type AuditEventRecord,
} from '../services/firebase/audit'
import { listWorkspaceMembers, type WorkspaceMemberRecord } from '../services/firebase/workspace'
import './history.css'

type HistoryPageProps = {
  ownerUid: string
}

const entityOptions: { value: 'all' | AuditEntityType; label: string }[] = [
  { value: 'all', label: 'All record types' },
  { value: 'property', label: 'Properties' },
  { value: 'room', label: 'Rooms' },
  { value: 'tenant', label: 'Tenants' },
  { value: 'tenant_assignment', label: 'Tenant assignments' },
  { value: 'meter', label: 'Meters' },
  { value: 'meter_assignment', label: 'Meter assignments' },
  { value: 'rent_rate', label: 'Rent rates' },
  { value: 'rent_bills', label: 'Rent bills' },
  { value: 'electricity_rate', label: 'Electricity rates' },
  { value: 'electricity_bill', label: 'Electricity bills' },
  { value: 'payment', label: 'Payments' },
  { value: 'credit_application', label: 'Advance applications' },
  { value: 'opening_balance', label: 'Opening balances' },
  { value: 'member', label: 'Workspace members' },
  { value: 'invitation', label: 'Invitations' },
]

const actionLabels: Record<AuditEventRecord['action'], string> = {
  created: 'Created',
  updated: 'Updated',
  assigned: 'Assigned',
  moved_out: 'Move-out recorded',
  replaced: 'Replaced',
  rate_added: 'Rate added',
  bills_generated: 'Bills generated',
  bill_issued: 'Bill issued',
  payment_recorded: 'Payment recorded',
  credit_applied: 'Advance applied',
  opening_balance_added: 'Opening balance added',
  opening_balance_adjusted: 'Opening balance adjusted',
  invitation_created: 'Invitation created',
  invitation_accepted: 'Invitation accepted',
  invitation_cancelled: 'Invitation cancelled',
  member_revoked: 'Member access removed',
}

function eventIcon(entityType: AuditEntityType): LucideIcon {
  switch (entityType) {
    case 'property': return Building2
    case 'room': return DoorOpen
    case 'tenant':
    case 'tenant_assignment': return Users
    case 'meter':
    case 'meter_assignment': return Gauge
    case 'rent_rate':
    case 'rent_bills': return ClipboardList
    case 'electricity_rate':
    case 'electricity_bill': return Bolt
    case 'payment':
    case 'credit_application': return Wallet
    case 'opening_balance': return Wallet
    case 'member': return Users
    case 'invitation': return Mail
    default: return Activity
  }
}

function formatDate(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return 'Time unavailable'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(value)
}

function getDhakaDate(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function entityLabel(value: AuditEntityType): string {
  return entityOptions.find((option) => option.value === value)?.label ?? 'Record'
}

export function HistoryPage({ ownerUid }: HistoryPageProps) {
  const [events, setEvents] = useState<AuditEventRecord[]>([])
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([])
  const [search, setSearch] = useState('')
  const [entityFilter, setEntityFilter] = useState<'all' | AuditEntityType>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [pageError, setPageError] = useState('')

  const loadEvents = useCallback(async () => {
    setIsLoading(true)
    setPageError('')
    try {
      const [eventsResult, membersResult] = await Promise.allSettled([
        listAuditEvents(ownerUid),
        listWorkspaceMembers(ownerUid),
      ])
      if (eventsResult.status === 'rejected') throw eventsResult.reason
      setEvents(eventsResult.value)
      if (membersResult.status === 'fulfilled') {
        setMembers(membersResult.value)
      } else {
        // Keep the activity timeline available if member names cannot be loaded.
        // Actor UIDs remain visible as a fallback.
        setMembers([])
      }
    } catch (error: unknown) {
      setPageError(getAuditErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.uid, member.displayName || member.email])),
    [members],
  )

  const filteredEvents = useMemo(() => {
    const term = search.trim().toLowerCase()
    return events.filter((event) => {
      if (entityFilter !== 'all' && event.entityType !== entityFilter) return false
      const date = getDhakaDate(event.occurredAt?.toDate() ?? null)
      if (fromDate && (!date || date < fromDate)) return false
      if (toDate && (!date || date > toDate)) return false
      if (!term) return true
      return [
        event.entityLabel,
        event.entityId,
        event.summary,
        actionLabels[event.action],
        entityLabel(event.entityType),
        memberNames.get(event.actorUid) ?? event.actorUid,
        event.actorUid,
      ].join(' ').toLowerCase().includes(term)
    })
  }, [entityFilter, events, fromDate, memberNames, search, toDate])

  const lastSevenDays = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    return events.filter((event) => (event.occurredAt?.toMillis() ?? 0) >= cutoff).length
  }, [events])

  const uniqueRecordTypes = useMemo(
    () => new Set(events.map((event) => event.entityType)).size,
    [events],
  )

  function clearFilters() {
    setSearch('')
    setEntityFilter('all')
    setFromDate('')
    setToDate('')
  }

  const hasFilters = Boolean(search || entityFilter !== 'all' || fromDate || toDate)

  return (
    <div className="history-page">
      <header className="page-heading history-heading">
        <div>
          <p className="eyebrow">Management</p>
          <h1>History &amp; Audit Trail</h1>
          <p className="page-description">
            Search an append-only timeline of changes recorded by this version of PropertyOS.
          </p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void loadEvents()} disabled={isLoading}>
          {isLoading ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}
          Refresh
        </button>
      </header>

      <section className="history-stat-grid" aria-label="History summary">
        <article className="history-stat-card">
          <span className="history-stat-icon history-stat-icon--blue"><History size={19} /></span>
          <div><span>Loaded events</span><strong>{events.length.toLocaleString('en-BD')}</strong></div>
        </article>
        <article className="history-stat-card">
          <span className="history-stat-icon history-stat-icon--green"><Activity size={19} /></span>
          <div><span>Last 7 days</span><strong>{lastSevenDays.toLocaleString('en-BD')}</strong></div>
        </article>
        <article className="history-stat-card">
          <span className="history-stat-icon history-stat-icon--amber"><SlidersHorizontal size={19} /></span>
          <div><span>Record types used</span><strong>{uniqueRecordTypes}</strong></div>
        </article>
      </section>

      <section className="history-filter-panel" aria-label="Filter history">
        <div className="history-filter-search">
          <SearchInput value={search} onChange={setSearch} placeholder="Search names, references, or activity..." />
        </div>
        <label className="history-filter-field">
          <span>Record type</span>
          <select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as 'all' | AuditEntityType)}>
            {entityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="history-filter-field">
          <span>From date</span>
          <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="history-filter-field">
          <span>To date</span>
          <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} />
        </label>
        {hasFilters && (
          <button className="history-clear-button" type="button" onClick={clearFilters}>
            <X size={15} /> Clear
          </button>
        )}
      </section>

      {pageError && (
        <div className="history-error" role="alert">
          <div><strong>History could not be loaded</strong><span>{pageError}</span></div>
          <button type="button" className="button button-secondary" onClick={() => void loadEvents()}>Try again</button>
        </div>
      )}

      <section className="history-list-panel" aria-labelledby="history-list-heading">
        <div className="history-list-heading">
          <div><h2 id="history-list-heading">Activity log</h2><p>Newest activity appears first. Showing up to 500 recent events.</p></div>
          <span className="history-result-count">{filteredEvents.length} {filteredEvents.length === 1 ? 'event' : 'events'}</span>
        </div>

        {isLoading ? (
          <div className="history-empty-state"><LoaderCircle size={21} className="animate-spin" /><span>Loading activity history…</span></div>
        ) : filteredEvents.length === 0 ? (
          <div className="history-empty-state">
            <span className="history-empty-icon"><CalendarClock size={23} /></span>
            <strong>{events.length === 0 && !hasFilters ? 'No recorded activity yet' : 'No matching activity'}</strong>
            <p>{events.length === 0 && !hasFilters
              ? 'New changes recorded by this version will appear here. Existing actions from before audit logging was installed cannot be reconstructed automatically.'
              : 'Try a different search or clear the filters to see more events.'}</p>
            {hasFilters && <button type="button" className="button button-secondary" onClick={clearFilters}>Clear filters</button>}
          </div>
        ) : (
          <div className="history-event-list">
            {filteredEvents.map((event) => {
              const Icon = eventIcon(event.entityType)
              return (
                <article className="history-event-row" key={event.id}>
                  <span className={`history-event-icon history-event-icon--${event.entityType.replace(/_/g, '-')}`}><Icon size={18} aria-hidden="true" /></span>
                  <div className="history-event-copy">
                    <div className="history-event-title-row">
                      <strong>{event.entityLabel}</strong>
                      <span className="history-action-chip">{actionLabels[event.action]}</span>
                    </div>
                    <p>{event.summary}</p>
                    <div className="history-event-meta">
                      <span>By {memberNames.get(event.actorUid) ?? `Account ${event.actorUid.slice(0, 8)}`}</span>
                      <span aria-hidden="true">·</span>
                      <span>{entityLabel(event.entityType)}</span>
                      <span aria-hidden="true">·</span>
                      <span>Ref: {event.entityId}</span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={event.occurredAt?.toDate().toISOString()}>{formatDate(event.occurredAt?.toDate() ?? null)}</time>
                    </div>
                  </div>
                  <CheckCircle2 className="history-event-check" size={16} aria-label="Recorded" />
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
