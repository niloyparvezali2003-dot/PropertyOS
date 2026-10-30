import { invalidateOwnerDataCache } from '../services/firebase/listCache'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  AlertCircle,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react'

import type {
  FinancialReportsData,
} from '../services/firebase/financialReports'

import {
  loadFinancialReportsData,
} from '../services/firebase/financialReports'

import './financial-reports.css'

type ReportsPageProps = {
  ownerUid: string
}

type MonthlyReport = {
  month: string
  rentBilledMinor: number
  electricityBilledMinor: number
  paymentsReceivedMinor: number
  advancesAppliedMinor: number
  receiptCount: number
}

type SelectedMonthSummary = {
  rentBilledMinor: number
  electricityBilledMinor: number
  paymentsReceivedMinor: number
  advancesAppliedMinor: number
}

function localMonthNow(): string {
  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')

  return `${date.getFullYear()}-${month}`
}

function formatMoney(minor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)}`
}

function formatMonth(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return month
  }

  const date = new Date(`${month}-01T00:00:00`)

  return new Intl.DateTimeFormat('en-BD', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function getTimestampMonth(
  value: { toDate: () => Date } | null,
): string | null {
  if (!value) return null

  const date = value.toDate()
  const month = String(date.getMonth() + 1).padStart(2, '0')

  return `${date.getFullYear()}-${month}`
}

function sumSafe(values: number[]): number {
  return values.reduce((total, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      return total
    }

    const next = total + value

    return Number.isSafeInteger(next) ? next : total
  }, 0)
}

function buildMonthlyReport(
  data: FinancialReportsData,
): MonthlyReport[] {
  const months = new Map<string, MonthlyReport>()

  function ensureMonth(month: string): MonthlyReport {
    let report = months.get(month)

    if (!report) {
      report = {
        month,
        rentBilledMinor: 0,
        electricityBilledMinor: 0,
        paymentsReceivedMinor: 0,
        advancesAppliedMinor: 0,
        receiptCount: 0,
      }

      months.set(month, report)
    }

    return report
  }

  for (const bill of data.rentBills) {
    if (
      bill.status !== 'issued' ||
      !Number.isSafeInteger(bill.totalMinor) ||
      bill.totalMinor < 0
    ) {
      continue
    }

    ensureMonth(bill.billingMonth).rentBilledMinor +=
      bill.totalMinor
  }

  for (const bill of data.electricityBills) {
    if (
      bill.status !== 'issued' ||
      !Number.isSafeInteger(bill.amountMinor) ||
      bill.amountMinor < 0
    ) {
      continue
    }

    ensureMonth(bill.billingMonth).electricityBilledMinor +=
      bill.amountMinor
  }

  for (const payment of data.payments) {
    if (
      payment.status !== 'posted' ||
      !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(payment.paidOn) ||
      !Number.isSafeInteger(payment.amountMinor) ||
      payment.amountMinor < 0
    ) {
      continue
    }

    const month = payment.paidOn.slice(0, 7)
    const report = ensureMonth(month)

    report.paymentsReceivedMinor += payment.amountMinor
    report.receiptCount += 1
  }

  for (const application of data.creditApplications) {
    if (
      application.status !== 'posted' ||
      !Number.isSafeInteger(application.amountMinor) ||
      application.amountMinor < 0
    ) {
      continue
    }

    const month = getTimestampMonth(application.createdAt)

    if (month) {
      ensureMonth(month).advancesAppliedMinor +=
        application.amountMinor
    }
  }

  for (const application of data.openingBalanceCreditApplications) {
    if (
      application.status !== 'posted' ||
      !Number.isSafeInteger(application.amountMinor) ||
      application.amountMinor < 0
    ) {
      continue
    }

    const month = getTimestampMonth(application.createdAt)
    if (month) ensureMonth(month).advancesAppliedMinor += application.amountMinor
  }

  return Array.from(months.values()).sort(
    (a, b) => b.month.localeCompare(a.month),
  )
}

function summarizeMonth(
  data: FinancialReportsData,
  month: string,
): SelectedMonthSummary {
  const monthlyReport = buildMonthlyReport(data).find(
    (report) => report.month === month,
  )

  return {
    rentBilledMinor: monthlyReport?.rentBilledMinor ?? 0,
    electricityBilledMinor:
      monthlyReport?.electricityBilledMinor ?? 0,
    paymentsReceivedMinor:
      monthlyReport?.paymentsReceivedMinor ?? 0,
    advancesAppliedMinor:
      monthlyReport?.advancesAppliedMinor ?? 0,
  }
}

function calculateCurrentOutstanding(
  data: FinancialReportsData,
): number {
  const balancesByKey = new Map<
  string,
  FinancialReportsData['billBalances'][number]
>(
    data.billBalances.map((balance) => [
      `${balance.billType}__${balance.billId}`,
      balance,
    ]),
  )

  const rentDue = data.rentBills.reduce((total, bill) => {
    if (bill.status !== 'issued') return total

    const balance = balancesByKey.get(`rent__${bill.id}`)

    // If no payment balance exists, the whole issued bill is outstanding.
    const due = balance
      ? balance.outstandingMinor
      : bill.totalMinor

    return total + (
      Number.isSafeInteger(due) && due > 0
        ? due
        : 0
    )
  }, 0)

  const electricityDue = data.electricityBills.reduce(
    (total, bill) => {
      if (bill.status !== 'issued') return total

      const balance = balancesByKey.get(
        `electricity__${bill.id}`,
      )

      const due = balance
        ? balance.outstandingMinor
        : bill.amountMinor

      return total + (
        Number.isSafeInteger(due) && due > 0
          ? due
          : 0
      )
    },
    0,
  )

  const openingDue = data.openingBalances.reduce((total, balance) => {
    const due = balance.outstandingMinor
    return total + (Number.isSafeInteger(due) && due > 0 ? due : 0)
  }, 0)

  return rentDue + electricityDue + openingDue
}

function escapeCsv(value: string | number): string {
  const text = String(value)

  // Prevent spreadsheet formula execution from text fields.
  const safeText = /^[=+\-@\t\r]/.test(text)
    ? `'${text}`
    : text

  return `"${safeText.replaceAll('"', '""')}"`
}

