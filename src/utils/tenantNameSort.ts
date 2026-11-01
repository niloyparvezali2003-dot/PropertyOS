/**
 * Locale-aware comparison for tenant-name dropdown ordering.
 * English names sort A-Z first; Bengali names use Bengali collation order.
 * Empty labels (for unassigned rooms/meters) remain after named tenants.
 */
const tenantNameCollator = new Intl.Collator('en-BD', {
  usage: 'sort',
  sensitivity: 'base',
  numeric: true,
})

export function compareTenantNames(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftName = left?.trim() ?? ''
  const rightName = right?.trim() ?? ''

  if (!leftName && !rightName) return 0
  if (!leftName) return 1
  if (!rightName) return -1

  return tenantNameCollator.compare(leftName, rightName)
}
