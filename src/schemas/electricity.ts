import { z } from 'zod'

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export const electricityDateSchema = z.string().refine(isValidDate, 'Enter a valid calendar date.')

export const electricityRateFormSchema = z.object({
  roomId: z.string().trim().min(1, 'Select a room.'),
  effectiveFrom: electricityDateSchema,
  pricePerUnitMinor: z.number().int().positive('Rate must be greater than zero.').max(10_000_000, 'Rate exceeds the permitted limit.'),
  notes: z.string().trim().max(1000, 'Notes cannot exceed 1,000 characters.'),
}).strict()

export const electricityReadingFormSchema = z.object({
  meterAssignmentId: z.string().trim().min(1, 'Select a current meter assignment.'),
  readingDate: electricityDateSchema,
  currentReading: z.number().finite().min(0, 'Reading cannot be negative.').max(1_000_000_000, 'Reading is too large.'),
  notes: z.string().trim().max(1000, 'Notes cannot exceed 1,000 characters.'),
}).strict()

export type ElectricityRateFormValues = z.infer<typeof electricityRateFormSchema>
export type ElectricityReadingFormValues = z.infer<typeof electricityReadingFormSchema>
