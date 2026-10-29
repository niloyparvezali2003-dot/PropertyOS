import { z } from 'zod'

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function isValidBillingMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

export const rentIsoDateSchema = z
  .string()
  .refine(isValidIsoDate, 'Enter a valid date.')

export const rentBillingMonthSchema = z
  .string()
  .refine(
    isValidBillingMonth,
    'Select a valid billing month.',
  )

export const roomRentRateFormSchema = z
  .object({
    roomId: z.string().trim().min(1, 'Select a room.'),

    effectiveFrom: rentIsoDateSchema,

    // Store money as integer poisha.
    // 100 poisha = ৳1.
    monthlyRentMinor: z
      .number()
      .int()
      .positive('Monthly rent must be greater than zero.')
      .max(
        10_000_000_000,
        'Monthly rent exceeds the permitted limit.',
      ),

    notes: z
      .string()
      .trim()
      .max(1000, 'Notes cannot exceed 1,000 characters.'),
  })
  .strict()

export type RoomRentRateFormValues = z.infer<
  typeof roomRentRateFormSchema
>

export type RentBillStatus = 'issued'

export type RentBillRateSnapshot = {
  rateId: string
  effectiveFrom: string
  monthlyRentMinor: number
  segmentStartDate: string
  segmentEndDate: string
  chargedDays: number
  amountMinor: number
}