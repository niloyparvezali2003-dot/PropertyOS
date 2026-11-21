import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type FormEvent,
} from 'react'

import {
    CircleDollarSign,
    Eye,
    LoaderCircle,
    MapPin,
    Pencil,
    Phone,
    Plus,
    ReceiptText,
    Users,
    Wallet,
    X,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { recordAuditEvent } from '../services/firebase/audit'
import {
    TenantAssignmentsPanel,
    type TenantAssignmentsSection,
} from '../components/tenants/TenantAssignmentsPanel'

import {
    createTenant,
    getTenantErrorMessage,
    listTenants,
    updateTenant,
    type TenantRecord,
} from '../services/firebase/tenants'

import {
    tenantFormSchema,
    type TenantFormValues,
    type TenantStatus,
} from '../schemas/tenant'
import { invalidateOwnerDataCache } from '../services/firebase/listCache'
import { loadLedgerSourceData, type LedgerSourceData } from '../services/firebase/ledgers'
import {
    listTenantCredits,
    type TenantCreditRecord,
} from '../services/firebase/payments'
import { resolveElectricityBillTenantAssignment } from '../services/firebase/electricity'
import type { AppPage } from '../types/navigation'
import './tenant-financial-profile.css'

type TenantProfileBillRow = {
    key: string
    billType: 'rent' | 'electricity'
    billingMonth: string
    referenceDate: string
    roomLabel: string
    amountMinor: number
    paidMinor: number
    outstandingMinor: number
    reading?: {
        previous: number
        current: number
        units: number
    }
}

type TenantsPageProps = {
    ownerUid: string
    onNavigate: (page: AppPage) => void
}

function formatTenantMoney(amountMinor: number): string {
    return `৳${new Intl.NumberFormat('en-BD', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amountMinor / 100)}`
}

function formatTenantProfileDate(value: string): string {
    const date = new Date(`${value}T00:00:00`)
    return Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat('en-BD', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

function formatTenantProfileMonth(value: string): string {
    const date = new Date(`${value}-01T00:00:00`)
    return Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat('en-BD', { month: 'long', year: 'numeric' }).format(date)
}

const emptyForm: TenantFormValues = {
    fullName: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
    status: 'active',
}

const statusLabels: Record<TenantStatus, string> = {
    active: 'Active',
    archived: 'Archived',
}

// The tenant directory is ordered by the tenant's name only.
// Keep English names in A-Z order, then Bengali names in Bengali collation order.
const englishTenantNameCollator = new Intl.Collator('en-BD', {
    usage: 'sort',
    sensitivity: 'base',
    numeric: true,
})

const bengaliTenantNameCollator = new Intl.Collator('bn-BD', {
    usage: 'sort',
    sensitivity: 'base',
    numeric: true,
})

function compareTenantDirectoryNames(left: string, right: string): number {
    const leftName = left.trim()
    const rightName = right.trim()

    const firstLetter = (value: string) =>
        Array.from(value).find((character) => /[A-Za-z\u0980-\u09FF]/.test(character)) ?? ''

    const leftStartsWithBengali = /[\u0980-\u09FF]/.test(firstLetter(leftName))
    const rightStartsWithBengali = /[\u0980-\u09FF]/.test(firstLetter(rightName))

    if (leftStartsWithBengali !== rightStartsWithBengali) {
        return leftStartsWithBengali ? 1 : -1
    }

    const collator = leftStartsWithBengali
        ? bengaliTenantNameCollator
        : englishTenantNameCollator

    return collator.compare(leftName, rightName)
}

export function TenantsPage({ ownerUid, onNavigate }: TenantsPageProps) {
    const [tenants, setTenants] = useState<TenantRecord[]>([])
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<
        'all' | TenantStatus
    >('all')
    const [activeSection, setActiveSection] = useState<TenantAssignmentsSection>('current')

    const [isLoading, setIsLoading] = useState(true)
    const [pageError, setPageError] = useState('')

    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingTenant, setEditingTenant] =
        useState<TenantRecord | null>(null)

    const [form, setForm] =
        useState<TenantFormValues>(emptyForm)

    const [formError, setFormError] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [financialProfileTenant, setFinancialProfileTenant] = useState<TenantRecord | null>(null)
    const [financialProfileData, setFinancialProfileData] = useState<LedgerSourceData | null>(null)
    const [financialProfileCredits, setFinancialProfileCredits] = useState<TenantCreditRecord[]>([])
    const [isFinancialProfileLoading, setIsFinancialProfileLoading] = useState(false)
    const [financialProfileError, setFinancialProfileError] = useState('')

    const loadTenants = useCallback(async () => {
        setIsLoading(true)
        setPageError('')

        try {
            const records = await listTenants(ownerUid)
            setTenants(records)
        } catch (error: unknown) {
            setPageError(getTenantErrorMessage(error))
        } finally {
            setIsLoading(false)
        }
    }, [ownerUid])

    useEffect(() => {
        void loadTenants()
    }, [loadTenants])

    async function openFinancialProfile(tenant: TenantRecord) {
        setFinancialProfileTenant(tenant)
        setFinancialProfileData(null)
        setFinancialProfileCredits([])
        setFinancialProfileError('')
        setIsFinancialProfileLoading(true)
        try {
            invalidateOwnerDataCache(ownerUid)
            const [ledgerData, credits] = await Promise.all([
                loadLedgerSourceData(ownerUid),
                listTenantCredits(ownerUid),
            ])
            setFinancialProfileData(ledgerData)
            setFinancialProfileCredits(credits)
        } catch (error: unknown) {
            setFinancialProfileError(error instanceof Error
                ? error.message
                : 'Could not load this tenant’s financial profile.')
        } finally {
            setIsFinancialProfileLoading(false)
        }
    }

    function closeFinancialProfile() {
        if (isFinancialProfileLoading) return
        setFinancialProfileTenant(null)
        setFinancialProfileData(null)
        setFinancialProfileCredits([])
        setFinancialProfileError('')
    }

    const financialProfileSummary = useMemo(() => {
        if (!financialProfileTenant || !financialProfileData) return null

        const balanceByKey = new Map(
            financialProfileData.billBalances.map((balance) => [
                `${balance.billType}__${balance.billId}`,
                balance,
            ] as const),
        )

        const billRows: TenantProfileBillRow[] = []
        for (const bill of financialProfileData.rentBills) {
            if (bill.tenantId !== financialProfileTenant.id || bill.status !== 'issued') continue
            const balance = balanceByKey.get(`rent__${bill.id}`)
            billRows.push({
                key: `rent__${bill.id}`,
                billType: 'rent',
                billingMonth: bill.billingMonth,
                referenceDate: bill.occupancyEndDate,
                roomLabel: `${bill.roomCode} · Room ${bill.roomNumber}`,
                amountMinor: bill.totalMinor,
                paidMinor: balance?.paidAmountMinor ?? 0,
                outstandingMinor: balance?.outstandingMinor ?? bill.totalMinor,
            })
        }

        const tenantElectricityBills = financialProfileData.electricityBills.filter((bill) => {
            const balance = balanceByKey.get(`electricity__${bill.id}`)
            const resolvedAssignment = resolveElectricityBillTenantAssignment(
                bill,
                financialProfileData.tenantAssignments,
            )
            const tenantId = bill.tenantId || balance?.tenantId || resolvedAssignment?.tenantId
            return tenantId === financialProfileTenant.id
        })

        for (const bill of tenantElectricityBills) {
            const balance = balanceByKey.get(`electricity__${bill.id}`)
            const resolvedAssignment = resolveElectricityBillTenantAssignment(
                bill,
                financialProfileData.tenantAssignments,
            )
            billRows.push({
                key: `electricity__${bill.id}`,
                billType: 'electricity',
                billingMonth: bill.billingMonth,
                referenceDate: bill.readingDate,
                roomLabel: `${bill.roomCode} · Room ${bill.tenantRoomNumber || resolvedAssignment?.roomNumber || '—'}`,
                amountMinor: bill.amountMinor,
                paidMinor: balance?.paidAmountMinor ?? 0,
                outstandingMinor: balance?.outstandingMinor ?? bill.amountMinor,
                reading: {
                    previous: bill.previousReading,
                    current: bill.currentReading,
                    units: bill.unitsConsumed,
                },
            })
        }

        billRows.sort((left, right) =>
            right.billingMonth.localeCompare(left.billingMonth) ||
            right.referenceDate.localeCompare(left.referenceDate),
        )

        const openingDueMinor = financialProfileData.openingBalances
            .filter((balance) => balance.tenantId === financialProfileTenant.id)
            .reduce((total, balance) => total + balance.outstandingMinor, 0)
        const outstandingMinor = openingDueMinor + billRows.reduce(
            (total, bill) => total + Math.max(0, bill.outstandingMinor),
            0,
        )
        const advanceMinor = financialProfileCredits.find(
            (credit) => credit.tenantId === financialProfileTenant.id,
        )?.creditMinor ?? 0

        return {
            billRows,
            readingRows: tenantElectricityBills.sort((left, right) =>
                right.readingDate.localeCompare(left.readingDate),
            ),
            openingDueMinor,
            outstandingMinor,
            advanceMinor,
            assignments: financialProfileData.tenantAssignments
                .filter((assignment) => assignment.tenantId === financialProfileTenant.id)
                .sort((left, right) => right.moveInDate.localeCompare(left.moveInDate)),
        }
    }, [financialProfileTenant, financialProfileData, financialProfileCredits])

    const filteredTenants = useMemo(() => {
        const query = search.trim().toLowerCase()

        return tenants
            .filter((tenant) => {
                if (statusFilter !== 'all' && tenant.status !== statusFilter) {
                    return false
                }

                if (!query) return true

                return [
                    tenant.tenantCode,
                    tenant.fullName,
                    tenant.phone,
                    tenant.email,
                    tenant.address,
                    tenant.notes,
                ]
                    .join(' ')
                    .toLowerCase()
                    .includes(query)
            })
            .sort((left, right) =>
                compareTenantDirectoryNames(left.fullName, right.fullName),
            )
    }, [tenants, search, statusFilter])

    function openCreateDialog() {
        setEditingTenant(null)
        setForm({ ...emptyForm })
        setFormError('')
        setIsDialogOpen(true)
    }

    function openEditDialog(tenant: TenantRecord) {
        setEditingTenant(tenant)

        setForm({
            fullName: tenant.fullName,
            phone: tenant.phone,
            email: tenant.email,
            address: tenant.address,
            notes: tenant.notes,
            status: tenant.status,
        })

        setFormError('')
        setIsDialogOpen(true)
    }

    function closeDialog() {
        if (isSaving) return

        setIsDialogOpen(false)
        setEditingTenant(null)
        setForm({ ...emptyForm })
        setFormError('')
    }

    function updateField<K extends keyof TenantFormValues>(
        field: K,
        value: TenantFormValues[K],
    ) {
        setForm((current) => ({
            ...current,
            [field]: value,
        }))
    }

    async function handleSubmit(
        event: FormEvent<HTMLFormElement>,
    ) {
        event.preventDefault()

        if (isSaving) return

        setFormError('')

        const result = tenantFormSchema.safeParse(form)

        if (!result.success) {
            setFormError(
                result.error.issues[0]?.message ??
                'Please review the tenant information.',
            )
            return
        }

        setIsSaving(true)

        try {
            if (editingTenant) {
                await updateTenant(
                    ownerUid,
                    editingTenant.id,
                    result.data,
                )
                await recordAuditEvent(ownerUid, {
                    action: 'updated',
                    entityType: 'tenant',
                    entityId: editingTenant.id,
                    entityLabel: result.data.fullName,
                    summary: `Updated tenant profile for ${result.data.fullName}.`,
                })
            } else {
                const tenantId = await createTenant(ownerUid, result.data)
                await recordAuditEvent(ownerUid, {
                    action: 'created',
                    entityType: 'tenant',
                    entityId: tenantId,
                    entityLabel: result.data.fullName,
                    summary: `Created tenant profile for ${result.data.fullName}.`,
                })
            }

            setIsDialogOpen(false)
            setEditingTenant(null)
            setForm({ ...emptyForm })
            if (!editingTenant) setActiveSection('tenants')

            await loadTenants()
        } catch (error: unknown) {
            setFormError(getTenantErrorMessage(error))
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <>
            <header className="page-heading">
                <div>
                    <p className="eyebrow">Property management</p>
                    <h1>Tenants</h1>
                    <p className="page-description">
                        Maintain tenant profiles and permanent tenant IDs.
                    </p>
                </div>

                <button
                    className="button button-primary"
                    type="button"
                    onClick={openCreateDialog}
                >
                    <Plus size={18} aria-hidden="true" />
                    Add tenant
                </button>
            </header>

            <TenantAssignmentsPanel
                ownerUid={ownerUid}
                activeSection={activeSection}
                onSectionChange={setActiveSection}
            />

            {activeSection === 'tenants' && (
                <>
            <section className="tenants-toolbar">
                <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search tenants, IDs, or phone numbers..."
                />

                <select
                    className="tenant-filter"
                    aria-label="Filter tenants by status"
                    value={statusFilter}
                    onChange={(event) =>
                        setStatusFilter(
                            event.target.value as 'all' | TenantStatus,
                        )
                    }
                >
                    <option value="all">All tenants</option>
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                </select>

                <span className="tenants-count">
                    {filteredTenants.length}{' '}
                    {filteredTenants.length === 1 ? 'tenant' : 'tenants'}
                </span>
            </section>

            {pageError && (
                <div className="properties-error" role="alert">
                    <p>{pageError}</p>

                    <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => void loadTenants()}
                    >
                        Retry
                    </button>
                </div>
            )}

            {isLoading ? (
                <div className="properties-state" role="status">
                    <LoaderCircle size={22} aria-hidden="true" />
                    <p>Loading tenants...</p>
                </div>
            ) : filteredTenants.length === 0 ? (
                <section className="properties-empty">
                    <span className="properties-empty-icon">
                        <Users size={25} aria-hidden="true" />
                    </span>

                    <h2>
                        {tenants.length === 0
                            ? 'No tenants yet'
                            : 'No matching tenants'}
                    </h2>

                    <p>
                        {tenants.length === 0
                            ? 'Create a tenant profile to begin. Room assignments and tenancy history will be managed separately.'
                            : 'Try another search term or status filter.'}
                    </p>

                    {tenants.length === 0 && (
                        <button
                            className="button button-primary"
                            type="button"
                            onClick={openCreateDialog}
                        >
                            <Plus size={17} aria-hidden="true" />
                            Add your first tenant
                        </button>
                    )}
                </section>
            ) : (
                <section className="tenants-grid" aria-label="Tenants">
                    {filteredTenants.map((tenant) => (
                        <article className="tenant-card" key={tenant.id}>
                            <div className="tenant-card-heading">
                                <span className="tenant-avatar">
                                    {tenant.fullName
                                        .trim()
                                        .charAt(0)
                                        .toUpperCase()}
                                </span>

                                <span
                                    className={`tenant-status tenant-status--${tenant.status}`}
                                >
                                    {statusLabels[tenant.status]}
                                </span>
                            </div>

                            <div className="tenant-name-row">
                                <h2>{tenant.fullName}</h2>
                                <span className="tenant-code">
                                    {tenant.tenantCode}
                                </span>
                            </div>

                            <p className="tenant-contact">
                                <Phone size={15} aria-hidden="true" />
                                <span>{tenant.phone}</span>
                            </p>

                            {tenant.email && (
                                <p className="tenant-secondary">
                                    {tenant.email}
                                </p>
                            )}

                            {tenant.address && (
                                <p className="tenant-contact">
                                    <MapPin size={15} aria-hidden="true" />
                                    <span>{tenant.address}</span>
                                </p>
                            )}

                            {tenant.notes && (
                                <p className="tenant-notes">{tenant.notes}</p>
                            )}

                            <div className="tenant-card-footer">
                                <span
                                    className="tenant-permanent-label"
                                    title={`Database reference: ${tenant.id}`}
                                >
                                    Permanent tenant ID
                                </span>
                                <div className="tenant-card-actions">
                                    <button
                                        className="button button-secondary tenant-profile-button"
                                        type="button"
                                        onClick={() => void openFinancialProfile(tenant)}
                                    >
                                        <Eye size={15} aria-hidden="true" />
                                        Financial profile
                                    </button>
                                    <button
                                        className="button button-secondary tenant-edit-button"
                                        type="button"
                                        onClick={() => openEditDialog(tenant)}
                                        aria-label={`Edit ${tenant.fullName}`}
                                    >
                                        <Pencil size={15} aria-hidden="true" />
                                        Edit
                                    </button>
                                </div>
                            </div>
                        </article>
                    ))}
                </section>
            )}
                </>
            )}

            {isDialogOpen && (
                <div className="modal-overlay">
                    <section
                        className="property-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="tenant-dialog-title"
                    >
                        <header className="property-modal-heading">
                            <div>
                                <p className="eyebrow">Tenant profile</p>

                                <h2 id="tenant-dialog-title">
                                    {editingTenant ? 'Edit tenant' : 'Add tenant'}
                                </h2>
                            </div>

                            <button
                                className="icon-button"
                                type="button"
                                onClick={closeDialog}
                                disabled={isSaving}
                                aria-label="Close tenant form"
                            >
                                <X size={20} aria-hidden="true" />
                            </button>
                        </header>

                        {editingTenant && (
                            <div className="property-id-note">
                                Permanent tenant ID: {editingTenant.tenantCode}
                            </div>
                        )}

                        <form
                            className="property-form"
                            onSubmit={handleSubmit}
                            noValidate
                        >
                            <div className="property-form-field">
                                <label htmlFor="tenant-name">
                                    Full name <span aria-hidden="true">*</span>
                                </label>

                                <input
                                    id="tenant-name"
                                    type="text"
                                    value={form.fullName}
                                    onChange={(event) =>
                                        updateField('fullName', event.target.value)
                                    }
                                    placeholder="Enter tenant's full name"
                                    maxLength={100}
                                    autoComplete="name"
                                    required
                                    disabled={isSaving}
                                />
                            </div>

                            <div className="property-form-field">
                                <label htmlFor="tenant-phone">
                                    Phone number <span aria-hidden="true">*</span>
                                </label>

                                <input
                                    id="tenant-phone"
                                    type="tel"
                                    value={form.phone}
                                    onChange={(event) =>
                                        updateField('phone', event.target.value)
                                    }
                                    placeholder="e.g. 01XXXXXXXXX"
                                    maxLength={20}
                                    autoComplete="tel"
                                    required
                                    disabled={isSaving}
                                />
                            </div>

                            <div className="property-form-field">
                                <label htmlFor="tenant-email">Email address</label>

                                <input
                                    id="tenant-email"
                                    type="email"
                                    value={form.email}
                                    onChange={(event) =>
                                        updateField('email', event.target.value)
                                    }
                                    placeholder="Optional email address"
                                    maxLength={254}
                                    autoComplete="email"
                                    disabled={isSaving}
                                />
                            </div>

                            <div className="property-form-field">
                                <label htmlFor="tenant-address">Address</label>

                                <input
                                    id="tenant-address"
                                    type="text"
                                    value={form.address}
                                    onChange={(event) =>
                                        updateField('address', event.target.value)
                                    }
                                    placeholder="Optional address"
                                    maxLength={240}
                                    autoComplete="street-address"
                                    disabled={isSaving}
                                />
                            </div>

                            <div className="property-form-field">
                                <label htmlFor="tenant-status">Profile status</label>

                                <select
                                    id="tenant-status"
                                    value={form.status}
                                    onChange={(event) =>
                                        updateField(
                                            'status',
                                            event.target.value as TenantStatus,
                                        )
                                    }
                                    disabled={isSaving}
                                >
                                    <option value="active">Active</option>
                                    <option value="archived">Archived</option>
                                </select>

                                <small className="field-hint">
                                    Archiving a profile does not delete it or its permanent ID.
                                </small>
                            </div>

                            <div className="property-form-field">
                                <label htmlFor="tenant-notes">Notes</label>

                                <textarea
                                    id="tenant-notes"
                                    value={form.notes}
                                    onChange={(event) =>
                                        updateField('notes', event.target.value)
                                    }
                                    placeholder="Optional internal notes"
                                    maxLength={1000}
                                    rows={3}
                                    disabled={isSaving}
                                />
                            </div>

                            {formError && (
                                <p className="auth-error" role="alert">
                                    {formError}
                                </p>
                            )}

                            <div className="property-form-actions">
                                <button
                                    className="button button-secondary"
                                    type="button"
                                    onClick={closeDialog}
                                    disabled={isSaving}
                                >
                                    Cancel
                                </button>

                                <button
                                    className="button button-primary"
                                    type="submit"
                                    disabled={isSaving}
                                >
                                    {isSaving ? (
                                        <LoaderCircle
                                            className="auth-spinner"
                                            size={17}
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <Plus size={17} aria-hidden="true" />
                                    )}

                                    {isSaving
                                        ? 'Saving...'
                                        : editingTenant
                                            ? 'Save changes'
                                            : 'Create tenant'}
                                </button>
                            </div>
                        </form>
                    </section>
                </div>
            )}

            {financialProfileTenant && (
                <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
                    if (event.target === event.currentTarget) closeFinancialProfile()
                }}>
                    <section
                        className="property-modal tenant-financial-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="tenant-financial-profile-title"
                    >
                        <header className="property-modal-heading">
                            <div>
                                <p className="eyebrow">Tenant profile · Financial history</p>
                                <h2 id="tenant-financial-profile-title">{financialProfileTenant.fullName}</h2>
                                <p className="tenant-financial-profile-code">{financialProfileTenant.tenantCode}</p>
                            </div>
                            <button
                                className="icon-button"
                                type="button"
                                onClick={closeFinancialProfile}
                                disabled={isFinancialProfileLoading}
                                aria-label="Close financial profile"
                            >
                                <X size={20} aria-hidden="true" />
                            </button>
                        </header>

                        {isFinancialProfileLoading ? (
                            <div className="tenant-financial-state" role="status">
                                <LoaderCircle size={20} className="auth-spinner" aria-hidden="true" />
                                Loading tenant bills and meter readings…
                            </div>
                        ) : financialProfileError ? (
                            <div className="tenant-financial-error" role="alert">{financialProfileError}</div>
                        ) : financialProfileSummary ? (
                            <>
                                <div className="tenant-financial-summary">
                                    <article>
                                        <span><Wallet size={15} aria-hidden="true" /> Outstanding due</span>
                                        <strong>{formatTenantMoney(financialProfileSummary.outstandingMinor)}</strong>
                                    </article>
                                    <article>
                                        <span><CircleDollarSign size={15} aria-hidden="true" /> Available advance</span>
                                        <strong>{formatTenantMoney(financialProfileSummary.advanceMinor)}</strong>
                                    </article>
                                    <article>
                                        <span><ReceiptText size={15} aria-hidden="true" /> Issued bills</span>
                                        <strong>{financialProfileSummary.billRows.length}</strong>
                                    </article>
                                </div>

                                <section className="tenant-financial-section">
                                    <div className="tenant-financial-section-heading">
                                        <h3>Outstanding and paid bills</h3>
                                        <span>{financialProfileSummary.billRows.length} records</span>
                                    </div>
                                    {financialProfileSummary.billRows.length === 0 && financialProfileSummary.openingDueMinor === 0 ? (
                                        <p className="tenant-financial-empty">No issued rent or electricity bills are recorded for this tenant.</p>
                                    ) : (
                                        <div className="tenant-financial-table-wrap">
                                            <table className="tenant-financial-table">
                                                <thead><tr><th>Bill</th><th>Month / date</th><th>Room</th><th>Bill</th><th>Paid</th><th>Due</th></tr></thead>
                                                <tbody>
                                                    {financialProfileSummary.openingDueMinor > 0 && (
                                                        <tr>
                                                            <td>Opening due</td>
                                                            <td>Previous balance</td>
                                                            <td>Tenant</td>
                                                            <td>—</td>
                                                            <td>—</td>
                                                            <td>{formatTenantMoney(financialProfileSummary.openingDueMinor)}</td>
                                                        </tr>
                                                    )}
                                                    {financialProfileSummary.billRows.map((bill) => (
                                                        <tr key={bill.key}>
                                                            <td>{bill.billType === 'rent' ? 'Rent' : 'Electricity'}</td>
                                                            <td>{formatTenantProfileMonth(bill.billingMonth)}<small>{formatTenantProfileDate(bill.referenceDate)}</small></td>
                                                            <td>{bill.roomLabel}</td>
                                                            <td>{formatTenantMoney(bill.amountMinor)}</td>
                                                            <td>{formatTenantMoney(bill.paidMinor)}</td>
                                                            <td>{formatTenantMoney(bill.outstandingMinor)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </section>

                                <section className="tenant-financial-section">
                                    <div className="tenant-financial-section-heading">
                                        <h3>Electricity reading history</h3>
                                        <span>{financialProfileSummary.readingRows.length} readings</span>
                                    </div>
                                    {financialProfileSummary.readingRows.length === 0 ? (
                                        <p className="tenant-financial-empty">No electricity readings are recorded for this tenant.</p>
                                    ) : (
                                        <div className="tenant-financial-reading-list">
                                            {financialProfileSummary.readingRows.map((reading) => (
                                                <article key={reading.id}>
                                                    <div>
                                                        <strong>{reading.meterCode} · {reading.roomCode}</strong>
                                                        <small>{formatTenantProfileDate(reading.readingDate)} · {formatTenantProfileMonth(reading.billingMonth)}</small>
                                                    </div>
                                                    <div className="tenant-financial-reading-values">
                                                        <span><small>Previous</small><b>{reading.previousReading.toLocaleString('en-BD')}</b></span>
                                                        <span><small>Current</small><b>{reading.currentReading.toLocaleString('en-BD')}</b></span>
                                                        <span><small>Units</small><b>{reading.unitsConsumed.toLocaleString('en-BD')}</b></span>
                                                        <span><small>Bill</small><b>{formatTenantMoney(reading.amountMinor)}</b></span>
                                                    </div>
                                                </article>
                                            ))}
                                        </div>
                                    )}
                                </section>

                                <section className="tenant-financial-section">
                                    <div className="tenant-financial-section-heading">
                                        <h3>Room assignment history</h3>
                                        <span>{financialProfileSummary.assignments.length} assignments</span>
                                    </div>
                                    {financialProfileSummary.assignments.length === 0 ? (
                                        <p className="tenant-financial-empty">No room assignments are recorded.</p>
                                    ) : (
                                        <div className="tenant-financial-assignment-list">
                                            {financialProfileSummary.assignments.map((assignment) => (
                                                <article key={assignment.id}>
                                                    <strong>{assignment.roomCode} · Room {assignment.roomNumber}</strong>
                                                    <span>{assignment.propertyCode} · {assignment.floorName}</span>
                                                    <small>{assignment.moveInDate} – {assignment.moveOutDate ?? 'Current'}</small>
                                                </article>
                                            ))}
                                        </div>
                                    )}
                                </section>
                                <div className="tenant-financial-footer">
                                    <p>Record or allocate a receipt for this tenant from the Payments page. Existing unpaid bills remain available there.</p>
                                    <button
                                        className="button button-primary"
                                        type="button"
                                        onClick={() => onNavigate('Payments')}
                                    >
                                        <Wallet size={16} aria-hidden="true" />
                                        Open Payments
                                    </button>
                                </div>
                            </>
                        ) : null}
                    </section>
                </div>
            )}
        </>
    )
}