import { useEffect, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ContactRound,
  CircleDollarSign,
  FileText,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldCheck,
  Zap,
} from 'lucide-react'

import {
  DEFAULT_WORKSPACE_SETTINGS,
  loadWorkspaceSettings,
  saveWorkspaceSettings,
  type WorkspaceSettings,
} from '../services/firebase/workspaceSettings'
import {
  createWorkspaceDefaultElectricityRate,
  listElectricityRates,
  type ElectricityRateRecord,
} from '../services/firebase/electricity'
import { recordAuditEvent } from '../services/firebase/audit'
import './settings.css'

type SettingsPageProps = { ownerUid: string }

type FieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
  type?: 'text' | 'email' | 'tel'
  help?: string
}

type DefaultRateForm = { pricePerUnit: string; effectiveFrom: string }

function todayIso(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function nextAvailableDefaultRateDate(rates: ElectricityRateRecord[]): string {
  const usedDates = new Set(rates.filter((rate) => rate.roomId === null).map((rate) => rate.effectiveFrom))
  const candidate = new Date(`${todayIso()}T00:00:00`)
  while (usedDates.has(`${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`)) {
    candidate.setDate(candidate.getDate() + 1)
  }
  return `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`
}

function takaToPoisha(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [wholePart, decimalPart = ''] = normalized.split('.')
  const result = Number(wholePart) * 100 + Number((decimalPart + '00').slice(0, 2))
  return Number.isSafeInteger(result) && result > 0 && result <= 10_000_000 ? result : null
}

function formatRateInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2)
}

