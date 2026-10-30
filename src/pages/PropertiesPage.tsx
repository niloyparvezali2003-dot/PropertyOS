import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'

import {
  Building2,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  X,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import { recordAuditEvent } from '../services/firebase/audit'
import {
  createProperty,
  getPropertyErrorMessage,
  listProperties,
  updateProperty,
  type PropertyRecord,
} from '../services/firebase/properties'

import {
  propertyFormSchema,
  type PropertyFormValues,
} from '../schemas/property'

type PropertiesPageProps = {
  ownerUid: string
}

const emptyForm: PropertyFormValues = {
  name: '',
  address: '',
  notes: '',
}

export function PropertiesPage({
  ownerUid,
}: PropertiesPageProps) {
  const [properties, setProperties] =
    useState<PropertyRecord[]>([])

  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [pageError, setPageError] = useState('')

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingProperty, setEditingProperty] =
    useState<PropertyRecord | null>(null)

  const [form, setForm] =
    useState<PropertyFormValues>(emptyForm)

  const [formError, setFormError] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const loadProperties = useCallback(async () => {
    setIsLoading(true)
    setPageError('')

    try {
      const records = await listProperties(ownerUid)
      setProperties(records)
    } catch (error: unknown) {
      setPageError(getPropertyErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadProperties()
  }, [loadProperties])

  const filteredProperties = useMemo(() => {
    const query = search.trim().toLowerCase()

    if (!query) return properties

    return properties.filter((property) =>
      [
        property.name,
        property.address,
        property.notes,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
  }, [properties, search])

  function openCreateDialog() {
    setEditingProperty(null)
    setForm({ ...emptyForm })
    setFormError('')
    setIsDialogOpen(true)
  }

  function openEditDialog(property: PropertyRecord) {
    setEditingProperty(property)

    setForm({
      name: property.name,
      address: property.address,
      notes: property.notes,
    })

    setFormError('')
    setIsDialogOpen(true)
  }

  function closeDialog() {
    if (isSaving) return

    setIsDialogOpen(false)
    setEditingProperty(null)
    setForm({ ...emptyForm })
    setFormError('')
  }

  function updateFormField(
    field: keyof PropertyFormValues,
    value: string,
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

    const result = propertyFormSchema.safeParse(form)

    if (!result.success) {
      setFormError(
        result.error.issues[0]?.message ??
          'Please review the property information.',
      )
      return
    }

    setIsSaving(true)

    try {
      if (editingProperty) {
        await updateProperty(
          ownerUid,
          editingProperty.id,
          result.data,
        )
        await recordAuditEvent(ownerUid, {
          action: 'updated',
          entityType: 'property',
          entityId: editingProperty.id,
          entityLabel: result.data.name,
          summary: `Updated property details for ${result.data.name}.`,
        })
      } else {
        const propertyId = await createProperty(ownerUid, result.data)
        await recordAuditEvent(ownerUid, {
          action: 'created',
          entityType: 'property',
          entityId: propertyId,
          entityLabel: result.data.name,
          summary: `Created property ${result.data.name}.`,
        })
      }

      setIsDialogOpen(false)
      setEditingProperty(null)
      setForm({ ...emptyForm })

      await loadProperties()
    } catch (error: unknown) {
      setFormError(getPropertyErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Properties</h1>
          <p className="page-description">
            Manage your properties and their basic information.
          </p>
        </div>

        <button
          className="button button-primary"
          type="button"
          onClick={openCreateDialog}
        >
          <Plus size={18} aria-hidden="true" />
          Add property
        </button>
      </header>

      <section className="properties-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search properties..."
        />

        <span className="properties-count">
          {properties.length}{' '}
          {properties.length === 1 ? 'property' : 'properties'}
        </span>
      </section>

      {pageError && (
        <div className="properties-error" role="alert">
          <p>{pageError}</p>

          <button
            className="button button-secondary"
            type="button"
            onClick={() => void loadProperties()}
          >
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="properties-state" role="status">
          <LoaderCircle size={22} aria-hidden="true" />
          <p>Loading properties...</p>
        </div>
      ) : filteredProperties.length === 0 ? (
        <section className="properties-empty">
          <span className="properties-empty-icon">
            <Building2 size={25} aria-hidden="true" />
          </span>

          <h2>
            {properties.length === 0
              ? 'No properties yet'
              : 'No matching properties'}
          </h2>

          <p>
            {properties.length === 0
              ? 'Add your first property to begin organizing its rooms and tenants.'
              : 'Try another search term.'}
          </p>

          {properties.length === 0 && (
            <button
              className="button button-primary"
              type="button"
              onClick={openCreateDialog}
            >
              <Plus size={17} aria-hidden="true" />
              Add your first property
            </button>
          )}
        </section>
      ) : (
        <section className="properties-grid" aria-label="Properties">
          {filteredProperties.map((property) => (
            <article className="property-card" key={property.id}>
              <div className="property-card-heading">
                <span className="property-card-icon">
                  <Building2 size={21} aria-hidden="true" />
                </span>

                <span className="property-status">
                  {property.status === 'active'
                    ? 'Active'
                    : 'Archived'}
                </span>
              </div>

              <h2>{property.name}</h2>

              <p className="property-address">
                <MapPin size={15} aria-hidden="true" />

                <span>
                  {property.address || 'No address added'}
                </span>
              </p>

              {property.notes && (
                <p className="property-notes">
                  {property.notes}
                </p>
              )}

              <div className="property-card-footer">
                <span className="property-id" title={property.id}>
                  ID: {property.propertyCode}
                </span>

                <button
                  className="button button-secondary property-edit-button"
                  type="button"
                  onClick={() => openEditDialog(property)}
                  aria-label={`Edit ${property.name}`}
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
            aria-labelledby="property-dialog-title"
          >
            <header className="property-modal-heading">
              <div>
                <p className="eyebrow">
                  PROPERTY DETAILS
                </p>

                <h2 id="property-dialog-title">
                  {editingProperty
                    ? 'Edit property'
                    : 'Add property'}
                </h2>
              </div>

              <button
                className="icon-button"
                type="button"
                onClick={closeDialog}
                disabled={isSaving}
                aria-label="Close property form"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            {editingProperty && (
              <div className="property-id-note">
                Permanent property ID: {editingProperty.propertyCode}
              </div>
            )}

            <form
              className="property-form"
              onSubmit={handleSubmit}
              noValidate
            >
              <div className="property-form-field">
                <label htmlFor="property-name">
                  Property name <span aria-hidden="true">*</span>
                </label>

                <input
                  id="property-name"
                  type="text"
                  value={form.name}
                  onChange={(event) =>
                    updateFormField('name', event.target.value)
                  }
                  placeholder="e.g. Green View Apartments"
                  maxLength={100}
                  autoComplete="organization"
                  required
                  disabled={isSaving}
                />
              </div>

              <div className="property-form-field">
                <label htmlFor="property-address">
                  Address
                </label>

                <input
                  id="property-address"
                  type="text"
                  value={form.address}
                  onChange={(event) =>
                    updateFormField('address', event.target.value)
                  }
                  placeholder="Property location"
                  maxLength={240}
                  autoComplete="street-address"
                  disabled={isSaving}
                />
              </div>

              <div className="property-form-field">
                <label htmlFor="property-notes">
                  Notes
                </label>

                <textarea
                  id="property-notes"
                  value={form.notes}
                  onChange={(event) =>
                    updateFormField('notes', event.target.value)
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
                    : editingProperty
                      ? 'Save changes'
                      : 'Create property'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  )
}