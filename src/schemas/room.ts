import { z } from 'zod'

export const roomStatusSchema = z.enum([
  'vacant',
  'maintenance',
  'inactive',
])

export const roomFormSchema = z
  .object({
    propertyId: z
      .string()
      .trim()
      .min(1, 'Select a property.'),

    floorName: z
      .string()
      .trim()
      .min(1, 'Floor or level is required.')
      .max(80, 'Floor or level cannot exceed 80 characters.'),

    roomNumber: z
      .string()
      .trim()
      .min(1, 'Room number is required.')
      .max(30, 'Room number cannot exceed 30 characters.'),

    notes: z
      .string()
      .trim()
      .max(1000, 'Notes cannot exceed 1,000 characters.'),

    status: roomStatusSchema,
  })
  .strict()

export type RoomStatus = z.infer<typeof roomStatusSchema>

export type RoomFormValues = z.infer<typeof roomFormSchema>