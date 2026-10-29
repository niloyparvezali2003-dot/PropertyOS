import { z } from 'zod'

export const tenantStatusSchema = z.enum([
  'active',
  'archived',
])

export const tenantFormSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Tenant name must be at least 2 characters.')
      .max(100, 'Tenant name cannot exceed 100 characters.'),

    phone: z
      .string()
      .trim()
      .min(7, 'Enter a valid phone number.')
      .max(20, 'Phone number cannot exceed 20 characters.')
      .regex(
        /^[+0-9() -]+$/,
        'Phone number contains unsupported characters.',
      )
      .refine(
        (value) => value.replace(/\D/g, '').length >= 7,
        'Phone number must contain at least 7 digits.',
      ),

    email: z
      .string()
      .trim()
      .max(254, 'Email cannot exceed 254 characters.')
      .refine(
        (value) =>
          value === '' ||
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        'Enter a valid email address.',
      ),

    address: z
      .string()
      .trim()
      .max(240, 'Address cannot exceed 240 characters.'),

    notes: z
      .string()
      .trim()
      .max(1000, 'Notes cannot exceed 1,000 characters.'),

    status: tenantStatusSchema,
  })
  .strict()

export type TenantStatus = z.infer<typeof tenantStatusSchema>

export type TenantFormValues = z.infer<typeof tenantFormSchema>