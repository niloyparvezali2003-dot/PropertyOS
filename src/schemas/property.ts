import { z } from 'zod'

export const propertyFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Property name must be at least 2 characters.')
      .max(100, 'Property name cannot exceed 100 characters.'),

    address: z
      .string()
      .trim()
      .max(240, 'Address cannot exceed 240 characters.'),

    notes: z
      .string()
      .trim()
      .max(1000, 'Notes cannot exceed 1,000 characters.'),
  })
  .strict()

export type PropertyFormValues = z.infer<
  typeof propertyFormSchema
>