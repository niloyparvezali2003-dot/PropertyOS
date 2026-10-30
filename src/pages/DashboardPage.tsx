import { invalidateOwnerDataCache } from '../services/firebase/listCache'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  Building2,
  DoorOpen,
  FileText,
  Gauge,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { StatCard } from '../components/ui/StatCard'

import {
  listProperties,
  type PropertyRecord,
} from '../services/firebase/properties'

import {
  listRooms,
  type RoomRecord,
} from '../services/firebase/rooms'

import {
  listTenants,
  type TenantRecord,
} from '../services/firebase/tenants'

import {
  listTenantAssignments,
  type TenantAssignmentRecord,
} from '../services/firebase/tenantAssignments'

import {
  listMeters,
  type MeterRecord,
} from '../services/firebase/meters'

import {
  listRentBills,
  type RentBillRecord,
} from '../services/firebase/rentBills'

import {
  listElectricityBills,
  type ElectricityBillRecord,
} from '../services/firebase/electricity'

import {
  listPayments,
  listPaymentBillBalances,
  type PaymentRecord,
  type PaymentBillBalanceRecord,
} from '../services/firebase/payments'
import { listOpeningBalances, type OpeningBalanceRecord } from '../services/firebase/openingBalances'

import type { Timestamp } from 'firebase/firestore'
import type { AppPage } from '../types/navigation'

type DashboardPageProps = {
  ownerUid: string
  searchValue: string
  onSearchChange: (value: string) => void
  onNavigate: (page: AppPage) => void
}

type DashboardData = {
  properties: PropertyRecord[]
  rooms: RoomRecord[]
  tenants: TenantRecord[]
  assignments: TenantAssignmentRecord[]
  meters: MeterRecord[]
  rentBills: RentBillRecord[]
  electricityBills: ElectricityBillRecord[]
  payments: PaymentRecord[]
  billBalances: PaymentBillBalanceRecord[]
  openingBalances: OpeningBalanceRecord[]
}

type ActivityTone = 'blue' | 'amber' | 'green' | 'purple'

type DashboardActivity = {
  id: string
  title: string
  detail: string
  date: string
  amount?: string
  icon: LucideIcon
  tone: ActivityTone
  sortAt: number
  searchableText: string
}

