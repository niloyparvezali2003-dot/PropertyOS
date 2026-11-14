import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  RefreshCw,
  ReceiptText,
  Wallet,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import {
  type RentBillRecord,
  listRentBills,
} from '../services/firebase/rentBills'
import {
  type PaymentBillBalanceRecord,
  listPaymentBillBalances,
} from '../services/firebase/payments'
import { invalidateOwnerDataCache } from '../services/firebase/listCache'
import type { AppPage } from '../types/navigation'
import './current-month-collection.css'

type CurrentMonthCollectionPageProps = {
  ownerUid: string
  onNavigate: (page: AppPage) => void
}

type CollectionStatus = 'paid' | 'partial' | 'unpaid'
type StatusFilter = 'all' | 'outstanding' | CollectionStatus

type CollectionRow = {
  bill: RentBillRecord
  paidAmountMinor: number
  outstandingMinor: number
  status: CollectionStatus
}

function getCurrentBillingMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatTaka(amountMinor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`
}

function formatBillingMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00`)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('en-BD', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function getStatusLabel(status: CollectionStatus): string {
  if (status === 'paid') return 'Paid'
  if (status === 'partial') return 'Partially paid'
  return 'Unpaid'
}

function getStatusClass(status: CollectionStatus): string {
  return `collection-status collection-status-${status}`
}

function getCollectionErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unable to load the current month collection. Please try again.'
}

