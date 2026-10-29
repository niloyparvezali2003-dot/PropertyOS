import { ArrowLeft } from 'lucide-react'
import type { AppPage } from '../types/navigation'

type ModulePage = Exclude<AppPage, 'Dashboard'>

type ModulePlaceholderProps = {
  page: ModulePage
  onNavigate: (page: AppPage) => void
}

const descriptions: Record<ModulePage, string> = {
  Properties:
    'Create properties and manage their buildings, floors, and units.',
  Rooms:
    'Manage rooms, occupancy status, room history, and tenant assignments.',
  Tenants:
    'Maintain tenant profiles, move-in and move-out dates, and tenancy history.',
  'Rent & Bills':
    'Generate monthly rent bills, track bill status, and preserve historical amounts.',
  Electricity:
    'Manage meters, readings, electricity rates, and electricity bills.',
  Meters:
    'Register meters, assign them to rooms, and preserve replacement history.',
  Payments:
    'Record payments and track outstanding balances without duplicate credits.',
  Ledgers:
    'Review unified tenant, room, and meter transaction statements.',
  Reports:
    'Review monthly billing, payments received, outstanding balances, and tenant advances.',
  History:
    'Review tenant, room, bill, payment, and rate history.',
  Backup:
    'Download a local JSON archive of your existing Firestore records.',
  Settings:
    'Configure PropertyOS preferences and workspace settings.',
}

export function ModulePlaceholder({
  page,
  onNavigate,
}: ModulePlaceholderProps) {
  return (
    <section className="module-placeholder">
      <p className="eyebrow">WORKSPACE MODULE</p>
      <h1>{page}</h1>
      <p className="page-description">{descriptions[page]}</p>

      <div className="module-note">
        <strong>This module has not been implemented yet.</strong>
        <p>
          We will build its forms, validation, data model, and error
          handling before connecting it to Firebase.
        </p>
      </div>

      <button
        className="button button-secondary"
        type="button"
        onClick={() => onNavigate('Dashboard')}
      >
        <ArrowLeft size={17} />
        Back to dashboard
      </button>
    </section>
  )
}