function formatMoney(minor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)}`
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-BD')
}

function formatTimestamp(value: Timestamp | null): string {
  if (!value) return 'Time unavailable'

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(value.toDate())
}

function timestampMillis(value: Timestamp | null): number {
  return value?.toMillis() ?? 0
}

function dateOnlyMillis(value: string): number {
  const date = new Date(`${value}T12:00:00+06:00`)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}

function formatDateOnly(value: string): string {
  const date = new Date(`${value}T12:00:00+06:00`)

  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable'
  }

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function safePositiveMinor(value: number): number {
  return Number.isSafeInteger(value) && value > 0
    ? value
    : 0
}

function calculateOutstanding(data: DashboardData): number {
  const balancesByKey = new Map<
    string,
    PaymentBillBalanceRecord
  >()

  for (const balance of data.billBalances) {
    balancesByKey.set(
      `${balance.billType}:${balance.billId}`,
      balance,
    )
  }

  let total = 0

  for (const bill of data.rentBills) {
    if (bill.status !== 'issued') continue

    const savedBalance = balancesByKey.get(`rent:${bill.id}`)

    const dueMinor = savedBalance
      ? savedBalance.outstandingMinor
      : bill.totalMinor

    total += safePositiveMinor(dueMinor)
  }

  for (const bill of data.electricityBills) {
    if (bill.status !== 'issued') continue

    const savedBalance = balancesByKey.get(
      `electricity:${bill.id}`,
    )

    const dueMinor = savedBalance
      ? savedBalance.outstandingMinor
      : bill.amountMinor

    total += safePositiveMinor(dueMinor)
  }

  return total + data.openingBalances.reduce((sum, balance) => sum + safePositiveMinor(balance.outstandingMinor), 0)
}

function makeActivity(
  activity: Omit<DashboardActivity, 'searchableText'>,
): DashboardActivity {
  return {
    ...activity,
    searchableText: [
      activity.title,
      activity.detail,
      activity.date,
      activity.amount ?? '',
    ].join(' ').toLowerCase(),
  }
}

/**
 * Builds the activity list only from persisted records.
 * These are record-based activity summaries, not fabricated audit events.
 */
function buildRecentActivity(
  data: DashboardData,
): DashboardActivity[] {
  const activities: DashboardActivity[] = []

  for (const payment of data.payments) {
    activities.push(
      makeActivity({
        id: `payment:${payment.id}`,
        title: 'Payment received',
        detail:
          `${payment.tenantName} · ${payment.transactionId ? `TRX ID: ${payment.transactionId}` : `Legacy receipt ID: ${payment.receiptNumber}`}` +
          (payment.reference ? ` · ${payment.reference}` : ''),
        date: payment.createdAt
          ? formatTimestamp(payment.createdAt)
          : formatDateOnly(payment.paidOn),
        amount: `+ ${formatMoney(payment.amountMinor)}`,
        icon: Wallet,
        tone: 'green',
        sortAt:
          timestampMillis(payment.createdAt) ||
          dateOnlyMillis(payment.paidOn),
      }),
    )
  }

  for (const bill of data.rentBills) {
    activities.push(
      makeActivity({
        id: `rent:${bill.id}`,
        title: 'Rent bill issued',
        detail:
          `${bill.tenantName} · Room ${bill.roomNumber} · ` +
          `${bill.billingMonth}`,
        date: bill.createdAt
          ? formatTimestamp(bill.createdAt)
          : `Billing month ${bill.billingMonth}`,
        amount: formatMoney(bill.totalMinor),
        icon: ReceiptText,
        tone: 'blue',
        sortAt:
          timestampMillis(bill.createdAt) ||
          dateOnlyMillis(`${bill.billingMonth}-01`),
      }),
    )
  }

  for (const bill of data.electricityBills) {
    activities.push(
      makeActivity({
        id: `electricity:${bill.id}`,
        title: 'Electricity bill issued',
        detail:
          `${bill.roomCode} · ${bill.meterCode} · ` +
          `${bill.unitsConsumed} units`,
        date: bill.createdAt
          ? formatTimestamp(bill.createdAt)
          : `Reading date ${formatDateOnly(bill.readingDate)}`,
        amount: formatMoney(bill.amountMinor),
        icon: Zap,
        tone: 'amber',
        sortAt:
          timestampMillis(bill.createdAt) ||
          dateOnlyMillis(bill.readingDate),
      }),
    )
  }

  for (const assignment of data.assignments) {
    const hasMovedOut = assignment.status === 'ended'
    const timestamp = hasMovedOut
      ? assignment.updatedAt ?? assignment.createdAt
      : assignment.createdAt

    activities.push(
      makeActivity({
        id: `assignment:${assignment.id}`,
        title: hasMovedOut
          ? 'Tenant move-out recorded'
          : 'Tenant assigned to room',
        detail:
          `${assignment.tenantName} · Room ${assignment.roomCode}`,
        date: formatTimestamp(timestamp),
        icon: Users,
        tone: hasMovedOut ? 'purple' : 'green',
        sortAt: timestampMillis(timestamp),
      }),
    )
  }

  for (const property of data.properties) {
    activities.push(
      makeActivity({
        id: `property:${property.id}`,
        title: 'Property record',
        detail: `${property.name} · ${property.propertyCode}`,
        date: formatTimestamp(property.createdAt),
        icon: Building2,
        tone: 'blue',
        sortAt: timestampMillis(property.createdAt),
      }),
    )
  }

  for (const room of data.rooms) {
    activities.push(
      makeActivity({
        id: `room:${room.id}`,
        title: 'Room record',
        detail:
          `Room ${room.roomNumber} · ${room.floorName} · ` +
          `${room.propertyCode}`,
        date: formatTimestamp(room.createdAt),
        icon: DoorOpen,
        tone: 'purple',
        sortAt: timestampMillis(room.createdAt),
      }),
    )
  }

  for (const tenant of data.tenants) {
    activities.push(
      makeActivity({
        id: `tenant:${tenant.id}`,
        title: 'Tenant record',
        detail: `${tenant.fullName} · ${tenant.tenantCode}`,
        date: formatTimestamp(tenant.createdAt),
        icon: Users,
        tone: 'green',
        sortAt: timestampMillis(tenant.createdAt),
      }),
    )
  }

  for (const meter of data.meters) {
    activities.push(
      makeActivity({
        id: `meter:${meter.id}`,
        title: 'Meter record',
        detail: `${meter.meterCode} · ${meter.status}`,
        date: formatTimestamp(meter.createdAt),
        icon: Gauge,
        tone: 'amber',
        sortAt: timestampMillis(meter.createdAt),
      }),
    )
  }

  return activities.sort((a, b) => b.sortAt - a.sortAt)
}

export function DashboardPage({
  ownerUid,
  searchValue,
  onSearchChange,
  onNavigate,
}: DashboardPageProps) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState('')

  const loadDashboard = useCallback(async (
    refresh = false,
  ) => {
    if (refresh) invalidateOwnerDataCache(ownerUid)
    setError('')

    if (refresh) {
      setIsRefreshing(true)
    } else {
      setIsLoading(true)
    }

    try {
      const [
        properties,
        rooms,
        tenants,
        assignments,
        meters,
        rentBills,
        electricityBills,
        payments,
        billBalances,
        openingBalances,
      ] = await Promise.all([
        listProperties(ownerUid),
        listRooms(ownerUid),
        listTenants(ownerUid),
        listTenantAssignments(ownerUid),
        listMeters(ownerUid),
        listRentBills(ownerUid),
        listElectricityBills(ownerUid),
        listPayments(ownerUid),
        listPaymentBillBalances(ownerUid),
        listOpeningBalances(ownerUid),
      ])

      setData({
        properties,
        rooms,
        tenants,
        assignments,
        meters,
        rentBills,
        electricityBills,
        payments,
        billBalances,
        openingBalances,
      })
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load Dashboard data from Firebase.',
      )
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const summary = useMemo(() => {
    if (!data) return null

    const activeProperties = data.properties.filter(
      (property) => property.status === 'active',
    )

    const usableRooms = data.rooms.filter(
      (room) => room.status !== 'inactive',
    )

    const usableRoomIds = new Set(
      usableRooms.map((room) => room.id),
    )

    const currentAssignments = data.assignments.filter(
      (assignment) =>
        assignment.status === 'current' &&
        assignment.moveOutDate === null &&
        usableRoomIds.has(assignment.roomId),
    )

    const occupiedRoomIds = new Set(
      currentAssignments.map((assignment) => assignment.roomId),
    )

    const currentTenantIds = new Set(
      currentAssignments.map((assignment) => assignment.tenantId),
    )

    const totalRooms = usableRooms.length
    const occupiedRooms = occupiedRoomIds.size

    const occupancyPercent = totalRooms > 0
      ? Math.round((occupiedRooms / totalRooms) * 100)
      : 0

    return {
      activePropertyCount: activeProperties.length,
      allPropertyCount: data.properties.length,
      totalRooms,
      allRoomRecords: data.rooms.length,
      occupiedRooms,
      occupancyPercent,
      currentTenantCount: currentTenantIds.size,
      outstandingMinor: calculateOutstanding(data),
    }
  }, [data])

  const activities = useMemo(
    () => data ? buildRecentActivity(data) : [],
    [data],
  )

  const filteredActivity = useMemo(() => {
    const query = searchValue.trim().toLowerCase()

    const matches = query
      ? activities.filter((activity) =>
        activity.searchableText.includes(query),
      )
      : activities

    return matches.slice(0, query ? 12 : 6)
  }, [activities, searchValue])

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>Dashboard</h1>
          <p className="page-description">
            Your property and financial overview, based on saved records.
          </p>
        </div>

        <div className="dashboard-heading-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void loadDashboard(true)}
            disabled={isLoading || isRefreshing}
          >
            {isRefreshing
              ? <LoaderCircle size={17} className="animate-spin" />
              : <RefreshCw size={17} />
            }
            Refresh
          </button>

          <button
            className="button button-primary"
            type="button"
            onClick={() => onNavigate('Properties')}
          >
            <Building2 size={18} />
            Add property
          </button>
        </div>
      </header>

      {error && (
        <div className="demo-notice dashboard-load-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />

          <p>
            <strong>Dashboard data could not be refreshed.</strong>
            {' '}{error}
          </p>

          <button
            className="button button-secondary"
            type="button"
            onClick={() => void loadDashboard(true)}
            disabled={isRefreshing}
          >
            Try again
          </button>
        </div>
      )}

      <div className="demo-notice" role="status">
        <span className="demo-notice-dot" />
        <p>
          <strong>{data ? 'Live records:' : 'Connecting:'}</strong>{' '}
          {data
            ? 'Dashboard figures come from your saved PropertyOS records. No demo values are used.'
            : 'Loading your saved Firebase records.'}
        </p>
      </div>

      <div className="dashboard-toolbar">
        <SearchInput
          value={searchValue}
          onChange={onSearchChange}
          placeholder="Search recent records..."
        />
      </div>

      <section className="stats-grid" aria-label="Property overview">
        <StatCard
          label="Active properties"
          value={
            summary
              ? formatNumber(summary.activePropertyCount)
              : '—'
          }
          note={
            summary
              ? `${formatNumber(summary.allPropertyCount)} total records`
              : isLoading ? 'Loading records' : 'Unavailable'
          }
          icon={Building2}
          tone="blue"
        />

        <StatCard
          label="Total rooms"
          value={
            summary
              ? formatNumber(summary.totalRooms)
              : '—'
          }
          note={
            summary
              ? `${formatNumber(summary.allRoomRecords)} saved room records`
              : isLoading ? 'Loading records' : 'Unavailable'
          }
          icon={DoorOpen}
          tone="purple"
        />

        <StatCard
          label="Occupied rooms"
          value={
            summary
              ? `${formatNumber(summary.occupiedRooms)} / ${formatNumber(summary.totalRooms)}`
              : '—'
          }
          note={
            summary
              ? `${summary.occupancyPercent}% occupancy · ${formatNumber(summary.currentTenantCount)} current tenants`
              : isLoading ? 'Loading records' : 'Unavailable'
          }
          icon={Users}
          tone="green"
        />

        <StatCard
          label="Outstanding balance"
          value={
            summary
              ? formatMoney(summary.outstandingMinor)
              : '—'
          }
          note={
            summary
              ? 'Unpaid issued rent and electricity bills'
              : isLoading ? 'Loading records' : 'Unavailable'
          }
          icon={Wallet}
          tone="amber"
        />
      </section>

      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recent activity</h2>
              <p>
                Saved bills, payments, assignments, and records
              </p>
            </div>

            <button
              className="text-button"
              type="button"
              onClick={() => onNavigate('History')}
            >
              View history
              <ArrowUpRight size={16} />
            </button>
          </div>

          <div className="activity-list">
            {isLoading && !data ? (
              <div className="dashboard-empty-state" role="status">
                <LoaderCircle size={21} className="animate-spin" />
                <span>Loading saved activity...</span>
              </div>
            ) : filteredActivity.length > 0 ? (
              filteredActivity.map((activity) => {
                const Icon = activity.icon

                return (
                  <div className="activity-item" key={activity.id}>
                    <span
                      className={`activity-icon activity-icon--${activity.tone}`}
                    >
                      <Icon size={19} aria-hidden="true" />
                    </span>

                    <div className="activity-copy">
                      <strong>{activity.title}</strong>
                      <span>{activity.detail}</span>
                      <small>{activity.date}</small>
                    </div>

                    {activity.amount && (
                      <span className="activity-amount">
                        {activity.amount}
                      </span>
                    )}
                  </div>
                )
              })
            ) : error && !data ? (
              <div className="dashboard-empty-state">
                <AlertCircle size={22} />
                <span>Activity could not be loaded.</span>
              </div>
            ) : (
              <div className="dashboard-empty-state">
                <FileText size={23} />
                <strong>
                  {searchValue.trim()
                    ? 'No records match your search.'
                    : 'No saved activity records yet.'}
                </strong>
                <span>
                  Saved properties, bills, assignments, and payments
                  will appear here when available.
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Quick actions</h2>
              <p>Navigate to a PropertyOS module</p>
            </div>
          </div>

          <div className="quick-actions">
            {[
              {
                label: 'Manage properties',
                detail: 'View and update properties',
                icon: Building2,
                page: 'Properties' as AppPage,
              },
              {
                label: 'Manage tenants',
                detail: 'View tenant records',
                icon: Users,
                page: 'Tenants' as AppPage,
              },
              {
                label: 'Manage bills',
                detail: 'Rent and electricity billing',
                icon: FileText,
                page: 'Rent & Bills' as AppPage,
              },
              {
                label: 'View payments',
                detail: 'Review saved receipts',
                icon: Wallet,
                page: 'Payments' as AppPage,
              },
              {
                label: 'View ledgers',
                detail: 'Tenant, room, and meter balances',
                icon: ReceiptText,
                page: 'Ledgers' as AppPage,
              },
              {
                label: 'Financial reports',
                detail: 'Monthly billing and collections',
                icon: Zap,
                page: 'Reports' as AppPage,
              },
            ].map((action) => {
              const Icon = action.icon

              return (
                <button
                  type="button"
                  className="quick-action"
                  key={action.label}
                  onClick={() => onNavigate(action.page)}
                >
                  <span className="quick-action-icon">
                    <Icon size={19} aria-hidden="true" />
                  </span>

                  <span className="quick-action-copy">
                    <strong>{action.label}</strong>
                    <small>{action.detail}</small>
                  </span>

                  <ArrowUpRight
                    className="quick-action-arrow"
                    size={17}
                    aria-hidden="true"
                  />
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </>
  )
}