import { z } from 'zod'

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

export const isoDateSchema = z
  .string()
  .refine(isValidIsoDate, 'Enter a valid date.')

export const tenantAssignmentFormSchema = z
  .object({
    tenantId: z.string().trim().min(1, 'Select a tenant.'),
    roomId: z.string().trim().min(1, 'Select a room.'),
    moveInDate: isoDateSchema,
    notes: z.string().trim().max(1000, 'Notes cannot exceed 1,000 characters.'),
  })
  .strict()

export const tenantMoveOutSchema = z
  .object({
    moveOutDate: isoDateSchema,
    moveOutNotes: z
      .string()
      .trim()
      .max(1000, 'Move-out notes cannot exceed 1,000 characters.'),
  })
  .strict()

export type TenantAssignmentFormValues = z.infer<
  typeof tenantAssignmentFormSchema
>

export type TenantMoveOutFormValues = z.infer<typeof tenantMoveOutSchema>

export type TenantAssignmentStatus = 'current' | 'ended'
