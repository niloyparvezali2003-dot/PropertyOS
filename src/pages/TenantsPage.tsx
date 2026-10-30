import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type FormEvent,
} from 'react'

import {
    LoaderCircle,
    MapPin,
    Pencil,
    Phone,
    Plus,
    Users,
    X,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { recordAuditEvent } from '../services/firebase/audit'
import { TenantAssignmentsPanel } from '../components/tenants/TenantAssignmentsPanel'

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

type TenantsPageProps = {
    ownerUid: string
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

export function TenantsPage({ ownerUid }: TenantsPageProps) {
    const [tenants, setTenants] = useState<TenantRecord[]>([])
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<
        'all' | TenantStatus
    >('all')

    const [isLoading, setIsLoading] = useState(true)
    const [pageError, setPageError] = useState('')

    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingTenant, setEditingTenant] =
        useState<TenantRecord | null>(null)

    const [form, setForm] =
        useState<TenantFormValues>(emptyForm)

    const [formError, setFormError] = useState('')
    const [isSaving, setIsSaving] = useState(false)

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

    const filteredTenants = useMemo(() => {
        const query = search.trim().toLowerCase()

        return tenants.filter((tenant) => {
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

            <TenantAssignmentsPanel ownerUid={ownerUid} />

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
                        </article>
                    ))}
                </section>
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
        </>
    )
}