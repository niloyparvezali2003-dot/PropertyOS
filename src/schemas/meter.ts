import { z } from 'zod'

export const meterStatusSchema = z.enum([
  'available',
  'assigned',
  'retired',
])

export const meterAssignmentStatusSchema = z.enum([
  'current',
  'ended',
])

export const meterReplacementReasonSchema = z.enum([
  'damaged',
  'overreading',
  'slow_reading',
  'other',
])

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(year, month - 1, day)

    return (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    )
  }, 'Enter a valid calendar date.')

const meterReadingSchema = z
  .number()
  .finite('Meter reading must be a valid number.')
  .min(0, 'Meter reading cannot be negative.')
  .max(1_000_000_000, 'Meter reading is too large.')

export const meterFormSchema = z
  .object({
    serialNumber: z
      .string()
      .trim()
      .max(80, 'Serial number cannot exceed 80 characters.'),

    notes: z
      .string()
      .trim()
      .max(1000, 'Notes cannot exceed 1,000 characters.'),
  })
  .strict()

export const meterAssignmentFormSchema = z
  .object({
    roomId: z.string().trim().min(1, 'Select a room.'),

    assignedOn: dateOnlySchema,

    initialReading: meterReadingSchema,
  })
  .strict()

export const meterReplacementFormSchema = z
  .object({
    replacementDate: dateOnlySchema,

    finalReading: meterReadingSchema,

    newInitialReading: meterReadingSchema,

    reason: meterReplacementReasonSchema,

    newSerialNumber: z
      .string()
      .trim()
      .max(80, 'Serial number cannot exceed 80 characters.'),

    notes: z
      .string()
      .trim()
      .max(1000, 'Notes cannot exceed 1,000 characters.'),
  })
  .strict()

export type MeterStatus = z.infer<typeof meterStatusSchema>

export type MeterAssignmentStatus = z.infer<
  typeof meterAssignmentStatusSchema
>

export type MeterReplacementReason = z.infer<
  typeof meterReplacementReasonSchema
>

export type MeterFormValues = z.infer<typeof meterFormSchema>

export type MeterAssignmentFormValues = z.infer<
  typeof meterAssignmentFormSchema
>

export type MeterReplacementFormValues = z.infer<
  typeof meterReplacementFormSchema
>