function formatTaka(amountMinor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100)}`
}

function TextField({ label, value, onChange, placeholder, maxLength, type = 'text', help }: FieldProps) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
      />
      {help && <small>{help}</small>}
    </label>
  )
}

export function SettingsPage({ ownerUid }: SettingsPageProps) {
  const [values, setValues] = useState<WorkspaceSettings>({ ...DEFAULT_WORKSPACE_SETTINGS })
  const [defaultRateForm, setDefaultRateForm] = useState<DefaultRateForm>({ pricePerUnit: '', effectiveFrom: todayIso() })
  const [currentDefaultRate, setCurrentDefaultRate] = useState<ElectricityRateRecord | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingDefaultRate, setIsSavingDefaultRate] = useState(false)
  const [isSaved, setIsSaved] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [defaultRateError, setDefaultRateError] = useState('')
  const [defaultRateSuccess, setDefaultRateSuccess] = useState('')

  useEffect(() => {
    let mounted = true
    setIsLoading(true)
    setError('')
    void Promise.all([loadWorkspaceSettings(ownerUid), listElectricityRates(ownerUid)])
      .then(([result, rates]) => {
        if (!mounted) return
        setValues(result.settings)
        setIsSaved(result.isSaved)
        const today = todayIso()
        const activeDefault = rates
          .filter((rate) => rate.roomId === null && rate.effectiveFrom <= today)
          .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0] ?? null
        setCurrentDefaultRate(activeDefault)
        setDefaultRateForm({
          pricePerUnit: activeDefault ? formatRateInput(activeDefault.pricePerUnitMinor) : '',
          effectiveFrom: nextAvailableDefaultRateDate(rates),
        })
      })
      .catch((loadError: unknown) => {
        if (!mounted) return
        setError(loadError instanceof Error ? loadError.message : 'Settings could not be loaded.')
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })
    return () => { mounted = false }
  }, [ownerUid])

  function update<K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) {
    setValues((current) => ({ ...current, [key]: value }))
    setSuccess('')
    setError('')
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSaving || isLoading) return
    setIsSaving(true)
    setError('')
    setSuccess('')
    try {
      const saved = await saveWorkspaceSettings(ownerUid, values)
      setValues(saved)
      setIsSaved(true)
      setSuccess('Your workspace settings have been saved to Firebase.')
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Settings could not be saved.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveDefaultRate() {
    if (isSavingDefaultRate || isLoading) return
    const pricePerUnitMinor = takaToPoisha(defaultRateForm.pricePerUnit)
    if (pricePerUnitMinor === null) {
      setDefaultRateError('Enter a valid rate greater than ৳0.00, with up to two decimal places.')
      setDefaultRateSuccess('')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(defaultRateForm.effectiveFrom)) {
      setDefaultRateError('Select a valid effective date.')
      setDefaultRateSuccess('')
      return
    }

    setIsSavingDefaultRate(true)
    setDefaultRateError('')
    setDefaultRateSuccess('')
    try {
      const rateId = await createWorkspaceDefaultElectricityRate(ownerUid, {
        effectiveFrom: defaultRateForm.effectiveFrom,
        pricePerUnitMinor,
      })
      await recordAuditEvent(ownerUid, {
        action: 'rate_added',
        entityType: 'electricity_rate',
        entityId: rateId,
        entityLabel: 'Workspace default electricity rate',
        summary: `Set workspace default electricity rate to ${formatTaka(pricePerUnitMinor)} per unit, effective ${defaultRateForm.effectiveFrom}. Room-specific rates remain unchanged.`,
      })

      const savedRate: ElectricityRateRecord = {
        id: rateId,
        roomId: null,
        roomCode: null,
        effectiveFrom: defaultRateForm.effectiveFrom,
        pricePerUnitMinor,
        notes: '',
        createdAt: null,
        updatedAt: null,
        createdBy: ownerUid,
        updatedBy: ownerUid,
      }
      if (savedRate.effectiveFrom <= todayIso()) setCurrentDefaultRate(savedRate)
      setDefaultRateSuccess(`Workspace default rate ${formatTaka(pricePerUnitMinor)} / unit saved from ${savedRate.effectiveFrom}. Rooms with their own rate-history entry will continue using that room-specific rate.`)
      const updatedRates = await listElectricityRates(ownerUid)
      setDefaultRateForm((current) => ({ ...current, effectiveFrom: nextAvailableDefaultRateDate(updatedRates) }))
    } catch (saveError: unknown) {
      setDefaultRateError(saveError instanceof Error ? saveError.message : 'The workspace default electricity rate could not be saved.')
    } finally {
      setIsSavingDefaultRate(false)
    }
  }

  function resetForm() {
    setValues({ ...DEFAULT_WORKSPACE_SETTINGS })
    setSuccess('Default values loaded into the form. Select Save changes to persist them.')
    setError('')
  }

  return (
    <section className="settings-page">
      <header className="settings-page-heading">
        <div>
          <p className="settings-eyebrow">Workspace configuration</p>
          <h1>Settings</h1>
          <p>Manage your house profile, contact details, and default electricity rate for your PropertyOS workspace.</p>
        </div>
        <span className={`settings-save-status ${isSaved ? 'is-saved' : 'is-default'}`}>
          <span className="settings-status-dot" />
          {isLoading ? 'Loading settings' : isSaved ? 'Saved to Firebase' : 'Using default values'}
        </span>
      </header>

      {error && (
        <div className="settings-alert is-error" role="alert">
          <AlertCircle size={19} aria-hidden="true" />
          <p>{error}</p>
        </div>
      )}
      {success && (
        <div className="settings-alert is-success" role="status">
          <CheckCircle2 size={19} aria-hidden="true" />
          <p>{success}</p>
        </div>
      )}

      <form onSubmit={(event) => void handleSave(event)} className="settings-form">
        <div className="settings-layout-grid">
          <section className="settings-card settings-profile-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon"><Building2 size={20} /></span>
              <div>
                <h2>House profile</h2>
                <p>The identity of your property workspace.</p>
              </div>
            </div>

            <div className="settings-form-fields">
              <TextField
                label="House / workspace name"
                value={values.houseName}
                onChange={(value) => update('houseName', value)}
                placeholder="T&N House's"
                maxLength={100}
                help="This is the name you use to identify the workspace."
              />
              <TextField
                label="Property address"
                value={values.address}
                onChange={(value) => update('address', value)}
                placeholder="House, road, area, city"
                maxLength={500}
              />
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon"><ContactRound size={20} /></span>
              <div>
                <h2>Business and contact details</h2>
                <p>Keep your contract and payment contact information together.</p>
              </div>
            </div>

            <div className="settings-form-fields">
              <TextField
                label="Contract number"
                value={values.contractNumber}
                onChange={(value) => update('contractNumber', value)}
                placeholder="01560060333"
                maxLength={60}
              />
              <TextField
                label="Payment contact (bKash / Nagad / Rocket / Upay)"
                value={values.paymentContact}
                onChange={(value) => update('paymentContact', value)}
                placeholder="01753546666"
                maxLength={80}
                type="tel"
              />
              <TextField
                label="Support email (optional)"
                value={values.supportEmail}
                onChange={(value) => update('supportEmail', value)}
                placeholder="support@example.com"
                maxLength={200}
                type="email"
              />
            </div>
          </section>

          <section className="settings-card settings-electricity-rate-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon"><Zap size={20} /></span>
              <div>
                <h2>Default electricity rate</h2>
                <p>One workspace-wide rate for every room without its own custom rate.</p>
              </div>
            </div>
            <div className="settings-current-rate">
              <span>Current workspace default</span>
              <strong>{currentDefaultRate ? `${formatTaka(currentDefaultRate.pricePerUnitMinor)} / unit` : 'Not configured'}</strong>
              {currentDefaultRate && <small>Effective from {currentDefaultRate.effectiveFrom}</small>}
            </div>
            <div className="settings-form-fields">
              <label className="settings-field">
                <span className="settings-field-label">Default rate per unit (৳)</span>
                <input
                  type="number"
                  min="0.01"
                  max="100000"
                  step="0.01"
                  placeholder="e.g. 12.50"
                  value={defaultRateForm.pricePerUnit}
                  onChange={(event) => {
                    setDefaultRateForm((current) => ({ ...current, pricePerUnit: event.target.value }))
                    setDefaultRateError('')
                    setDefaultRateSuccess('')
                  }}
                />
                <small>Applied automatically to all rooms that do not have a room-specific rate-history entry.</small>
              </label>
              <label className="settings-field">
                <span className="settings-field-label">Effective from</span>
                <input
                  type="date"
                  value={defaultRateForm.effectiveFrom}
                  onChange={(event) => {
                    setDefaultRateForm((current) => ({ ...current, effectiveFrom: event.target.value }))
                    setDefaultRateError('')
                    setDefaultRateSuccess('')
                  }}
                />
                <small>Rate changes are added to history; existing bills and earlier rate records are never rewritten.</small>
              </label>
            </div>
            {defaultRateError && <p className="settings-inline-error" role="alert">{defaultRateError}</p>}
            {defaultRateSuccess && <p className="settings-inline-success" role="status">{defaultRateSuccess}</p>}
            <button
              className="settings-save-button settings-rate-save-button"
              type="button"
              onClick={() => void handleSaveDefaultRate()}
              disabled={isLoading || isSavingDefaultRate}
            >
              {isSavingDefaultRate ? <LoaderCircle size={17} className="settings-spin" aria-hidden="true" /> : <CircleDollarSign size={17} aria-hidden="true" />}
              {isSavingDefaultRate ? 'Saving default rate…' : 'Save default rate'}
            </button>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon"><FileText size={20} /></span>
              <div>
                <h2>Statement details</h2>
                <p>Set a standard footer note for your workspace records.</p>
              </div>
            </div>
            <label className="settings-field">
              <span className="settings-field-label">Statement footer note</span>
              <textarea
                value={values.statementFooter}
                onChange={(event) => update('statementFooter', event.target.value)}
                placeholder="Optional note shown on statements"
                rows={3}
                maxLength={250}
              />
              <small>Up to 250 characters.</small>
            </label>
          </section>

          <section className="settings-card settings-system-card">
            <div className="settings-card-heading">
              <span className="settings-card-icon"><ShieldCheck size={20} /></span>
              <div>
                <h2>Workspace information</h2>
                <p>Current application and data configuration.</p>
              </div>
            </div>
            <div className="settings-info-list">
              <div><span>Application</span><strong>PropertyOS</strong></div>
              <div><span>Financial currency</span><strong>BDT · Bangladeshi Taka</strong></div>
              <div><span>Data storage</span><strong>Firebase Firestore</strong></div>
              <div><span>House icon</span><strong className="settings-icon-status"><img src="/icon-192.png" alt="T&N House's logo" /> Existing local app icon</strong></div>
            </div>
            <p className="settings-card-note">These settings do not rewrite existing bills, payments, ledger entries, or permanent record IDs.</p>
          </section>
        </div>

        <footer className="settings-form-actions">
          <button className="settings-reset-button" type="button" onClick={resetForm} disabled={isLoading || isSaving}>
            <RotateCcw size={16} aria-hidden="true" />
            Reset form
          </button>
          <button className="settings-save-button" type="submit" disabled={isLoading || isSaving}>
            {isSaving ? <LoaderCircle size={17} className="settings-spin" aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}
            {isSaving ? 'Saving changes…' : 'Save changes'}
          </button>
        </footer>
      </form>
    </section>
  )
}