function exportMonthlyCsv(reports: MonthlyReport[]) {
  const headers = [
    'Billing / Receipt Month',
    'Rent Billed (BDT)',
    'Electricity Billed (BDT)',
    'Payments Received (BDT)',
    'Advances Applied (BDT)',
    'Receipt Count',
  ]

  const rows = reports.map((report) => [
    report.month,
    (report.rentBilledMinor / 100).toFixed(2),
    (report.electricityBilledMinor / 100).toFixed(2),
    (report.paymentsReceivedMinor / 100).toFixed(2),
    (report.advancesAppliedMinor / 100).toFixed(2),
    report.receiptCount,
  ])

  const csv = [
    headers.map(escapeCsv).join(','),
    ...rows.map((row) => row.map(escapeCsv).join(',')),
  ].join('\r\n')

  const blob = new Blob(
    ['\uFEFF', csv],
    { type: 'text/csv;charset=utf-8;' },
  )

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = 'PropertyOS-Monthly-Financial-Report.csv'

  document.body.appendChild(link)
  link.click()
  link.remove()

  URL.revokeObjectURL(url)
}

export function FinancialReportsPage({
  ownerUid,
}: ReportsPageProps) {
  const [data, setData] =
    useState<FinancialReportsData | null>(null)

  const [selectedMonth, setSelectedMonth] =
    useState(localMonthNow)

  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState('')

  const loadData = useCallback(async (
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
      const result = await loadFinancialReportsData(ownerUid)
      setData(result)
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load financial reports.',
      )
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const monthlyReports = useMemo(
    () => data ? buildMonthlyReport(data) : [],
    [data],
  )

  const monthOptions = useMemo(() => {
    const months = new Set([
      localMonthNow(),
      ...monthlyReports.map((report) => report.month),
    ])

    return Array.from(months).sort((a, b) =>
      b.localeCompare(a),
    )
  }, [monthlyReports])

  const summary = useMemo(
    () => data
      ? summarizeMonth(data, selectedMonth)
      : {
          rentBilledMinor: 0,
          electricityBilledMinor: 0,
          paymentsReceivedMinor: 0,
          advancesAppliedMinor: 0,
        },
    [data, selectedMonth],
  )

  const currentOutstanding = useMemo(
    () => data ? calculateCurrentOutstanding(data) : 0,
    [data],
  )

  const totalTenantCredit = useMemo(
    () => data
      ? sumSafe(
          data.tenantCredits.map((credit) => credit.creditMinor),
        )
      : 0,
    [data],
  )

  const totalBilledMinor =
    summary.rentBilledMinor +
    summary.electricityBilledMinor

  const filteredMonthReport = monthlyReports.find(
    (report) => report.month === selectedMonth,
  )

  return (
    <section className="financial-reports-page">
      <header className="financial-reports-heading">
        <div>
          <p className="financial-reports-eyebrow">
            FINANCE · ANALYTICS
          </p>

          <h1>Financial Overview</h1>

          <p>
            Review billed amounts, collections, outstanding dues,
            and tenant advances from saved records.
          </p>
        </div>

        <div className="financial-report-actions">
          <button
            type="button"
            className="report-button report-button-secondary"
            onClick={() => void loadData(true)}
            disabled={isLoading || isRefreshing}
          >
            {isRefreshing
              ? <LoaderCircle className="report-spin" size={17} />
              : <RefreshCw size={17} />
            }

            {isRefreshing ? 'Refreshing' : 'Refresh'}
          </button>

          <button
            type="button"
            className="report-button report-button-primary"
            onClick={() => exportMonthlyCsv(monthlyReports)}
            disabled={isLoading || monthlyReports.length === 0}
          >
            <Download size={17} />
            Export CSV
          </button>
        </div>
      </header>

      <div className="financial-report-period">
        <label htmlFor="report-month">
          Reporting month
        </label>

        <select
          id="report-month"
          value={selectedMonth}
          onChange={(event) => setSelectedMonth(event.target.value)}
          disabled={isLoading}
        >
          {monthOptions.map((month) => (
            <option key={month} value={month}>
              {formatMonth(month)}
            </option>
          ))}
        </select>

        <span>
          Monthly billed and receipt figures follow their respective
          billing month and payment date.
        </span>
      </div>

      {error && (
        <div className="financial-report-error" role="alert">
          <AlertCircle size={19} />

          <div>
            <strong>Could not load financial data</strong>
            <p>{error}</p>
          </div>

          <button
            type="button"
            onClick={() => void loadData(true)}
          >
            Retry
          </button>
        </div>
      )}

      <div className="financial-report-stats">
        <article className="financial-report-card">
          <span className="financial-report-card-label">
            <FileText size={17} />
            Rent billed
          </span>

          <strong>{formatMoney(summary.rentBilledMinor)}</strong>

          <small>{formatMonth(selectedMonth)}</small>
        </article>

        <article className="financial-report-card">
          <span className="financial-report-card-label">
            <Zap size={17} />
            Electricity billed
          </span>

          <strong>
            {formatMoney(summary.electricityBilledMinor)}
          </strong>

          <small>{formatMonth(selectedMonth)}</small>
        </article>

        <article className="financial-report-card">
          <span className="financial-report-card-label">
            <TrendingUp size={17} />
            Payments received
          </span>

          <strong>
            {formatMoney(summary.paymentsReceivedMinor)}
          </strong>

          <small>
            Posted receipts dated in {formatMonth(selectedMonth)}
          </small>
        </article>

        <article className="financial-report-card is-warning">
          <span className="financial-report-card-label">
            <TrendingDown size={17} />
            Current outstanding
          </span>

          <strong>{formatMoney(currentOutstanding)}</strong>

          <small>Unpaid issued bills and tenant opening balances</small>
        </article>

        <article className="financial-report-card">
          <span className="financial-report-card-label">
            <Wallet size={17} />
            Tenant advances
          </span>

          <strong>{formatMoney(totalTenantCredit)}</strong>

          <small>Current saved tenant credit balances</small>
        </article>

        <article className="financial-report-card">
          <span className="financial-report-card-label">
            <Wallet size={17} />
            Advances applied
          </span>

          <strong>
            {formatMoney(summary.advancesAppliedMinor)}
          </strong>

          <small>
            Applied credit transactions dated in {formatMonth(selectedMonth)}
          </small>
        </article>
      </div>

      <section className="financial-report-table-panel">
        <div className="financial-report-table-header">
          <div>
            <h2>Monthly financial report</h2>

            <p>
              {monthlyReports.length} month
              {monthlyReports.length === 1 ? '' : 's'} with saved
              billing or payment activity.
            </p>
          </div>

          <span className="financial-report-total">
            {formatMoney(totalBilledMinor)} billed this month
          </span>
        </div>

        {isLoading ? (
          <div className="financial-report-state">
            <LoaderCircle className="report-spin" size={24} />
            <span>Loading saved financial records…</span>
          </div>
        ) : monthlyReports.length === 0 ? (
          <div className="financial-report-state">
            <FileText size={25} />
            <strong>No financial reports yet</strong>
            <span>
              Issued rent bills, electricity bills, or posted payments
              will appear here when available.
            </span>
          </div>
        ) : (
          <div className="financial-report-table-wrap">
            <table className="financial-report-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="report-number">Rent billed</th>
                  <th className="report-number">Electricity billed</th>
                  <th className="report-number">Payments received</th>
                  <th className="report-number">Advances applied</th>
                  <th className="report-number">Receipts</th>
                </tr>
              </thead>

              <tbody>
                {monthlyReports.map((report) => (
                  <tr
                    key={report.month}
                    className={
                      report.month === selectedMonth
                        ? 'is-selected-month'
                        : ''
                    }
                  >
                    <td>
                      <button
                        type="button"
                        className="report-month-link"
                        onClick={() => setSelectedMonth(report.month)}
                      >
                        {formatMonth(report.month)}
                      </button>
                    </td>

                    <td className="report-number">
                      {formatMoney(report.rentBilledMinor)}
                    </td>

                    <td className="report-number">
                      {formatMoney(report.electricityBilledMinor)}
                    </td>

                    <td className="report-number report-received">
                      {formatMoney(report.paymentsReceivedMinor)}
                    </td>

                    <td className="report-number">
                      {formatMoney(report.advancesAppliedMinor)}
                    </td>

                    <td className="report-number">
                      {report.receiptCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filteredMonthReport && (
          <div className="financial-report-table-note">
            Selected month: {formatMonth(selectedMonth)}.
            Payments are grouped by the saved payment date; bill totals
            are grouped by billing month. Applying an advance is not
            counted as new cash received.
          </div>
        )}
      </section>

      <p className="financial-report-disclaimer">
        Reports are read-only. Figures are calculated from saved issued
        bills, posted receipts, bill balances, and tenant credit records.
        They do not create transactions or modify historical financial
        records. No PDF layout is changed by this feature.
      </p>
    </section>
  )
}