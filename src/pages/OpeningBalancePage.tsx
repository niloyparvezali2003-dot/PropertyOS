import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDollarSign,
  FilePlus2,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react'

import { recordAuditEvent } from '../services/firebase/audit'
import { listTenants, type TenantRecord } from '../services/firebase/tenants'
import {
  adjustOpeningBalance,
  createOpeningBalance,
  listOpeningBalances,
  listOpeningBalanceAdjustments,
  type OpeningBalanceAdjustmentRecord,
  type OpeningBalanceRecord,
} from '../services/firebase/openingBalances'
import './opening-balances.css'

type OpeningBalancePageProps = { ownerUid: string }
type CreateForm = { tenantId: string; effectiveDate: string; amount: string; note: string }
type AdjustmentForm = { direction: 'increase' | 'decrease'; effectiveDate: string; amount: string; note: string }

function todayIso(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseTaka(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [wholeText, decimalText = ''] = normalized.split('.')
  const result = Number(wholeText) * 100 + Number((decimalText + '00').slice(0, 2))
  return Number.isSafeInteger(result) && result > 0 ? result : null
}

function formatMoney(value: number): string {
  return `৳${new Intl.NumberFormat('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100)}`
}

function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('en-BD', { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed)
}

const emptyCreateForm = (): CreateForm => ({ tenantId: '', effectiveDate: todayIso(), amount: '', note: '' })
const emptyAdjustmentForm = (): AdjustmentForm => ({ direction: 'increase', effectiveDate: todayIso(), amount: '', note: '' })

export function OpeningBalancePage({ ownerUid }: OpeningBalancePageProps) {
  const [tenants, setTenants] = useState<TenantRecord[]>([])
  const [balances, setBalances] = useState<OpeningBalanceRecord[]>([])
  const [adjustments, setAdjustments] = useState<OpeningBalanceAdjustmentRecord[]>([])
  const [form, setForm] = useState<CreateForm>(emptyCreateForm)
  const [adjustingTenantId, setAdjustingTenantId] = useState('')
  const [adjustmentForm, setAdjustmentForm] = useState<AdjustmentForm>(emptyAdjustmentForm)
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const [nextTenants, nextBalances, nextAdjustments] = await Promise.all([
        listTenants(ownerUid),
        listOpeningBalances(ownerUid),
        listOpeningBalanceAdjustments(ownerUid),
      ])
      setTenants(nextTenants)
      setBalances(nextBalances)
      setAdjustments(nextAdjustments)
      // Never auto-select a tenant. Preserve only an explicit user selection
      // while it remains eligible; otherwise return to the neutral placeholder.
      setForm((current) => ({
        ...current,
        tenantId: nextTenants.some((tenant) =>
          tenant.id === current.tenantId &&
          !nextBalances.some((balance) => balance.tenantId === tenant.id),
        ) ? current.tenantId : '',
      }))
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Opening balance records could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => { void loadData() }, [loadData])

  const balanceByTenant = useMemo(() => new Map(balances.map((balance) => [balance.tenantId, balance])), [balances])
  const tenantById = useMemo(() => new Map(tenants.map((tenant) => [tenant.id, tenant])), [tenants])
  const availableTenants = useMemo(() => tenants.filter((tenant) => !balanceByTenant.has(tenant.id)), [tenants, balanceByTenant])
  const filteredBalances = useMemo(() => {
    const term = search.trim().toLowerCase()
    const displayName = (balance: OpeningBalanceRecord) => tenantById.get(balance.tenantId)?.fullName ?? balance.tenantName
    return balances
      .filter((balance) => !term || `${displayName(balance)} ${balance.tenantName} ${balance.tenantCode} ${balance.note}`.toLowerCase().includes(term))
      .sort((left, right) => displayName(left).localeCompare(displayName(right)))
  }, [balances, search, tenantById])
  const totalOutstanding = balances.reduce((sum, balance) => sum + balance.outstandingMinor, 0)
  const totalPaid = balances.reduce((sum, balance) => sum + balance.paidAmountMinor, 0)
  const tenantsWithDue = balances.filter((balance) => balance.outstandingMinor > 0).length
  const selectedTenant = tenants.find((tenant) => tenant.id === form.tenantId) ?? null

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSuccess('')
    if (!selectedTenant) {
      setError('Select a tenant who does not already have an opening balance.')
      return
    }
    const amountMinor = parseTaka(form.amount)
    if (amountMinor === null) {
      setError('Enter a positive opening due amount with up to two decimal places.')
      return
    }
    setIsSaving(true)
    try {
      await createOpeningBalance(ownerUid, {
        tenantId: selectedTenant.id,
        tenantCode: selectedTenant.tenantCode,
        tenantName: selectedTenant.fullName,
        effectiveDate: form.effectiveDate,
        amountMinor,
        note: form.note.trim(),
      })
      await recordAuditEvent(ownerUid, {
        action: 'opening_balance_added',
        entityType: 'opening_balance',
        entityId: selectedTenant.id,
        entityLabel: `${selectedTenant.tenantCode} · ${selectedTenant.fullName}`,
        summary: `Added an opening due of ${formatMoney(amountMinor)} for ${selectedTenant.fullName}.`,
        dedupeKey: `opening_balance_${selectedTenant.id}`,
      })
      setForm(emptyCreateForm())
      setSuccess(`Opening balance saved for ${selectedTenant.fullName}.`)
      await loadData()
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The opening balance could not be saved.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleAdjustment(event: FormEvent<HTMLFormElement>, balance: OpeningBalanceRecord) {
    event.preventDefault()
    setError('')
    setSuccess('')
    const amountMinor = parseTaka(adjustmentForm.amount)
    if (amountMinor === null) {
      setError('Enter a positive adjustment amount with up to two decimal places.')
      return
    }
    if (!adjustmentForm.note.trim()) {
      setError('Add a short reason for this adjustment so the correction remains auditable.')
      return
    }
    setIsSaving(true)
    try {
      const adjustmentNumber = await adjustOpeningBalance(ownerUid, balance.tenantId, {
        direction: adjustmentForm.direction,
        amountMinor,
        effectiveDate: adjustmentForm.effectiveDate,
        note: adjustmentForm.note.trim(),
      })
      await recordAuditEvent(ownerUid, {
        action: 'opening_balance_adjusted',
        entityType: 'opening_balance',
        entityId: balance.tenantId,
        entityLabel: `${balance.tenantCode} · ${tenantById.get(balance.tenantId)?.fullName ?? balance.tenantName}`,
        summary: `${adjustmentForm.direction === 'increase' ? 'Increased' : 'Decreased'} opening due by ${formatMoney(amountMinor)} (${adjustmentNumber}).`,
      })
      setAdjustingTenantId('')
      setAdjustmentForm(emptyAdjustmentForm())
      setSuccess(`Adjustment saved: ${adjustmentNumber}.`)
      await loadData()
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The adjustment could not be saved.')
    } finally {
      setIsSaving(false)
    }
  }

  const adjustmentsFor = (tenantId: string) => adjustments
    .filter((adjustment) => adjustment.tenantId === tenantId)
    .sort((left, right) => (right.createdAt?.toMillis() ?? 0) - (left.createdAt?.toMillis() ?? 0))

  return (
    <section className="opening-page">
      <header className="opening-page-heading">
        <div>
          <p className="eyebrow">Management</p>
          <h1>Opening Balance</h1>
          <p className="page-description">Record the total amount existing tenants already owed before PropertyOS started tracking their accounts.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void loadData()} disabled={isLoading || isSaving}>
          {isLoading ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />} Refresh
        </button>
      </header>

      {error && <div className="opening-alert is-error" role="alert"><AlertCircle size={17} />{error}</div>}
      {success && <div className="opening-alert is-success" role="status"><CheckCircle2 size={17} />{success}</div>}

      <section className="opening-summary-grid" aria-label="Opening balance summary">
        <article className="opening-summary-card"><span><CircleDollarSign size={16} /> Outstanding opening due</span><strong>{formatMoney(totalOutstanding)}</strong><small>Current unpaid opening balance</small></article>
        <article className="opening-summary-card"><span><Wallet size={16} /> Settled against opening due</span><strong>{formatMoney(totalPaid)}</strong><small>Payments and advance allocations</small></article>
        <article className="opening-summary-card"><span><FilePlus2 size={16} /> Tenants with opening due</span><strong>{tenantsWithDue.toLocaleString('en-BD')}</strong><small>{balances.length.toLocaleString('en-BD')} opening balance records</small></article>
      </section>

      <div className="opening-content-grid">
        <section className="opening-panel opening-create-panel">
          <div className="opening-panel-heading"><div><span className="opening-kicker">One-time setup</span><h2>Add opening due</h2><p>Enter one combined amount for each tenant.</p></div><span className="opening-heading-icon"><Plus size={20} /></span></div>
          {availableTenants.length === 0 ? (
            <div className="opening-empty-inline"><CheckCircle2 size={19} /><span>Every tenant already has an opening balance record, or there are no tenants to add.</span></div>
          ) : (
            <form className="opening-form" onSubmit={(event) => void handleCreate(event)}>
              <label className="opening-field"><span>Tenant</span><select value={form.tenantId} onChange={(event) => setForm((current) => ({ ...current, tenantId: event.target.value }))} required><option value="">Select tenant</option>{availableTenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.fullName} · {tenant.tenantCode}</option>)}</select></label>
              <div className="opening-form-row">
                <label className="opening-field"><span>Previous outstanding amount</span><div className="opening-money-input"><span>৳</span><input value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} placeholder="15000.00" inputMode="decimal" required /></div><small>One total amount. No rent/electricity split.</small></label>
                <label className="opening-field"><span>Effective date</span><input type="date" value={form.effectiveDate} onChange={(event) => setForm((current) => ({ ...current, effectiveDate: event.target.value }))} required /></label>
              </div>
              <label className="opening-field"><span>Note / reference <em>Optional</em></span><textarea value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder="Previous outstanding before PropertyOS" rows={3} maxLength={1000} /></label>
              <div className="opening-form-total"><span>Opening due to be added</span><strong>{parseTaka(form.amount) === null ? '৳0.00' : formatMoney(parseTaka(form.amount) as number)}</strong></div>
              <button className="opening-primary-button" type="submit" disabled={isSaving || isLoading || availableTenants.length === 0 || !form.tenantId || parseTaka(form.amount) === null}>{isSaving ? <LoaderCircle size={17} className="animate-spin" /> : <Plus size={17} />} Save opening balance</button>
              <p className="opening-security-note"><ShieldCheck size={14} /> A tenant can have one original opening balance. Corrections are saved separately as audited adjustments.</p>
            </form>
          )}
        </section>

        <section className="opening-panel opening-list-panel">
          <div className="opening-list-heading"><div><span className="opening-kicker">Tenant records</span><h2>Opening balances</h2><p>Current remaining amount for each tenant.</p></div><span className="opening-count-pill">{balances.length}</span></div>
          <input className="opening-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tenant name or code…" aria-label="Search opening balances" />
          {isLoading ? <div className="opening-empty-state"><LoaderCircle size={18} className="animate-spin" /> Loading opening balances…</div> : filteredBalances.length === 0 ? <div className="opening-empty-state"><FilePlus2 size={24} /><strong>No opening balance records</strong><span>Add a tenant’s previous due using the form.</span></div> : (
            <div className="opening-record-list">
              {filteredBalances.map((balance) => {
                const tenantAdjustments = adjustmentsFor(balance.tenantId)
                const adjusting = adjustingTenantId === balance.tenantId
                return (
                  <article className="opening-record-card" key={balance.id}>
                    <div className="opening-record-top"><div><strong>{tenantById.get(balance.tenantId)?.fullName ?? balance.tenantName}</strong><span>{balance.tenantCode} · Since {formatDate(balance.effectiveDate)}</span></div><span className={`opening-status ${balance.outstandingMinor > 0 ? 'is-due' : 'is-settled'}`}>{balance.outstandingMinor > 0 ? 'Due' : 'Settled'}</span></div>
                    <div className="opening-record-amounts">
                      <div><span>Original due</span><strong>{formatMoney(balance.originalAmountMinor)}</strong></div>
                      <div><span>Adjustments</span><strong className={balance.adjustedAmountMinor < 0 ? 'is-negative' : ''}>{balance.adjustedAmountMinor > 0 ? '+' : ''}{formatMoney(Math.abs(balance.adjustedAmountMinor))}{balance.adjustedAmountMinor < 0 ? ' reduced' : ''}</strong></div>
                      <div><span>Paid / applied</span><strong>{formatMoney(balance.paidAmountMinor)}</strong></div>
                    </div>
                    <div className="opening-record-total"><span>Remaining opening due</span><strong>{formatMoney(balance.outstandingMinor)}</strong></div>
                    {balance.note && <p className="opening-record-note">{balance.note}</p>}
                    <div className="opening-record-actions"><button type="button" className="opening-adjust-button" onClick={() => { setAdjustingTenantId(adjusting ? '' : balance.tenantId); setAdjustmentForm(emptyAdjustmentForm()) }} disabled={isSaving}>Adjust opening due</button><small>{tenantAdjustments.length} adjustment{tenantAdjustments.length === 1 ? '' : 's'}</small></div>
                    {adjusting && (
                      <form className="opening-adjustment-form" onSubmit={(event) => void handleAdjustment(event, balance)}>
                        <label className="opening-field"><span>Adjustment type</span><select value={adjustmentForm.direction} onChange={(event) => setAdjustmentForm((current) => ({ ...current, direction: event.target.value as 'increase' | 'decrease' }))}><option value="increase">Increase opening due</option><option value="decrease">Decrease opening due</option></select></label>
                        <div className="opening-form-row"><label className="opening-field"><span>Amount</span><div className="opening-money-input"><span>৳</span><input value={adjustmentForm.amount} onChange={(event) => setAdjustmentForm((current) => ({ ...current, amount: event.target.value }))} inputMode="decimal" placeholder="1000.00" required /></div></label><label className="opening-field"><span>Effective date</span><input type="date" value={adjustmentForm.effectiveDate} onChange={(event) => setAdjustmentForm((current) => ({ ...current, effectiveDate: event.target.value }))} required /></label></div>
                        <label className="opening-field"><span>Reason <em>Required</em></span><textarea value={adjustmentForm.note} onChange={(event) => setAdjustmentForm((current) => ({ ...current, note: event.target.value }))} placeholder="Explain why this correction is required" rows={2} maxLength={1000} required /></label>
                        <div className="opening-adjustment-actions"><button type="button" className="opening-adjust-cancel" onClick={() => setAdjustingTenantId('')} disabled={isSaving}>Cancel</button><button type="submit" className="opening-primary-button" disabled={isSaving || parseTaka(adjustmentForm.amount) === null || !adjustmentForm.note.trim()}>{isSaving ? <LoaderCircle size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Save adjustment</button></div>
                      </form>
                    )}
                    {tenantAdjustments.length > 0 && <details className="opening-adjustment-history"><summary>View adjustment history</summary><div>{tenantAdjustments.map((adjustment) => <p key={adjustment.id}><span>{formatDate(adjustment.effectiveDate)} · {adjustment.note}</span><strong className={adjustment.direction === 'increase' ? 'is-increase' : 'is-decrease'}>{adjustment.direction === 'increase' ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{adjustment.direction === 'increase' ? '+' : '−'}{formatMoney(adjustment.amountMinor)}</strong></p>)}</div></details>}
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>
      <p className="opening-page-footnote">Opening balances are tenant-level historical amounts. They do not create backdated rent bills, electricity bills, meter readings, or room assignments. Payments and applicable advance credit are tracked against this balance separately from new bills.</p>
    </section>
  )
}
