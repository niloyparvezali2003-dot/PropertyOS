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

const isoDateSchema = z.string().refine(isValidIsoDate, 'Enter a valid payment date.')
const billingMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter a valid billing month.')

export const paymentMethodSchema = z.enum([
  'cash',
  'bank_transfer',
  'mobile_banking',
  'cheque',
  'other',
])

export const paymentBillTypeSchema = z.enum(['rent', 'electricity'])

const positiveMinorAmountSchema = z
  .number()
  .int('Amount must be a whole number of poisha.')
  .positive('Amount must be greater than zero.')
  .max(10_000_000_000_000, 'Amount exceeds the permitted limit.')

export const paymentAllocationSchema = z
  .object({
    billType: paymentBillTypeSchema,
    billId: z.string().trim().min(1).max(500),
    billingMonth: billingMonthSchema,
    referenceDate: isoDateSchema,
    amountMinor: positiveMinorAmountSchema,
    billAmountMinor: positiveMinorAmountSchema,
    tenantAssignmentId: z.string().trim().min(1).max(500),
    tenantId: z.string().trim().min(1).max(500),
    tenantCode: z.string().regex(/^T[0-9]{5}[A-Z]$/),
    tenantName: z.string().trim().min(2).max(100),
    roomId: z.string().trim().min(1).max(500),
    roomCode: z.string().regex(/^R[0-9]{4}$/),
    roomNumber: z.string().trim().min(1).max(30),
    floorName: z.string().trim().min(1).max(80),
    propertyId: z.string().trim().min(1).max(500),
    propertyCode: z.string().regex(/^P[0-9]{2}$/),
  })
  .strict()
  .superRefine((allocation, context) => {
    if (allocation.amountMinor > allocation.billAmountMinor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountMinor'],
        message: 'Payment allocation cannot exceed the original bill amount.',
      })
    }
  })

export const paymentFormSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(500),
    tenantCode: z.string().regex(/^T[0-9]{5}[A-Z]$/),
    tenantName: z.string().trim().min(2).max(100),
    paidOn: isoDateSchema,
    method: paymentMethodSchema,
    reference: z.string().trim().max(120, 'Reference cannot exceed 120 characters.'),
    notes: z.string().trim().max(1000, 'Notes cannot exceed 1,000 characters.'),
    amountReceivedMinor: positiveMinorAmountSchema,
    allocations: z.array(paymentAllocationSchema).max(20, 'A single receipt can allocate to at most 20 bills.'),
  })
  .strict()
  .superRefine((input, context) => {
    const seenBills = new Set<string>()
    let allocatedTotal = 0

    input.allocations.forEach((allocation, index) => {
      const key = `${allocation.billType}__${allocation.billId}`
      if (seenBills.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocations', index, 'billId'],
          message: 'A bill can only appear once in a receipt.',
        })
      }
      seenBills.add(key)

      if (allocation.tenantId !== input.tenantId || allocation.tenantCode !== input.tenantCode) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocations', index, 'tenantId'],
          message: 'One receipt can only be allocated to bills belonging to the selected tenant.',
        })
      }

      allocatedTotal += allocation.amountMinor
      if (!Number.isSafeInteger(allocatedTotal)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocations'],
          message: 'The allocation total exceeds the safe calculation limit.',
        })
      }
    })

    if (allocatedTotal > input.amountReceivedMinor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountReceivedMinor'],
        message: 'Amount received cannot be less than the total allocated to bills.',
      })
    }
  })

export type PaymentMethod = z.infer<typeof paymentMethodSchema>
export type PaymentBillType = z.infer<typeof paymentBillTypeSchema>
export type PaymentAllocationFormValues = z.infer<typeof paymentAllocationSchema>
export type PaymentFormValues = z.infer<typeof paymentFormSchema>
