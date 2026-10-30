import { z } from 'zod'

const validIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export const openingBalanceFormSchema = z.object({
  tenantId: z.string().trim().min(1).max(500),
  tenantCode: z.string().regex(/^T[0-9]{5}[A-Z]$/),
  tenantName: z.string().trim().min(2).max(100),
  effectiveDate: z.string().refine(validIsoDate, 'Enter a valid effective date.'),
  amountMinor: z.number().int().positive().max(10_000_000_000_000),
  note: z.string().trim().max(1000),
}).strict()

export const openingBalanceAdjustmentSchema = z.object({
  direction: z.enum(['increase', 'decrease']),
  amountMinor: z.number().int().positive().max(10_000_000_000_000),
  effectiveDate: z.string().refine(validIsoDate, 'Enter a valid adjustment date.'),
  note: z.string().trim().min(1).max(1000),
}).strict()

export type OpeningBalanceFormValues = z.infer<typeof openingBalanceFormSchema>
export type OpeningBalanceAdjustmentValues = z.infer<typeof openingBalanceAdjustmentSchema>
