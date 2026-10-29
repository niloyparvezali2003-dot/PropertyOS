import { useEffect, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ContactRound,
  FileText,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldCheck,
} from 'lucide-react'

import {
  DEFAULT_WORKSPACE_SETTINGS,
  loadWorkspaceSettings,
  saveWorkspaceSettings,
  type WorkspaceSettings,
} from '../services/firebase/workspaceSettings'
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
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isSaved, setIsSaved] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    let mounted = true
    setIsLoading(true)
    setError('')
    void loadWorkspaceSettings(ownerUid)
      .then((result) => {
        if (!mounted) return
        setValues(result.settings)
        setIsSaved(result.isSaved)
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

  function resetForm() {
    setValues({ ...DEFAULT_WORKSPACE_SETTINGS })
    setSuccess('Default values loaded into the form. Select Save changes to persist them.')
    setError('')
  }

  return (
    <section className="settings-page">
      <header className="settings-page-heading">
        <div>
          <p className="settings-eyebrow">WORKSPACE CONFIGURATION</p>
          <h1>Settings</h1>
          <p>Manage your house profile and the contact details used by your PropertyOS workspace.</p>
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