export function CurrentMonthCollectionPage({
  ownerUid,
  onNavigate,
}: CurrentMonthCollectionPageProps) {
  const [bills, setBills] = useState<RentBillRecord[]>([])
  const [balances, setBalances] = useState<PaymentBillBalanceRecord[]>([])
  const [billingMonth, setBillingMonth] = useState(getCurrentBillingMonth)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchValue, setSearchValue] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [pageError, setPageError] = useState('')

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setPageError('')

    try {
      // This report must reflect the latest payment allocations, not a
      // recently cached balance from before a payment was recorded.
      invalidateOwnerDataCache(ownerUid)

      const [nextBills, nextBalances] = await Promise.all([
        listRentBills(ownerUid),
        listPaymentBillBalances(ownerUid),
      ])

      setBills(nextBills)
      setBalances(nextBalances)
    } catch (error: unknown) {
      setPageError(getCollectionErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const rows = useMemo<CollectionRow[]>(() => {
    const rentBalanceByBillId = new Map(
      balances
        .filter((balance) => balance.billType === 'rent')
        .map((balance) => [balance.billId, balance] as const),
    )

    const collator = new Intl.Collator('en', {
      sensitivity: 'base',
      numeric: true,
    })

    return bills
      .filter((bill) => bill.billingMonth === billingMonth)
      .map((bill) => {
        const balance = rentBalanceByBillId.get(bill.id)
        // No balance document means no payment has been allocated to this
        // issued bill yet. Previous dues and tenant-level opening balances
        // are deliberately not considered here.
        const paidAmountMinor = balance?.paidAmountMinor ?? 0
        const outstandingMinor = balance?.outstandingMinor ?? bill.totalMinor
        const status: CollectionStatus = outstandingMinor <= 0
          ? 'paid'
          : paidAmountMinor > 0
            ? 'partial'
            : 'unpaid'

        return {
          bill,
          paidAmountMinor,
          outstandingMinor,
          status,
        }
      })
      .sort((a, b) =>
        collator.compare(a.bill.propertyCode, b.bill.propertyCode) ||
        collator.compare(a.bill.roomNumber, b.bill.roomNumber) ||
        collator.compare(a.bill.tenantName, b.bill.tenantName),
      )
  }, [bills, balances, billingMonth])

  const summary = useMemo(() => {
    return rows.reduce((result, row) => {
      result.billedMinor += row.bill.totalMinor
      result.collectedMinor += row.paidAmountMinor
      result.outstandingMinor += row.outstandingMinor

      if (row.status === 'paid') result.paidCount += 1
      if (row.status === 'partial') result.partialCount += 1
      if (row.status === 'unpaid') result.unpaidCount += 1

      return result
    }, {
      billedMinor: 0,
      collectedMinor: 0,
      outstandingMinor: 0,
      paidCount: 0,
      partialCount: 0,
      unpaidCount: 0,
    })
  }, [rows])

  const filteredRows = useMemo(() => {
    const search = searchValue.trim().toLocaleLowerCase()

    return rows.filter((row) => {
      if (statusFilter === 'outstanding' && row.outstandingMinor <= 0) return false
      if (statusFilter !== 'all' && statusFilter !== 'outstanding' && row.status !== statusFilter) return false
      if (!search) return true

      return [
        row.bill.tenantName,
        row.bill.tenantCode,
        row.bill.roomNumber,
        row.bill.roomCode,
        row.bill.floorName,
        row.bill.propertyCode,
      ].join(' ').toLocaleLowerCase().includes(search)
    })
  }, [rows, searchValue, statusFilter])

  const isCurrentMonth = billingMonth === getCurrentBillingMonth()

  return (
    <div className="current-collection-page">
      <header className="current-collection-header">
        <div>
          <p className="eyebrow">Finance / Rent</p>
          <h1>Current Month Collection</h1>
          <p className="page-description">
            Track which tenants have paid the rent bill for the selected month.
            Previous dues are kept separate.
          </p>
        </div>

        <div className="current-collection-actions">
          <label className="collection-month-field">
            <span><CalendarDays size={15} aria-hidden="true" /> Billing month</span>
            <input
              type="month"
              value={billingMonth}
              onChange={(event) => setBillingMonth(event.target.value)}
              aria-label="Select billing month"
            />
          </label>
          <button
            className="button button-secondary collection-refresh-button"
            type="button"
            onClick={() => void loadData()}
            disabled={isLoading}
          >
            <RefreshCw size={16} className={isLoading ? 'collection-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </header>

      <div className="collection-scope-note" role="note">
        <CircleAlert size={17} aria-hidden="true" />
        <span>
          <strong>Month-specific report:</strong> payment status is calculated only
          from each rent bill in {formatBillingMonth(billingMonth)}. Previous-month
          dues and opening balances do not change this status.
        </span>
      </div>

      {pageError && (
        <div className="collection-error" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{pageError}</span>
          <button type="button" onClick={() => void loadData()}>Try again</button>
        </div>
      )}

      {isLoading ? (
        <div className="collection-loading" role="status">
          <RefreshCw size={19} className="collection-spin" aria-hidden="true" />
          Loading rent collection…
        </div>
      ) : !pageError && (
        <>
          <section className="collection-financial-summary" aria-label="Selected month financial summary">
            <article className="collection-money-card">
              <span className="collection-money-label"><ReceiptText size={16} aria-hidden="true" /> Total rent billed</span>
              <strong>{formatTaka(summary.billedMinor)}</strong>
              <small>{rows.length} rent bill{rows.length === 1 ? '' : 's'} issued</small>
            </article>
            <article className="collection-money-card collection-money-card-paid">
              <span className="collection-money-label"><CheckCircle2 size={16} aria-hidden="true" /> Paid against these bills</span>
              <strong>{formatTaka(summary.collectedMinor)}</strong>
              <small>Payments allocated to {formatBillingMonth(billingMonth)} rent invoices</small>
            </article>
            <article className="collection-money-card collection-money-card-due">
              <span className="collection-money-label"><Wallet size={16} aria-hidden="true" /> Current month remaining</span>
              <strong>{formatTaka(summary.outstandingMinor)}</strong>
              <small>{summary.unpaidCount + summary.partialCount} bill{summary.unpaidCount + summary.partialCount === 1 ? '' : 's'} not fully paid</small>
            </article>
          </section>

          {rows.length === 0 ? (
            <section className="collection-empty-panel">
              <span className="collection-empty-icon"><ReceiptText size={23} aria-hidden="true" /></span>
              <h2>No rent bills found for {formatBillingMonth(billingMonth)}</h2>
              <p>
                {isCurrentMonth
                  ? 'Generate the monthly rent bills first. Once bills are issued, this page will show which tenants have paid and which still have a balance.'
                  : 'There are no issued rent bills for this month.'}
              </p>
              <button
                className="button button-primary"
                type="button"
                onClick={() => onNavigate('Rent & Bills')}
              >
                Open Rent &amp; Bills
              </button>
            </section>
          ) : (
            <section className="collection-list-panel">
              <div className="collection-list-heading">
                <div>
                  <p className="eyebrow">{isCurrentMonth ? 'Running month' : 'Selected month'}</p>
                  <h2>{formatBillingMonth(billingMonth)} rent status</h2>
                  <p>{summary.paidCount} paid · {summary.partialCount} partially paid · {summary.unpaidCount} unpaid</p>
                </div>
                <span className="collection-bill-count">{rows.length} bills</span>
              </div>

              <div className="collection-toolbar">
                <div className="collection-status-filters" aria-label="Filter rent bills by payment status">
                  <button
                    className={statusFilter === 'all' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('all')}
                    aria-pressed={statusFilter === 'all'}
                  >
                    All <span>{rows.length}</span>
                  </button>
                  <button
                    className={statusFilter === 'outstanding' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('outstanding')}
                    aria-pressed={statusFilter === 'outstanding'}
                  >
                    Outstanding <span>{summary.unpaidCount + summary.partialCount}</span>
                  </button>
                  <button
                    className={statusFilter === 'unpaid' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('unpaid')}
                    aria-pressed={statusFilter === 'unpaid'}
                  >
                    Unpaid <span>{summary.unpaidCount}</span>
                  </button>
                  <button
                    className={statusFilter === 'partial' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('partial')}
                    aria-pressed={statusFilter === 'partial'}
                  >
                    Partial <span>{summary.partialCount}</span>
                  </button>
                  <button
                    className={statusFilter === 'paid' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('paid')}
                    aria-pressed={statusFilter === 'paid'}
                  >
                    Paid <span>{summary.paidCount}</span>
                  </button>
                </div>
                <SearchInput
                  value={searchValue}
                  onChange={setSearchValue}
                  placeholder="Search tenant, room or property…"
                />
              </div>

              {filteredRows.length === 0 ? (
                <div className="collection-filter-empty">
                  No rent bills match this filter. Try another status or search term.
                </div>
              ) : (
                <div className="collection-table-wrap">
                  <table className="collection-table">
                    <thead>
                      <tr>
                        <th>Tenant</th>
                        <th>Room</th>
                        <th className="is-numeric">Rent bill</th>
                        <th className="is-numeric">Paid against bill</th>
                        <th className="is-numeric">Remaining</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map(({ bill, paidAmountMinor, outstandingMinor, status }) => (
                        <tr key={bill.id}>
                          <td>
                            <div className="collection-tenant-cell">
                              <strong>{bill.tenantName}</strong>
                              <span>{bill.tenantCode} · {bill.propertyCode}</span>
                            </div>
                          </td>
                          <td>
                            <div className="collection-room-cell">
                              <strong>{bill.roomNumber}</strong>
                              <span>{bill.floorName}</span>
                            </div>
                          </td>
                          <td className="is-numeric">{formatTaka(bill.totalMinor)}</td>
                          <td className="is-numeric collection-paid-amount">{formatTaka(paidAmountMinor)}</td>
                          <td className="is-numeric collection-remaining-amount">{formatTaka(outstandingMinor)}</td>
                          <td><span className={getStatusClass(status)}>{getStatusLabel(status)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}>Selected month total</td>
                        <td className="is-numeric">{formatTaka(summary.billedMinor)}</td>
                        <td className="is-numeric">{formatTaka(summary.collectedMinor)}</td>
                        <td className="is-numeric">{formatTaka(summary.outstandingMinor)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              <div className="collection-footer-note">
                <Clock3 size={14} aria-hidden="true" />
                A bill is marked paid only when that specific month’s rent invoice has no remaining balance.
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
