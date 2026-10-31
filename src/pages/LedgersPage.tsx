import { invalidateOwnerDataCache } from '../services/firebase/listCache'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  AlertCircle,
  BookOpen,
  Building2,
  CalendarDays,
  Download,
  Gauge,
  LoaderCircle,
  RefreshCw,
  Search,
  Users,
  Wallet,
  Zap,
} from 'lucide-react'

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

import type { Timestamp } from 'firebase/firestore'

import {
  loadLedgerSourceData,
  type LedgerSourceData,
} from '../services/firebase/ledgers'
import {
  DEFAULT_WORKSPACE_SETTINGS,
  loadWorkspaceSettings,
  type WorkspaceSettings,
} from '../services/firebase/workspaceSettings'

import {
  resolveElectricityBillTenantAssignment,
  type ElectricityBillRecord,
} from '../services/firebase/electricity'
import type { MeterAssignmentRecord, MeterRecord } from '../services/firebase/meters'
import type { PaymentAllocationFormValues } from '../schemas/payment'

import type {
  PaymentRecord,
} from '../services/firebase/payments'

import type { RentBillRecord } from '../services/firebase/rentBills'
import type { RoomRecord } from '../services/firebase/rooms'
import type { TenantRecord } from '../services/firebase/tenants'
import type { TenantAssignmentRecord } from '../services/firebase/tenantAssignments'

import './ledgers.css'

type LedgerScope = 'tenant' | 'room' | 'meter'

type LedgerEntity = {
  id: string
  title: string
  subtitle: string
  optionLabel?: string
}

type LedgerEntry = {
  id: string
  date: string
  time: string
  sortTimestamp: number
  type: string
  reference: string
  description: string
  contextLabel: string
  debitMinor: number
  creditMinor: number
  balanceMinor: number
  searchableText: string
}

type LedgerPageProps = {
  ownerUid: string
}

// Refreshed from the signed-in account immediately before each PDF is generated.
let activeStatementSettings: WorkspaceSettings = { ...DEFAULT_WORKSPACE_SETTINGS }

// T&N House's statement palette. These are deliberately kept local to PDF
// generation so the exported document remains branded even when browser CSS
// or the user's display theme changes.
const STATEMENT_COLORS = {
  navy: [16, 44, 80] as [number, number, number],
  gold: [213, 165, 46] as [number, number, number],
  ivory: [246, 243, 235] as [number, number, number],
  ink: [38, 54, 74] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  border: [232, 225, 213] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
}

const BENGALI_TEXT_PATTERN = /[\u0980-\u09FF]/
const BENGALI_FONT_FAMILY = 'Noto Serif Bengali'
const PDF_IMAGE_SCALE = 3
let statementBengaliFontPromise: Promise<void> | null = null
let statementBengaliFontLoaded = false

type PdfRgb = [number, number, number]
type BengaliTextImage = {
  dataUrl: string
  widthPt: number
  heightPt: number
  baselineOffsetPt: number
}
type StatementTextOptions = {
  fontSize: number
  color: PdfRgb
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  maxWidth?: number
}
type StatementTableCell = {
  raw: unknown
  text: string[]
  x: number
  y: number
  width: number
  height: number
  styles: {
    fontSize: number
    fontStyle: string
    textColor: unknown
    fillColor: unknown
    valign: 'top' | 'middle' | 'bottom'
    halign: 'left' | 'center' | 'right' | 'justify'
    lineWidth: unknown
  }
  padding: (side: 'left' | 'right' | 'top' | 'bottom') => number
}

async function ensureStatementBengaliFont(): Promise<void> {
  if (statementBengaliFontLoaded) return

  if (!statementBengaliFontPromise) {
    statementBengaliFontPromise = Promise.all([
      document.fonts.load(`400 12px "${BENGALI_FONT_FAMILY}"`, 'বাংলা পরীক্ষা'),
      document.fonts.load(`700 12px "${BENGALI_FONT_FAMILY}"`, 'বাংলা পরীক্ষা'),
    ]).then(async ([regularFaces, boldFaces]) => {
      await document.fonts.ready
      if (regularFaces.length === 0 || boldFaces.length === 0) {
        throw new Error('The Bengali font is unavailable. Please refresh the page and try the PDF download again.')
      }
      statementBengaliFontLoaded = true
    }).catch((error: unknown) => {
      statementBengaliFontPromise = null
      throw error
    })
  }

  await statementBengaliFontPromise
}

function colorAsCss(color: PdfRgb): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`
}

function normalizePdfColor(value: unknown, fallback: PdfRgb): PdfRgb {
  if (Array.isArray(value) && value.length >= 3) {
    return [
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
    ]
  }

  if (typeof value === 'number') {
    return [value, value, value]
  }

  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ]
    }
  }

  return fallback
}

function renderBengaliTextImage(
  text: string,
  options: {
    fontSizePt: number
    color: PdfRgb
    bold?: boolean
    maxWidthPt?: number
    maxHeightPt?: number
  },
): BengaliTextImage {
  if (!statementBengaliFontLoaded) {
    throw new Error('The Bengali font could not be loaded. Check your internet connection and try the PDF download again.')
  }

  const pointToCanvasPixel = (96 / 72) * PDF_IMAGE_SCALE
  const maxWidthPx = options.maxWidthPt === undefined
    ? Number.POSITIVE_INFINITY
    : options.maxWidthPt * pointToCanvasPixel
  const maxHeightPx = options.maxHeightPt === undefined
    ? Number.POSITIVE_INFINITY
    : options.maxHeightPt * pointToCanvasPixel

  let fontSizePt = options.fontSizePt
  let result: {
    canvas: HTMLCanvasElement
    baselinePx: number
  } | null = null

  // Shrink only when the existing PDF cell cannot contain the shaped text.
  // The normal case uses the exact point size already configured by the PDF.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fontSizePx = fontSizePt * pointToCanvasPixel
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('The browser could not prepare Bengali text for the PDF.')
    }

    context.font = `${options.bold ? '700' : '400'} ${fontSizePx}px "${BENGALI_FONT_FAMILY}"`
    context.textBaseline = 'alphabetic'

    const lines: string[] = []
    const paragraphs = text.replace(/\r/g, '').split('\n')
    for (const paragraph of paragraphs) {
      if (!paragraph) {
        lines.push('')
        continue
      }

      const words = paragraph.split(/\s+/).filter(Boolean)
      let currentLine = ''
      for (const word of words) {
        const candidate = currentLine ? `${currentLine} ${word}` : word
        if (currentLine && context.measureText(candidate).width > maxWidthPx) {
          lines.push(currentLine)
          currentLine = word
        } else {
          currentLine = candidate
        }
      }
      lines.push(currentLine)
    }

    const metrics = context.measureText(lines.find(Boolean) ?? 'বাংলা')
    const ascent = metrics.actualBoundingBoxAscent || fontSizePx * 0.84
    const descent = metrics.actualBoundingBoxDescent || fontSizePx * 0.26
    const paddingX = fontSizePx * 0.12
    const paddingY = fontSizePx * 0.1
    const lineHeight = fontSizePx * 1.28
    const lineWidths = lines.map((line) => context.measureText(line).width)
    const contentWidth = Math.max(1, ...lineWidths)
    const baselinePx = paddingY + ascent
    const contentHeight = paddingY * 2 + ascent + descent + Math.max(0, lines.length - 1) * lineHeight

    canvas.width = Math.ceil(contentWidth + paddingX * 2)
    canvas.height = Math.ceil(contentHeight)
    const drawContext = canvas.getContext('2d')
    if (!drawContext) {
      throw new Error('The browser could not prepare Bengali text for the PDF.')
    }

    drawContext.font = `${options.bold ? '700' : '400'} ${fontSizePx}px "${BENGALI_FONT_FAMILY}"`
    drawContext.textBaseline = 'alphabetic'
    drawContext.fillStyle = colorAsCss(options.color)
    lines.forEach((line, index) => {
      drawContext.fillText(line, paddingX, baselinePx + index * lineHeight)
    })

    result = { canvas, baselinePx }
    const widthFits = canvas.width <= maxWidthPx
    const heightFits = canvas.height <= maxHeightPx
    if (widthFits && heightFits) break

    const widthRatio = Number.isFinite(maxWidthPx) ? maxWidthPx / canvas.width : 1
    const heightRatio = Number.isFinite(maxHeightPx) ? maxHeightPx / canvas.height : 1
    const shrinkRatio = Math.min(widthRatio, heightRatio, 0.92)
    if (!Number.isFinite(shrinkRatio) || shrinkRatio <= 0 || fontSizePt * shrinkRatio < 3.5) {
      break
    }
    fontSizePt *= shrinkRatio
  }

  if (!result) {
    throw new Error('The browser could not render Bengali text for the PDF.')
  }

  const pixelsPerPoint = pointToCanvasPixel
  return {
    dataUrl: result.canvas.toDataURL('image/png'),
    widthPt: result.canvas.width / pixelsPerPoint,
    heightPt: result.canvas.height / pixelsPerPoint,
    baselineOffsetPt: result.baselinePx / pixelsPerPoint,
  }
}

function drawStatementText(
  pdf: jsPDF,
  text: string,
  x: number,
  baselineY: number,
  options: StatementTextOptions,
): void {
  if (!BENGALI_TEXT_PATTERN.test(text)) {
    pdf.text(text, x, baselineY, {
      ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
      ...(options.align ? { align: options.align } : {}),
    })
    return
  }

  const image = renderBengaliTextImage(text, {
    fontSizePt: options.fontSize,
    color: options.color,
    bold: options.bold,
    maxWidthPt: options.maxWidth,
  })
  const drawX = options.align === 'right'
    ? x - image.widthPt
    : options.align === 'center'
      ? x - image.widthPt / 2
      : x

  pdf.addImage(
    image.dataUrl,
    'PNG',
    drawX,
    baselineY - image.baselineOffsetPt,
    image.widthPt,
    image.heightPt,
  )
}

function getStatementCellText(cell: StatementTableCell): string {
  if (typeof cell.raw === 'string' || typeof cell.raw === 'number') {
    return String(cell.raw)
  }
  if (Array.isArray(cell.raw)) {
    return cell.raw.map((value) => String(value ?? '')).join('\n')
  }
  if (cell.raw && typeof cell.raw === 'object' && 'content' in cell.raw) {
    const content = (cell.raw as { content?: unknown }).content
    if (Array.isArray(content)) return content.map((value) => String(value ?? '')).join('\n')
    if (typeof content === 'string' || typeof content === 'number') return String(content)
  }
  return cell.text.join('\n')
}

function drawBengaliTableCell(pdf: jsPDF, cell: StatementTableCell): void {
  const text = getStatementCellText(cell)
  if (!BENGALI_TEXT_PATTERN.test(text)) return

  const paddingLeft = cell.padding('left')
  const paddingRight = cell.padding('right')
  const paddingTop = cell.padding('top')
  const paddingBottom = cell.padding('bottom')
  const availableWidth = Math.max(1, cell.width - paddingLeft - paddingRight)
  const availableHeight = Math.max(1, cell.height - paddingTop - paddingBottom)
  const lineInset = Math.max(0.5, Number(cell.styles.lineWidth) || 0.35)
  const background = normalizePdfColor(cell.styles.fillColor, STATEMENT_COLORS.white)
  const textColor = normalizePdfColor(cell.styles.textColor, STATEMENT_COLORS.ink)

  // Mask only the old, incorrectly shaped glyphs; keep the original cell
  // dimensions, fill, grid, and table pagination unchanged.
  pdf.setFillColor(...background)
  pdf.rect(
    cell.x + lineInset,
    cell.y + lineInset,
    Math.max(0, cell.width - lineInset * 2),
    Math.max(0, cell.height - lineInset * 2),
    'F',
  )

  const image = renderBengaliTextImage(text, {
    fontSizePt: cell.styles.fontSize,
    color: textColor,
    bold: cell.styles.fontStyle === 'bold' || cell.styles.fontStyle === 'bolditalic',
    maxWidthPt: availableWidth,
    maxHeightPt: availableHeight,
  })
  const drawX = cell.styles.halign === 'right'
    ? cell.x + cell.width - paddingRight - image.widthPt
    : cell.styles.halign === 'center'
      ? cell.x + paddingLeft + (availableWidth - image.widthPt) / 2
      : cell.x + paddingLeft
  const drawY = cell.styles.valign === 'top'
    ? cell.y + paddingTop
    : cell.styles.valign === 'bottom'
      ? cell.y + cell.height - paddingBottom - image.heightPt
      : cell.y + paddingTop + (availableHeight - image.heightPt) / 2

  pdf.addImage(image.dataUrl, 'PNG', drawX, drawY, image.widthPt, image.heightPt)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function toLocalIsoDate(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-')
}

function getDateFromTimestamp(
  value: Timestamp | null,
): string | null {
  return value ? toLocalIsoDate(value.toDate()) : null
}

function getTimeFromTimestamp(
  value: Timestamp | null,
): string {
  if (!value) return '—'

  return new Intl.DateTimeFormat('en-BD', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(value.toDate())
}

function getSortTimestamp(
  value: Timestamp | null,
): number {
  return value ? value.toMillis() : 0
}

function formatMoney(minor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100)}`
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-BD', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function formatMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00`)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-BD', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function buildEntities(
  data: LedgerSourceData,
  scope: LedgerScope,
): LedgerEntity[] {
  if (scope === 'tenant') {
    return data.tenants
      .map((tenant: TenantRecord) => ({
        id: tenant.id,
        title: tenant.fullName,
        subtitle: `${tenant.tenantCode} · ${tenant.phone}`,
        optionLabel: `${tenant.fullName} · ${tenant.phone}`,
      }))
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  if (scope === 'room') {
    return data.rooms
      .map((room: RoomRecord) => {
        const currentAssignments = data.tenantAssignments.filter(
          (assignment) =>
            assignment.roomId === room.id &&
            assignment.status === 'current' &&
            assignment.moveOutDate === null,
        )
        const currentTenant = currentAssignments.length === 1
          ? currentAssignments[0].tenantName
          : currentAssignments.length > 1
            ? 'Multiple tenants — review assignments'
            : 'No current tenant / vacant'
        const currentTenantLabel = currentAssignments.length === 1
          ? `Current tenant: ${currentAssignments[0].tenantName}`
          : currentAssignments.length > 1
            ? 'Current tenant: Multiple assignments — review'
            : 'Current tenant: None / vacant'

        return {
          id: room.id,
          title: `Room ${room.roomNumber}`,
          subtitle: [
            room.roomCode,
            room.floorName,
            room.propertyCode,
            currentTenantLabel,
          ].filter(Boolean).join(' · '),
          optionLabel: `${currentTenant} · Room ${room.roomNumber} · Floor/Level: ${room.floorName}`,
        }
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  return data.meters
    .map((meter: MeterRecord) => {
      const currentMeterAssignments = data.meterAssignments.filter(
        (assignment) =>
          assignment.meterId === meter.id &&
          assignment.status === 'current' &&
          assignment.endedOn === null,
      )
      const currentMeterAssignment = currentMeterAssignments.length === 1
        ? currentMeterAssignments[0]
        : null
      const currentRoom = currentMeterAssignment
        ? data.rooms.find((room) => room.id === currentMeterAssignment.roomId)
        : undefined
      const currentTenantAssignments = currentMeterAssignment
        ? data.tenantAssignments.filter(
            (assignment) =>
              assignment.roomId === currentMeterAssignment.roomId &&
              assignment.status === 'current' &&
              assignment.moveOutDate === null,
          )
        : []
      const currentTenantLabel = currentTenantAssignments.length === 1
        ? `Current tenant: ${currentTenantAssignments[0].tenantName}`
        : currentTenantAssignments.length > 1
          ? 'Current tenant: Multiple assignments — review'
          : currentMeterAssignment
            ? 'Current tenant: None / vacant'
            : currentMeterAssignments.length > 1
              ? 'Current room: Multiple assignments — review'
              : 'Not currently assigned'
      const meterOptionTenant = currentTenantAssignments.length === 1
        ? currentTenantAssignments[0].tenantName
        : currentTenantAssignments.length > 1
          ? 'Multiple tenants — review assignments'
          : currentMeterAssignment
            ? 'No current tenant / vacant'
            : currentMeterAssignments.length > 1
              ? 'Multiple room assignments — review'
              : 'Unassigned meter'
      const meterOptionRoom = currentMeterAssignment
        ? `Room ${currentRoom?.roomNumber ?? currentMeterAssignment.roomCode}`
        : currentMeterAssignments.length > 1
          ? 'Multiple rooms — review'
          : 'No room assigned'
      const meterOptionFloor = currentRoom?.floorName
        ? `Floor/Level: ${currentRoom.floorName}`
        : null

      return {
        id: meter.id,
        title: meter.meterCode,
        subtitle: [
          meter.serialNumber ? `Serial: ${meter.serialNumber}` : `Status: ${meter.status}`,
          currentMeterAssignment
            ? `Room ${currentRoom?.roomNumber ?? currentMeterAssignment.roomCode}`
            : null,
          currentMeterAssignment ? `Property ${currentMeterAssignment.propertyCode}` : null,
          currentTenantLabel,
        ].filter(Boolean).join(' · '),
        optionLabel: [meterOptionTenant, meterOptionRoom, meterOptionFloor]
          .filter(Boolean).join(' · '),
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title))
}

function findTenantAssignmentForElectricityBill(
  data: LedgerSourceData,
  bill: ElectricityBillRecord,
): TenantAssignmentRecord | null {
  // Keep compatibility with historic room snapshots while preferring the
  // immutable tenant-at-issue snapshot saved on newer electricity bills.
  const meterAssignment = data.meterAssignments.find(
    (assignment) =>
      assignment.id === bill.meterAssignmentId &&
      assignment.meterId === bill.meterId,
  )
  return resolveElectricityBillTenantAssignment(
    meterAssignment && meterAssignment.roomId !== bill.roomId
      ? { ...bill, roomId: meterAssignment.roomId }
      : bill,
    data.tenantAssignments,
  )
}

function tenantLabelForMeterAssignment(
  data: LedgerSourceData,
  meterAssignment: MeterAssignmentRecord,
): string {
  const currentRoomTenants = data.tenantAssignments.filter(
    (assignment) =>
      assignment.roomId === meterAssignment.roomId &&
      assignment.status === 'current' &&
      assignment.moveOutDate === null,
  )

  // For a currently connected meter, the room's current tenant is the person
  // responsible for new electricity bills, even when older meter/tenant dates
  // do not overlap cleanly in legacy records.
  if (meterAssignment.status === 'current' && meterAssignment.endedOn === null) {
    if (currentRoomTenants.length === 1) return currentRoomTenants[0].tenantName
    if (currentRoomTenants.length > 1) return 'Multiple assignments — review'
  }

  const historicalTenants = [...new Set(data.tenantAssignments
    .filter((assignment) =>
      assignment.roomId === meterAssignment.roomId &&
      assignment.moveInDate <= (meterAssignment.endedOn ?? '9999-12-31') &&
      (assignment.moveOutDate === null || assignment.moveOutDate >= meterAssignment.assignedOn),
    )
    .map((assignment) => assignment.tenantName))]

  return historicalTenants.join(', ') || 'Unassigned'
}

function electricityBillTenantLabel(
  data: LedgerSourceData,
  bill: ElectricityBillRecord,
): string {
  if (bill.tenantName?.trim()) return bill.tenantName.trim()

  const tenantAssignment = findTenantAssignmentForElectricityBill(data, bill)
  if (tenantAssignment) return tenantAssignment.tenantName

  const meterAssignment = data.meterAssignments.find(
    (assignment) => assignment.id === bill.meterAssignmentId && assignment.meterId === bill.meterId,
  )
  const roomId = meterAssignment?.roomId ?? bill.roomId
  const candidates = data.tenantAssignments.filter(
    (assignment) => assignment.roomId === roomId && assignment.status === 'current' && assignment.moveOutDate === null,
  )
  return candidates.length > 1 ? 'Multiple assignments — review' : 'Unassigned'
}

function roomLabel(data: LedgerSourceData, roomId: string, fallbackCode: string): string {
  const room = data.rooms.find((item) => item.id === roomId)
  return room ? `Room ${room.roomNumber}` : `Room ${fallbackCode}`
}

function tenantPaymentRoomLabel(payment: PaymentRecord): string {
  const roomNumbers = [...new Set(
    payment.allocations
      .filter((allocation) => allocation.roomNumber)
      .map((allocation) => allocation.roomNumber),
  )]
  if (roomNumbers.length === 1) return `Room ${roomNumbers[0]}`
  if (roomNumbers.length > 1) return `Rooms ${roomNumbers.join(', ')}`
  return 'Unallocated / advance'
}

function safeMinor(value: number): number {
  return Number.isSafeInteger(value) && value > 0
    ? value
    : 0
}

function billDate(bill: RentBillRecord): string {
  return (
    getDateFromTimestamp(bill.createdAt) ??
    `${bill.billingMonth}-01`
  )
}

function electricityDate(
  bill: ElectricityBillRecord,
): string {
  return (
    bill.readingDate ||
    getDateFromTimestamp(bill.createdAt) ||
    `${bill.billingMonth}-01`
  )
}

function paymentTime(payment: PaymentRecord): string {
  return getTimeFromTimestamp(payment.createdAt)
}

function paymentSortTimestamp(
  payment: PaymentRecord,
): number {
  return getSortTimestamp(payment.createdAt)
}

function entrySearchText(
  entry: Omit<
    LedgerEntry,
    'searchableText' | 'balanceMinor'
  >,
): string {
  return [
    entry.type,
    entry.reference,
    entry.description,
    entry.contextLabel,
    entry.date,
  ].join(' ').toLocaleLowerCase()
}

// Readable references are derived deterministically from immutable Firestore IDs.
// Collision checks make each ten-character code unique within the loaded record set.
// These aliases are display-only: existing document IDs and saved financial data never change.
type HumanReferenceKind = 'rent' | 'electricity' | 'payment' | 'advance' | 'meter'

type HumanReferenceRegistry = {
  rentByAssignmentId: Map<string, string>
  electricityByMeterAssignmentId: Map<string, string>
  paymentById: Map<string, string>
  advanceById: Map<string, string>
  meterEventByAssignmentId: Map<string, string>
}

function stableReferenceToken(source: string, salt: number): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const input = `${source}::${salt}`
  let hashA = 2166136261 >>> 0
  let hashB = 0x9e3779b9 >>> 0

  for (let index = 0; index < input.length; index += 1) {
    const character = input.charCodeAt(index)
    hashA = Math.imul(hashA ^ character, 16777619) >>> 0
    hashB = Math.imul(hashB ^ (character + index), 2246822519) >>> 0
    hashB ^= hashB >>> 13
    hashB >>>= 0
  }

  // Encode the combined 64-bit hash into ten base-36 characters without BigInt,
  // so this also works with conservative TypeScript targets.
  let high = hashA
  let low = hashB
  let token = ''
  for (let index = 0; index < 10; index += 1) {
    const highRemainder = high % 36
    const nextHigh = Math.floor(high / 36)
    const combined = highRemainder * 4294967296 + low
    const nextLow = Math.floor(combined / 36)
    const remainder = combined % 36
    token = alphabet[remainder] + token
    high = nextHigh
    low = nextLow
  }

  return token
}

function createUniqueReferenceCodes(sourceIds: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const used = new Set<string>()
  const uniqueIds = [...new Set(sourceIds.filter(Boolean))].sort()

  for (const sourceId of uniqueIds) {
    let salt = 0
    let token = stableReferenceToken(sourceId, salt)
    while (used.has(token)) {
      salt += 1
      token = stableReferenceToken(sourceId, salt)
    }
    used.add(token)
    result.set(sourceId, token)
  }

  return result
}

function createTransactionReferenceRegistry(
  data: LedgerSourceData,
): HumanReferenceRegistry {
  return {
    rentByAssignmentId: createUniqueReferenceCodes(
      data.rentBills.map((bill) => bill.assignmentId),
    ),
    electricityByMeterAssignmentId: createUniqueReferenceCodes(
      data.electricityBills.map((bill) => bill.meterAssignmentId),
    ),
    paymentById: createUniqueReferenceCodes(
      data.payments.map((payment) => payment.id),
    ),
    advanceById: createUniqueReferenceCodes(
      data.creditApplications.map((application) => application.id),
    ),
    meterEventByAssignmentId: createUniqueReferenceCodes(
      data.meterAssignments.map((assignment) => assignment.id),
    ),
  }
}

function formatHumanReference(
  registry: HumanReferenceRegistry,
  kind: HumanReferenceKind,
  sourceId: string,
  billingMonth?: string,
): string {
  const monthCode = (billingMonth ?? '').replace(/\D/g, '').slice(0, 6)
  const fallbackCode = stableReferenceToken(sourceId, 0)

  switch (kind) {
    case 'rent': {
      const code = registry.rentByAssignmentId.get(sourceId) ?? fallbackCode
      return `RB-${code}-${monthCode || '000000'}`
    }
    case 'electricity': {
      const code = registry.electricityByMeterAssignmentId.get(sourceId) ?? fallbackCode
      // Each dated meter reading is a separate immutable bill, including when
      // multiple readings are recorded in the same billing month.
      const readingDateCode = (billingMonth ?? '').replace(/\D/g, '').slice(0, 8)
      return `EB-${code}-${readingDateCode || monthCode || '00000000'}`
    }
    case 'payment':
      return `P-${registry.paymentById.get(sourceId) ?? fallbackCode}`
    case 'advance':
      return `CA-${registry.advanceById.get(sourceId) ?? fallbackCode}`
    case 'meter':
      return `M-${registry.meterEventByAssignmentId.get(sourceId) ?? fallbackCode}`
  }
}
function buildEntries(
  data: LedgerSourceData,
  scope: LedgerScope,
  entityId: string,
): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  const references = createTransactionReferenceRegistry(data)

  const electricityById = new Map<string, ElectricityBillRecord>(
    data.electricityBills.map((bill) => [bill.id, bill] as const),
  )

  const add = (
    entry: Omit<LedgerEntry, 'balanceMinor' | 'searchableText'>,
  ) => {
    const debitMinor = safeMinor(entry.debitMinor)
    const creditMinor = safeMinor(entry.creditMinor)
    if (debitMinor === 0 && creditMinor === 0) return

    const normalized = { ...entry, debitMinor, creditMinor }
    entries.push({
      ...normalized,
      balanceMinor: 0,
      searchableText: entrySearchText(normalized),
    })
  }

  // TENANT: include both rent and electricity charges.
  // ROOM: include rent charges only.
  // An opening balance belongs to the tenant across their historical rooms.
  if (scope === 'tenant') {
    const openingBalance = data.openingBalances.find((item) => item.tenantId === entityId)
    if (openingBalance) {
      add({
        id: `opening-balance:${openingBalance.id}`,
        date: openingBalance.effectiveDate,
        // The opening balance already stores its creation timestamp. Use it
        // for the displayed time and exact ordering while retaining the chosen
        // effective date as the transaction date.
        time: getTimeFromTimestamp(openingBalance.createdAt),
        sortTimestamp: getSortTimestamp(openingBalance.createdAt),
        type: 'Opening balance',
        reference: `OB-${openingBalance.tenantCode}`,
        description: openingBalance.note || 'Previous outstanding before PropertyOS',
        contextLabel: 'Tenant-level previous due',
        debitMinor: openingBalance.originalAmountMinor,
        creditMinor: 0,
      })
    }
    for (const adjustment of data.openingBalanceAdjustments) {
      if (adjustment.tenantId !== entityId) continue
      add({
        id: `opening-balance-adjustment:${adjustment.id}`,
        date: adjustment.effectiveDate,
        time: getTimeFromTimestamp(adjustment.createdAt),
        sortTimestamp: getSortTimestamp(adjustment.createdAt),
        type: adjustment.direction === 'increase' ? 'Opening balance increase' : 'Opening balance reduction',
        reference: adjustment.adjustmentNumber,
        description: adjustment.note,
        contextLabel: 'Opening balance adjustment',
        debitMinor: adjustment.direction === 'increase' ? adjustment.amountMinor : 0,
        creditMinor: adjustment.direction === 'decrease' ? adjustment.amountMinor : 0,
      })
    }
  }

  for (const bill of data.rentBills) {
    if (bill.status !== 'issued' || !safeMinor(bill.totalMinor)) continue
    const matches =
      (scope === 'tenant' && bill.tenantId === entityId) ||
      (scope === 'room' && bill.roomId === entityId)
    if (!matches) continue

    add({
      id: `rent:${bill.id}`,
      date: billDate(bill),
      time: getTimeFromTimestamp(bill.createdAt),
      sortTimestamp: getSortTimestamp(bill.createdAt),
      type: 'Rent bill',
      reference: formatHumanReference(references, 'rent', bill.assignmentId, bill.billingMonth),
      description: `${formatMonth(bill.billingMonth)} · ${bill.tenantName} · ${bill.roomCode}`,
      contextLabel: scope === 'tenant' ? `Room ${bill.roomNumber}` : bill.tenantName,
      debitMinor: bill.totalMinor,
      creditMinor: 0,
    })
  }

  // TENANT: include electricity bills for the tenant saved when the bill was issued.
  // METER: include only electricity charges for the selected meter.
  // ROOM: intentionally excludes electricity calculations.
  for (const bill of data.electricityBills) {
    if (bill.status !== 'issued' || !safeMinor(bill.amountMinor)) continue
    if (scope === 'room') continue

    const linkedTenantAssignment = findTenantAssignmentForElectricityBill(data, bill)
    const linkedTenantLabel = electricityBillTenantLabel(data, bill)
    const linkedTenantId = bill.tenantId ?? linkedTenantAssignment?.tenantId
    const matches =
      (scope === 'tenant' && linkedTenantId === entityId) ||
      (scope === 'meter' && bill.meterId === entityId)
    if (!matches) continue

    const roomText = roomLabel(data, bill.roomId, bill.roomCode)
    add({
      id: `electricity:${bill.id}`,
      date: electricityDate(bill),
      time: getTimeFromTimestamp(bill.createdAt),
      sortTimestamp: getSortTimestamp(bill.createdAt),
      type: 'Electricity bill',
      reference: formatHumanReference(references, 'electricity', bill.meterAssignmentId, bill.readingDate),
      description: `${formatMonth(bill.billingMonth)} · ${roomText} · ${bill.meterCode} · Property ${bill.propertyCode} · ${bill.unitsConsumed} units`,
      contextLabel: scope === 'tenant' ? roomText : linkedTenantLabel,
      debitMinor: bill.amountMinor,
      creditMinor: 0,
    })
  }

  // Tenant ledger: credit each receipt exactly once, including its unallocated
  // advance portion. Its room context comes from the actual allocations.
  // Room ledger: credit rent allocations only.
  // Meter ledger: credit electricity allocations for the selected meter only.
  for (const payment of data.payments) {
    if (payment.status !== 'posted') continue

    if (scope === 'tenant' && payment.tenantId === entityId) {
      add({
        id: `payment:${payment.id}`,
        date: payment.paidOn,
        time: paymentTime(payment),
        sortTimestamp: paymentSortTimestamp(payment),
        type: 'Payment received',
        reference: formatHumanReference(references, 'payment', payment.id),
        description: `${payment.method.replaceAll('_', ' ')}${payment.reference ? ` · ${payment.reference}` : ''}`,
        contextLabel: tenantPaymentRoomLabel(payment),
        debitMinor: 0,
        creditMinor: payment.amountMinor,
      })
      continue
    }

    if (scope === 'room') {
      for (const allocation of payment.allocations) {
        if (allocation.billType !== 'rent' || allocation.roomId !== entityId) continue
        add({
          id: `payment:${payment.id}:rent:${allocation.billId}`,
          date: payment.paidOn,
          time: paymentTime(payment),
          sortTimestamp: paymentSortTimestamp(payment),
          type: 'Payment allocated',
          reference: formatHumanReference(references, 'payment', payment.id),
          description: `Rent bill · ${allocation.billingMonth} · ${payment.method.replaceAll('_', ' ')}`,
          contextLabel: allocation.tenantName,
          debitMinor: 0,
          creditMinor: allocation.amountMinor,
        })
      }
    }

    if (scope === 'meter') {
      for (const allocation of payment.allocations) {
        if (allocation.billType !== 'electricity') continue
        const bill = electricityById.get(allocation.billId)
        if (!bill || bill.meterId !== entityId) continue

        add({
          id: `payment:${payment.id}:electricity:${allocation.billId}`,
          date: payment.paidOn,
          time: paymentTime(payment),
          sortTimestamp: paymentSortTimestamp(payment),
          type: 'Payment allocated',
          reference: formatHumanReference(references, 'payment', payment.id),
          description: `Electricity bill · ${roomLabel(data, bill.roomId, bill.roomCode)} · ${bill.billingMonth} · ${bill.meterCode}`,
          contextLabel: allocation.tenantName,
          debitMinor: 0,
          creditMinor: allocation.amountMinor,
        })
      }
    }
  }

  // Advance applications are already represented by the original receipt in
  // the tenant ledger. Show them only in their matching rent-room or meter view.
  if (scope !== 'tenant') {
    for (const application of data.creditApplications) {
      if (application.status !== 'posted') continue
      const allocation = application.allocation as PaymentAllocationFormValues

      if (scope === 'room' && allocation.billType === 'rent' && allocation.roomId === entityId) {
        add({
          id: `credit-application:${application.id}`,
          date: getDateFromTimestamp(application.createdAt) ?? allocation.referenceDate,
          time: getTimeFromTimestamp(application.createdAt),
          sortTimestamp: getSortTimestamp(application.createdAt),
          type: 'Advance applied',
          reference: formatHumanReference(references, 'advance', application.id),
          description: `Rent bill · ${allocation.billingMonth}`,
          contextLabel: application.tenantName,
          debitMinor: 0,
          creditMinor: application.amountMinor,
        })
      }

      if (scope === 'meter' && allocation.billType === 'electricity') {
        const bill = electricityById.get(allocation.billId)
        if (!bill || bill.meterId !== entityId) continue
        add({
          id: `credit-application:${application.id}`,
          date: getDateFromTimestamp(application.createdAt) ?? allocation.referenceDate,
          time: getTimeFromTimestamp(application.createdAt),
          sortTimestamp: getSortTimestamp(application.createdAt),
          type: 'Advance applied',
          reference: formatHumanReference(references, 'advance', application.id),
          description: `Electricity bill · ${roomLabel(data, bill.roomId, bill.roomCode)} · ${bill.billingMonth} · ${bill.meterCode}`,
          contextLabel: application.tenantName,
          debitMinor: 0,
          creditMinor: application.amountMinor,
        })
      }
    }
  }

  // Oldest transactions first, so every scope gets a cumulative balance for
  // its own financial category (tenant = rent + electricity, room = rent,
  // meter = electricity).
  entries.sort((a, b) => {
    const byDate = a.date.localeCompare(b.date)
    if (byDate !== 0) return byDate
    if (a.sortTimestamp !== b.sortTimestamp) return a.sortTimestamp - b.sortTimestamp
    const typeOrder = (a.debitMinor > 0 ? 0 : 1) - (b.debitMinor > 0 ? 0 : 1)
    if (typeOrder !== 0) return typeOrder
    return a.id.localeCompare(b.id)
  })

  let runningBalance = 0
  return entries.map((entry) => {
    runningBalance += entry.debitMinor - entry.creditMinor
    return { ...entry, balanceMinor: runningBalance }
  })
}

function isDateInside(
  value: string,
  start: string,
  end: string,
): boolean {
  if (start && value < start) return false
  if (end && value > end) return false

  return true
}

function scopeLabel(scope: LedgerScope): string {
  if (scope === 'tenant') return 'Tenant ledger'
  if (scope === 'room') return 'Room ledger'

  return 'Meter ledger'
}

function LedgerPageIcon({
  scope,
}: {
  scope: LedgerScope
}) {
  if (scope === 'tenant') {
    return <Users size={18} aria-hidden="true" />
  }

  if (scope === 'room') {
    return <Building2 size={18} aria-hidden="true" />
  }

  return <Gauge size={18} aria-hidden="true" />
}

type StatementTable = {
  head: string[][]
  body: string[][]
}

function statementMoney(amountMinor: number): string {
  return formatMoney(amountMinor)
    .replace(/\u09F3/g, 'BDT ')
    .replace(/\u00a0/g, ' ')
}

function statementBalance(amountMinor: number): string {
  return amountMinor < 0
    ? `-${statementMoney(Math.abs(amountMinor))}`
    : statementMoney(amountMinor)
}

async function loadStatementLogo(): Promise<string | null> {
  try {
    const response = await fetch(import.meta.env.BASE_URL + 'icon-512.png')
    if (!response.ok) return null

    const blob = await response.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(typeof reader.result === 'string' ? reader.result : null)
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    // The statement remains usable even if the optional logo cannot load.
    return null
  }
}
function drawStatementHeader(
  pdf: jsPDF,
  scope: LedgerScope,
  entity: LedgerEntity,
): void {
  const pageWidth = pdf.internal.pageSize.getWidth()
  const margin = 32

  // Consistent navy masthead on every continuation page.
  pdf.setFillColor(...STATEMENT_COLORS.navy)
  pdf.rect(0, 0, pageWidth, 70, 'F')

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(16)
  pdf.setTextColor(...STATEMENT_COLORS.white)
  pdf.text('ACCOUNT STATEMENT', margin, 27)

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(9)
  pdf.setTextColor(...STATEMENT_COLORS.white)
  drawStatementText(pdf, `${scopeLabel(scope)} - ${entity.title}`, margin, 43, {
    fontSize: 9,
    color: STATEMENT_COLORS.white,
    bold: true,
    maxWidth: pageWidth - margin * 2 - 180,
  })

  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(7.5)
  pdf.setTextColor(226, 232, 240)
  drawStatementText(pdf, entity.subtitle, margin, 55, {
    fontSize: 7.5,
    color: [226, 232, 240],
    maxWidth: pageWidth - margin * 2 - 180,
  })
  pdf.text(
    `Generated ${new Date().toLocaleString('en-GB')}`,
    pageWidth - margin,
    55,
    { align: 'right' },
  )

  pdf.setFillColor(...STATEMENT_COLORS.gold)
  pdf.rect(0, 68, pageWidth, 2, 'F')
}

function drawFirstPageBranding(
  pdf: jsPDF,
  scope: LedgerScope,
  entity: LedgerEntity,
  logoDataUrl: string | null,
): void {
  const pageWidth = pdf.internal.pageSize.getWidth()
  const margin = 32
  const logoSize = 52
  const brandTextX = margin + logoSize + 10

  // The branded first-page masthead matches continuation pages.
  pdf.setFillColor(...STATEMENT_COLORS.navy)
  pdf.rect(0, 0, pageWidth, 79, 'F')

  if (logoDataUrl) {
    try {
      pdf.addImage(logoDataUrl, 'PNG', margin, 13, logoSize, logoSize)
    } catch {
      // Keep the text branding even if the image format is unsupported.
    }
  }

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(16)
  pdf.setTextColor(...STATEMENT_COLORS.white)
  drawStatementText(pdf, activeStatementSettings.houseName || "T&N House's", brandTextX, 27, {
    fontSize: 16,
    color: STATEMENT_COLORS.white,
    bold: true,
  })

  pdf.setFontSize(8)
  pdf.setTextColor(243, 217, 143)
  pdf.text('ACCOUNT STATEMENT', brandTextX, 43)

  pdf.setFontSize(8.5)
  pdf.setTextColor(...STATEMENT_COLORS.white)
  drawStatementText(pdf, scopeLabel(scope) + ' - ' + entity.title, brandTextX, 55, {
    fontSize: 8.5,
    color: STATEMENT_COLORS.white,
    maxWidth: pageWidth - margin * 2 - 225,
  })

  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(7)
  pdf.setTextColor(226, 232, 240)
  drawStatementText(pdf, entity.subtitle, brandTextX, 67, {
    fontSize: 7,
    color: [226, 232, 240],
    maxWidth: pageWidth - margin * 2 - 225,
  })

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(7.5)
  pdf.setTextColor(243, 217, 143)
  drawStatementText(pdf, 'Contract Number: ' + activeStatementSettings.contractNumber, pageWidth - margin, 18, {
    fontSize: 7.5,
    color: [243, 217, 143],
    bold: true,
    align: 'right',
  })

  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(7.2)
  pdf.setTextColor(...STATEMENT_COLORS.white)
  drawStatementText(pdf, 'Bkash/Nagad/Rocket/Upay: ' + activeStatementSettings.paymentContact, pageWidth - margin, 30, {
    fontSize: 7.2,
    color: STATEMENT_COLORS.white,
    align: 'right',
  })

  pdf.setTextColor(226, 232, 240)
  pdf.text('Generated ' + new Date().toLocaleString('en-GB'), pageWidth - margin, 43, {
    align: 'right',
  })

  pdf.setFillColor(...STATEMENT_COLORS.gold)
  pdf.rect(0, 77, pageWidth, 2, 'F')
}

function readingRecordedOnDate(
  data: LedgerSourceData,
  roomId: string,
  date: string | null,
): string {
  if (!date) return '-'

  const savedBills = data.electricityBills.filter(
    (bill) => bill.roomId === roomId && bill.readingDate === date,
  )
  if (savedBills.length > 0) {
    return [...new Set(savedBills.map(
      (bill) => `${bill.meterCode}: ${bill.currentReading.toLocaleString('en-BD')}`,
    ))].join('; ')
  }

  const assignmentReadings: string[] = []
  for (const assignment of data.meterAssignments) {
    if (assignment.roomId !== roomId) continue

    if (assignment.assignedOn === date) {
      assignmentReadings.push(
        `${assignment.meterCode} initial: ${assignment.initialReading.toLocaleString('en-BD')}`,
      )
    }
    if (assignment.endedOn === date && assignment.finalReading !== null) {
      assignmentReadings.push(
        `${assignment.meterCode} final: ${assignment.finalReading.toLocaleString('en-BD')}`,
      )
    }
  }

  return assignmentReadings.length > 0
    ? [...new Set(assignmentReadings)].join('; ')
    : 'No reading recorded on this date'
}

function addStatementHistoryTable(
  pdf: jsPDF,
  scope: LedgerScope,
  entity: LedgerEntity,
  title: string,
  table: StatementTable,
): void {
  if (table.body.length === 0) return

  pdf.addPage()
  drawStatementHeader(pdf, scope, entity)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(10)
  pdf.setTextColor(...STATEMENT_COLORS.navy)
  drawStatementText(pdf, title, 32, 81, {
    fontSize: 10,
    color: STATEMENT_COLORS.navy,
    bold: true,
  })
  pdf.setDrawColor(...STATEMENT_COLORS.gold)
  pdf.setLineWidth(0.8)
  pdf.line(32, 86, pdf.internal.pageSize.getWidth() - 32, 86)

  autoTable(pdf, {
    head: table.head,
    body: table.body,
    startY: 94,
    margin: { top: 94, bottom: 38, left: 32, right: 32 },
    styles: {
      font: 'helvetica',
      fontSize: 7.5,
      cellPadding: 4,
      overflow: 'linebreak',
      valign: 'middle',
      textColor: STATEMENT_COLORS.ink,
      lineColor: STATEMENT_COLORS.border,
      lineWidth: 0.35,
    },
    headStyles: {
      fillColor: STATEMENT_COLORS.navy,
      textColor: STATEMENT_COLORS.white,
      fontStyle: 'bold',
    },
    alternateRowStyles: { fillColor: STATEMENT_COLORS.ivory },
    didDrawCell: (hookData) => {
      drawBengaliTableCell(pdf, hookData.cell)
      if (hookData.section === 'head' && hookData.row.index === 0) {
        const { x, y, width, height } = hookData.cell
        pdf.setDrawColor(...STATEMENT_COLORS.gold)
        pdf.setLineWidth(1.1)
        pdf.line(x, y + height, x + width, y + height)
      }
    },
    didDrawPage: (hookData) => {
      drawStatementHeader(pdf, scope, entity)
      if (hookData.pageNumber > 1) {
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10)
        pdf.setTextColor(...STATEMENT_COLORS.navy)
        drawStatementText(pdf, title, 32, 81, {
          fontSize: 10,
          color: STATEMENT_COLORS.navy,
          bold: true,
        })
        pdf.setDrawColor(...STATEMENT_COLORS.gold)
        pdf.setLineWidth(0.8)
        pdf.line(32, 86, pdf.internal.pageSize.getWidth() - 32, 86)
      }
    },
  })
}

async function downloadLedgerStatementPdf(
  ownerUid: string,
  scope: LedgerScope,
  entity: LedgerEntity,
  entries: LedgerEntry[],
  data: LedgerSourceData,
): Promise<void> {
  const references = createTransactionReferenceRegistry(data)
  activeStatementSettings = (await loadWorkspaceSettings(ownerUid)).settings
  const possibleBengaliContent = JSON.stringify([
    entity,
    entries,
    data,
    activeStatementSettings,
  ])
  if (BENGALI_TEXT_PATTERN.test(possibleBengaliContent)) {
    // Only fail the export if Bangla is actually included in the rendered
    // statement; unrelated records may also contain Bangla text.
    try {
      await ensureStatementBengaliFont()
    } catch {
      // drawStatementText / drawBengaliTableCell will show a clear error if
      // the selected statement itself needs the unavailable font.
    }
  }
  const logoDataUrl = await loadStatementLogo()
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 32

  const totals = entries.reduce(
    (sum, entry) => ({
      debits: sum.debits + entry.debitMinor,
      credits: sum.credits + entry.creditMinor,
    }),
    { debits: 0, credits: 0 },
  )
  const currentBalance = entries.length > 0
    ? entries[entries.length - 1].balanceMinor
    : 0

  drawFirstPageBranding(pdf, scope, entity, logoDataUrl)

  const summaryY = 87
  const summaryHeight = 37
  const gap = 10
  const cardWidth = (pageWidth - margin * 2 - gap * 2) / 3
  const summaryCards = [
    { label: 'TOTAL OUT / DEBITS', value: statementMoney(totals.debits) },
    { label: 'TOTAL IN / CREDITS', value: statementMoney(totals.credits) },
    { label: 'CURRENT BALANCE (NEGATIVE = CREDIT)', value: statementBalance(currentBalance) },
  ]

  summaryCards.forEach((card, index) => {
    const x = margin + index * (cardWidth + gap)
    pdf.setFillColor(...STATEMENT_COLORS.ivory)
    pdf.setDrawColor(...STATEMENT_COLORS.border)
    pdf.roundedRect(x, summaryY, cardWidth, summaryHeight, 4, 4, 'FD')
    pdf.setFillColor(...STATEMENT_COLORS.gold)
    pdf.rect(x + 1, summaryY + 5, 2.5, summaryHeight - 10, 'F')
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(7)
    pdf.setTextColor(...STATEMENT_COLORS.muted)
    pdf.text(card.label, x + 9, summaryY + 12)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(10)
    pdf.setTextColor(...STATEMENT_COLORS.navy)
    pdf.text(card.value, x + 9, summaryY + 28, {
      maxWidth: cardWidth - 18,
    })
  })

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(10)
  pdf.setTextColor(...STATEMENT_COLORS.navy)
  pdf.text('TRANSACTION HISTORY', margin, 141)
  pdf.setDrawColor(...STATEMENT_COLORS.gold)
  pdf.setLineWidth(0.8)
  pdf.line(margin, 145, pageWidth - margin, 145)

  const transactionRows = entries.length > 0
    ? entries.map((entry) => {
      const time = /\d/.test(entry.time) ? ` ${entry.time}` : ''
      const baseRow = [
        `${formatDate(entry.date)}${time}`,
        entry.type,
        entry.contextLabel,
        `${entry.reference}\n${entry.description}`,
      ]
      return [
        ...baseRow,
        entry.debitMinor ? statementMoney(entry.debitMinor) : '-',
        entry.creditMinor ? statementMoney(entry.creditMinor) : '-',
        statementBalance(entry.balanceMinor),
      ]
    })
    : [['-', '-', '-', 'No transactions recorded', '-', '-', '-']]

  autoTable(pdf, {
    head: [[
      'Date & Time',
      'Transaction Type',
      scope === 'tenant' ? 'Room' : 'Tenant',
      'Transaction Details / Reference',
      'Debit',
      'Credit',
      'Balance',
    ]],
    body: transactionRows,
    startY: 149,
    margin: { top: 94, bottom: 38, left: margin, right: margin },
    styles: {
      font: 'helvetica',
      fontSize: 7.4,
      cellPadding: 4.5,
      overflow: 'linebreak',
      valign: 'middle',
      textColor: STATEMENT_COLORS.ink,
      lineColor: STATEMENT_COLORS.border,
      lineWidth: 0.35,
    },
    headStyles: {
      fillColor: STATEMENT_COLORS.navy,
      textColor: STATEMENT_COLORS.white,
      fontStyle: 'bold',
    },
    alternateRowStyles: { fillColor: STATEMENT_COLORS.ivory },
    columnStyles: {
      0: { cellWidth: 78 },
      1: { cellWidth: 88 },
      2: { cellWidth: 92 },
      3: { cellWidth: 270 },
      4: { cellWidth: 78, halign: 'right' },
      5: { cellWidth: 78, halign: 'right' },
      6: { cellWidth: 94, halign: 'right' },
    },
    didDrawCell: (hookData) => {
      drawBengaliTableCell(pdf, hookData.cell)
      if (hookData.section === 'head' && hookData.row.index === 0) {
        const { x, y, width, height } = hookData.cell
        pdf.setDrawColor(...STATEMENT_COLORS.gold)
        pdf.setLineWidth(1.1)
        pdf.line(x, y + height, x + width, y + height)
      }
    },
    didDrawPage: (hookData) => {
      if (hookData.pageNumber === 1) {
        drawFirstPageBranding(pdf, scope, entity, logoDataUrl)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10)
        pdf.setTextColor(...STATEMENT_COLORS.navy)
        pdf.text('TRANSACTION HISTORY', margin, 141)
        pdf.setDrawColor(...STATEMENT_COLORS.gold)
        pdf.setLineWidth(0.8)
        pdf.line(margin, 145, pageWidth - margin, 145)
      } else {
        drawStatementHeader(pdf, scope, entity)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10)
        pdf.setTextColor(...STATEMENT_COLORS.navy)
        pdf.text('TRANSACTION HISTORY', margin, 81)
        pdf.setDrawColor(...STATEMENT_COLORS.gold)
        pdf.setLineWidth(0.8)
        pdf.line(margin, 86, pageWidth - margin, 86)
      }
    },
  })

  if (scope === 'tenant') {
    const tenantAssignments = data.tenantAssignments
      .filter((assignment) => assignment.tenantId === entity.id)
      .sort((a, b) => a.moveInDate.localeCompare(b.moveInDate))

    addStatementHistoryTable(pdf, scope, entity, 'TENANT OCCUPANCY HISTORY', {
      head: [[
        'Move-in', 'Move-out', 'Room', 'Floor / Property',
        'Meter reading at move-in', 'Meter reading at move-out', 'Status',
      ]],
      body: tenantAssignments.map((assignment) => [
        assignment.moveInDate || '-',
        assignment.moveOutDate || 'Current',
        `Room ${assignment.roomNumber} (${assignment.roomCode})`,
        `${assignment.floorName} / ${assignment.propertyCode}`,
        readingRecordedOnDate(data, assignment.roomId, assignment.moveInDate),
        assignment.moveOutDate
          ? readingRecordedOnDate(data, assignment.roomId, assignment.moveOutDate)
          : 'Not applicable - current assignment',
        assignment.status.replaceAll('_', ' '),
      ]),
    })
  }

  if (scope === 'room') {
    const roomAssignments = data.tenantAssignments
      .filter((assignment) => assignment.roomId === entity.id)
      .sort((a, b) => a.moveInDate.localeCompare(b.moveInDate))

    addStatementHistoryTable(pdf, scope, entity, 'TENANT HISTORY FOR THIS ROOM', {
      head: [[
        'Tenant', 'Move-in', 'Move-out', 'Meter reading at move-in',
        'Meter reading at move-out', 'Assignment status',
      ]],
      body: roomAssignments.map((assignment) => [
        `${assignment.tenantName} (${assignment.tenantCode})`,
        assignment.moveInDate || '-',
        assignment.moveOutDate || 'Current',
        readingRecordedOnDate(data, assignment.roomId, assignment.moveInDate),
        assignment.moveOutDate
          ? readingRecordedOnDate(data, assignment.roomId, assignment.moveOutDate)
          : 'Not applicable - current assignment',
        assignment.status.replaceAll('_', ' '),
      ]),
    })

    const roomMeterAssignments = data.meterAssignments
      .filter((assignment) => assignment.roomId === entity.id)
      .sort((a, b) => a.assignedOn.localeCompare(b.assignedOn))

    addStatementHistoryTable(pdf, scope, entity, 'METER ASSIGNMENT HISTORY FOR THIS ROOM', {
      head: [[
        'Reference', 'Meter', 'Assigned on', 'Initial reading', 'Ended on',
        'Final reading', 'End reason', 'Status',
      ]],
      body: roomMeterAssignments.map((assignment) => [
        formatHumanReference(references, 'meter', assignment.id),
        assignment.meterCode,
        assignment.assignedOn || '-',
        assignment.initialReading.toLocaleString('en-BD'),
        assignment.endedOn || 'Current',
        assignment.finalReading === null
          ? '-'
          : assignment.finalReading.toLocaleString('en-BD'),
        assignment.endReason ? assignment.endReason.replaceAll('_', ' ') : '-',
        assignment.status.replaceAll('_', ' '),
      ]),
    })


  }

  if (scope === 'meter') {
    const meterAssignments = data.meterAssignments
      .filter((assignment) => assignment.meterId === entity.id)
      .sort((a, b) => a.assignedOn.localeCompare(b.assignedOn))

    addStatementHistoryTable(pdf, scope, entity, 'METER ASSIGNMENT HISTORY', {
      head: [[
        'Reference', 'Assigned on', 'Room', 'Tenant / Current occupant', 'Property', 'Initial reading',
        'Ended on', 'Final reading', 'End reason', 'Status',
      ]],
      body: meterAssignments.map((assignment) => [
        formatHumanReference(references, 'meter', assignment.id),
        assignment.assignedOn || '-',
        assignment.roomCode,
        tenantLabelForMeterAssignment(data, assignment),
        assignment.propertyCode,
        assignment.initialReading.toLocaleString('en-BD'),
        assignment.endedOn || 'Current',
        assignment.finalReading === null
          ? '-'
          : assignment.finalReading.toLocaleString('en-BD'),
        assignment.endReason ? assignment.endReason.replaceAll('_', ' ') : '-',
        assignment.status.replaceAll('_', ' '),
      ]),
    })

    const meterReadings = data.electricityBills
      .filter((bill) => bill.meterId === entity.id)
      .sort((a, b) => a.readingDate.localeCompare(b.readingDate))

    addStatementHistoryTable(pdf, scope, entity, 'RECORDED METER READINGS', {
      head: [[
        'Reading date', 'Month', 'Room', 'Tenant billed', 'Previous', 'Current',
        'Units', 'Rate / unit', 'Amount', 'Bill reference',
      ]],
      body: meterReadings.map((bill) => [
        bill.readingDate,
        bill.billingMonth,
        roomLabel(data, bill.roomId, bill.roomCode),
        electricityBillTenantLabel(data, bill),
        bill.previousReading.toLocaleString('en-BD'),
        bill.currentReading.toLocaleString('en-BD'),
        bill.unitsConsumed.toLocaleString('en-BD'),
        statementMoney(bill.pricePerUnitMinor),
        statementMoney(bill.amountMinor),
        formatHumanReference(references, 'electricity', bill.meterAssignmentId, bill.readingDate),
      ]),
    })
  }

  const totalPages = pdf.getNumberOfPages()
  for (let page = 1; page <= totalPages; page++) {
    pdf.setPage(page)
    pdf.setDrawColor(...STATEMENT_COLORS.border)
    pdf.setLineWidth(0.55)
    pdf.line(margin, pageHeight - 27, pageWidth - margin, pageHeight - 27)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(7.5)
    pdf.setTextColor(...STATEMENT_COLORS.muted)
    pdf.text(`Page ${page} of ${totalPages}`, pageWidth - margin, pageHeight - 12, {
      align: 'right',
    })
    drawStatementText(
      pdf,
      [
        'Amounts shown in BDT where applicable',
        activeStatementSettings.statementFooter.trim(),
      ].filter(Boolean).join(' · '),
      margin,
      pageHeight - 12,
      {
        fontSize: 7.5,
        color: STATEMENT_COLORS.muted,
      },
    )
  }

  const safeName = `${scope}-${entity.title}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || scope
  const dateStamp = new Date().toISOString().slice(0, 10)
  pdf.save(`${safeName}-statement-${dateStamp}.pdf`)
}

export function LedgersPage({
  ownerUid,
}: LedgerPageProps) {
  const [scope, setScope] =
    useState<LedgerScope>('tenant')

  const [data, setData] =
    useState<LedgerSourceData | null>(null)

  const [selectedEntityId, setSelectedEntityId] =
    useState('')

  const [search, setSearch] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async (
    isRefresh = false,
  ) => {
    if (isRefresh) invalidateOwnerDataCache(ownerUid)
    setError('')

    if (isRefresh) {
      setRefreshing(true)
    } else {
      setIsLoading(true)
    }

    try {
      const nextData =
        await loadLedgerSourceData(ownerUid)

      setData(nextData)
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load ledger records.',
      )
    } finally {
      setIsLoading(false)
      setRefreshing(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const entities = useMemo(
    () => data
      ? buildEntities(data, scope)
      : [],
    [data, scope],
  )

  useEffect(() => {
    // Keep the ledger unselected by default. Only clear a selection when it
    // no longer belongs to the active ledger scope; never auto-pick a record.
    if (
      selectedEntityId &&
      !entities.some(
        (entity) => entity.id === selectedEntityId,
      )
    ) {
      setSelectedEntityId('')
    }
  }, [entities, selectedEntityId])

  const allEntries = useMemo(
    () => data && selectedEntityId
      ? buildEntries(data, scope, selectedEntityId)
      : [],
    [data, scope, selectedEntityId],
  )

  const displayedEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()

    return allEntries.filter((entry) =>
      isDateInside(entry.date, startDate, endDate) &&
      (
        !query ||
        entry.searchableText.includes(query)
      ),
    )
  }, [allEntries, search, startDate, endDate])

  const summary = useMemo(
    () => displayedEntries.reduce(
      (result, entry) => ({
        debits: result.debits + entry.debitMinor,
        credits: result.credits + entry.creditMinor,
      }),
      { debits: 0, credits: 0 },
    ),
    [displayedEntries],
  )

  const currentBalance = allEntries.length
    ? allEntries[allEntries.length - 1].balanceMinor
    : 0

  const selectedEntity = entities.find(
    (entity) => entity.id === selectedEntityId,
  )
  const showFinancialColumns = true

  return (
    <section className="ledgers-page">
      <header className="ledger-page-heading">
        <div>
          <p className="ledger-eyebrow">
            FINANCE · STATEMENTS
          </p>
          <h1>Ledgers</h1>
          <p className="ledger-subtitle">
            One consistent transaction history across
            tenants, rooms, and meters.
          </p>
        </div>

        <button
          className="ledger-refresh-button"
          type="button"
          onClick={() => {
            if (!data || !selectedEntity) return
            void downloadLedgerStatementPdf(ownerUid, scope, selectedEntity, allEntries, data).catch((downloadError: unknown) => {
              setError(downloadError instanceof Error ? downloadError.message : 'The PDF statement could not be created.')
            })
          }}
          disabled={isLoading || !data || !selectedEntity}
        >
          <Download size={17} />
          <span>Download PDF</span>
        </button>

        <button
          className="ledger-refresh-button"
          type="button"
          onClick={() => void loadData(true)}
          disabled={isLoading || refreshing}
        >
          {refreshing
            ? <LoaderCircle size={17} className="ledger-spin" />
            : <RefreshCw size={17} />
          }
          <span>
            {refreshing ? 'Refreshing' : 'Refresh'}
          </span>
        </button>
      </header>

      <div
        className="ledger-scope-tabs"
        role="tablist"
        aria-label="Ledger type"
      >
        {(
          ['tenant', 'room', 'meter'] as LedgerScope[]
        ).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={scope === item}
            className={
              scope === item
                ? 'ledger-scope-tab is-active'
                : 'ledger-scope-tab'
            }
            onClick={() => {
              setScope(item)
              setSelectedEntityId('')
            }}
          >
            <LedgerPageIcon scope={item} />
            <span>
              {item === 'tenant'
                ? 'Tenant'
                : item === 'room'
                  ? 'Room'
                  : 'Meter'
              }
            </span>
          </button>
        ))}
      </div>

      <div className="ledger-filter-panel">
        <label className="ledger-field ledger-entity-field">
          <span>
            {scope === 'tenant'
              ? 'Select tenant'
              : scope === 'room'
                ? 'Select room'
                : 'Select meter'
            }
          </span>

          <select
            value={selectedEntityId}
            onChange={(event) =>
              setSelectedEntityId(event.target.value)
            }
            disabled={isLoading || entities.length === 0}
          >
            <option value="">
              {entities.length === 0
                ? 'No records available'
                : scope === 'tenant'
                  ? 'Choose a tenant'
                  : scope === 'room'
                    ? 'Choose a room'
                    : 'Choose a meter'
              }
            </option>

            {entities.map((entity) => (
              <option value={entity.id} key={entity.id}>
                {entity.optionLabel ?? `${entity.title} — ${entity.subtitle}`}
              </option>
            ))}
          </select>
        </label>

        <label className="ledger-field ledger-search-field">
          <span>Search transactions</span>

          <div className="ledger-input-with-icon">
            <Search size={17} aria-hidden="true" />
            <input
              value={search}
              onChange={(event) =>
                setSearch(event.target.value)
              }
              placeholder="Type, reference, room, bill ID…"
            />
          </div>
        </label>

        <label className="ledger-field">
          <span>From date</span>

          <div className="ledger-input-with-icon">
            <CalendarDays size={16} aria-hidden="true" />
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(event) =>
                setStartDate(event.target.value)
              }
            />
          </div>
        </label>

        <label className="ledger-field">
          <span>To date</span>

          <div className="ledger-input-with-icon">
            <CalendarDays size={16} aria-hidden="true" />
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) =>
                setEndDate(event.target.value)
              }
            />
          </div>
        </label>
      </div>

      {error && (
        <div className="ledger-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />

          <div>
            <strong>Could not load ledger data</strong>
            <p>{error}</p>
          </div>

          <button
            type="button"
            onClick={() => void loadData(true)}
          >
            Try again
          </button>
        </div>
      )}

      <div className="ledger-summary-grid">
        <article className="ledger-summary-card">
          <span><BookOpen size={16} /> Entries shown</span>
          <strong>
            {displayedEntries.length.toLocaleString('en-BD')}
          </strong>
          <small>
            {selectedEntity?.title ?? scopeLabel(scope)}
          </small>
        </article>

        <article className="ledger-summary-card">
          <span><Zap size={16} /> Debits in filter</span>
          <strong>{formatMoney(summary.debits)}</strong>
          <small>Bills and charges</small>
        </article>

        <article className="ledger-summary-card">
          <span><Wallet size={16} /> Credits in filter</span>
          <strong>{formatMoney(summary.credits)}</strong>
          <small>Payments or applied advances</small>
        </article>

        <article
          className={
            'ledger-summary-card ' +
            (
              currentBalance > 0
                ? 'is-due'
                : currentBalance < 0
                  ? 'is-credit'
                  : ''
            )
          }
        >
          <span><Wallet size={16} /> Current balance</span>
          <strong>
            {formatMoney(Math.abs(currentBalance))}
          </strong>
          <small>
            {currentBalance > 0
              ? 'Outstanding due'
              : currentBalance < 0
                ? 'Credit / advance'
                : 'Settled'
            }
          </small>
        </article>
      </div>

      {scope === 'tenant' && selectedEntityId && data && (
        <section className="ledger-occupancy-card" aria-label="Tenant occupancy history">
          <div className="ledger-occupancy-heading">
            <div>
              <h2>Tenant occupancy history</h2>
              <p>Every room this tenant has occupied, in chronological order.</p>
            </div>
            <span>{data.tenantAssignments.filter((assignment) => assignment.tenantId === selectedEntityId).length} stays</span>
          </div>
          {data.tenantAssignments.filter((assignment) => assignment.tenantId === selectedEntityId).length === 0 ? (
            <div className="ledger-occupancy-empty">No occupancy history is recorded for this tenant.</div>
          ) : (
            <div className="ledger-occupancy-table-wrap">
              <table className="ledger-occupancy-table">
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Floor / Property</th>
                    <th>Move-in</th>
                    <th>Move-out</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tenantAssignments
                    .filter((assignment) => assignment.tenantId === selectedEntityId)
                    .sort((a, b) => a.moveInDate.localeCompare(b.moveInDate))
                    .map((assignment) => (
                      <tr key={assignment.id}>
                        <td data-label="Room"><strong>Room {assignment.roomNumber}</strong><small>{assignment.roomCode}</small></td>
                        <td data-label="Floor / Property">{assignment.floorName} · {assignment.propertyCode}</td>
                        <td data-label="Move-in">{formatDate(assignment.moveInDate)}</td>
                        <td data-label="Move-out">{assignment.moveOutDate ? formatDate(assignment.moveOutDate) : 'Current'}</td>
                        <td data-label="Status"><span className={assignment.status === 'current' ? 'ledger-occupancy-status is-current' : 'ledger-occupancy-status'}>{assignment.status === 'current' ? 'Current' : 'Ended'}</span></td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section
        className="ledger-table-card"
        aria-label={scopeLabel(scope)}
      >
        <div className="ledger-table-heading">
          <div>
            <h2>{scopeLabel(scope)}</h2>
            <p>
              {selectedEntity
                ? `${selectedEntity.title} · ${selectedEntity.subtitle}`
                : 'Choose a record to view its statement.'
              }
            </p>
          </div>

          <span className="ledger-count-pill">
            {displayedEntries.length} rows
          </span>
        </div>

        {isLoading ? (
          <div className="ledger-state">
            <LoaderCircle
              className="ledger-spin"
              size={24}
            />
            <span>Loading transactions…</span>
          </div>
        ) : !selectedEntityId ? (
          <div className="ledger-state">
            <BookOpen size={26} />
            <span>No {scope} records are available yet.</span>
          </div>
        ) : displayedEntries.length === 0 ? (
          <div className="ledger-state">
            <Search size={26} />
            <span>No transactions match these filters.</span>
            <small>
              Try clearing the search or date range.
            </small>
          </div>
        ) : (
          <>
            <div className="ledger-desktop-table-wrap">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Type</th>
                    <th>{scope === 'tenant' ? 'Room' : 'Tenant'}</th>
                    <th>Reference / Details</th>
                    {showFinancialColumns && <th className="align-right">Debit</th>}
                    {showFinancialColumns && <th className="align-right">Credit</th>}
                    {showFinancialColumns && <th className="align-right">Balance</th>}
                  </tr>
                </thead>

                <tbody>
                  {displayedEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="ledger-date-cell">
                        {formatDate(entry.date)}
                      </td>
                      <td className="ledger-time-cell">
                        {entry.time}
                      </td>
                      <td>
                        <span
                          className={
                            'ledger-type-pill ' +
                            (
                              entry.creditMinor > 0
                                ? 'is-credit'
                                : 'is-debit'
                            )
                          }
                        >
                          {entry.type}
                        </span>
                      </td>
                      <td className="ledger-context-cell">
                        {entry.contextLabel}
                      </td>
                      <td>
                        <div className="ledger-reference">
                          {entry.reference}
                        </div>
                        <div className="ledger-description">
                          {entry.description}
                        </div>
                      </td>
                      {showFinancialColumns && (
                        <td className="align-right ledger-money debit">
                          {entry.debitMinor
                            ? formatMoney(entry.debitMinor)
                            : '—'
                          }
                        </td>
                      )}
                      {showFinancialColumns && (
                        <td className="align-right ledger-money credit">
                          {entry.creditMinor
                            ? formatMoney(entry.creditMinor)
                            : '—'
                          }
                        </td>
                      )}
                      {showFinancialColumns && (
                        <td
                          className={
                            'align-right ledger-money ' +
                            (
                              entry.balanceMinor > 0
                                ? 'due'
                                : entry.balanceMinor < 0
                                  ? 'credit'
                                  : ''
                            )
                          }
                        >
                          {entry.balanceMinor < 0
                            ? `−${formatMoney(Math.abs(entry.balanceMinor))}`
                            : formatMoney(entry.balanceMinor)
                          }
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ledger-mobile-list">
              {displayedEntries.map((entry) => (
                <article
                  className="ledger-mobile-entry"
                  key={entry.id}
                >
                  <div className="ledger-mobile-entry-top">
                    <span
                      className={
                        'ledger-type-pill ' +
                        (
                          entry.creditMinor > 0
                            ? 'is-credit'
                            : 'is-debit'
                        )
                      }
                    >
                      {entry.type}
                    </span>

                    <time>
                      {formatDate(entry.date)}
                      {entry.time !== '—'
                        ? ` · ${entry.time}`
                        : ''
                      }
                    </time>
                  </div>

                  <strong className="ledger-mobile-reference">
                    {entry.reference}
                  </strong>

                  <div className="ledger-mobile-context">
                    <small>{scope === 'tenant' ? 'Room' : 'Tenant'}</small>
                    <strong>{entry.contextLabel}</strong>
                  </div>

                  <p>{entry.description}</p>

                  {showFinancialColumns && <div className="ledger-mobile-amounts">
                    <span>
                      <small>Debit</small>
                      <b>
                        {entry.debitMinor
                          ? formatMoney(entry.debitMinor)
                          : '—'
                        }
                      </b>
                    </span>

                    <span>
                      <small>Credit</small>
                      <b>
                        {entry.creditMinor
                          ? formatMoney(entry.creditMinor)
                          : '—'
                        }
                      </b>
                    </span>

                    <span>
                      <small>Balance</small>
                      <b
                        className={
                          entry.balanceMinor > 0
                            ? 'due'
                            : entry.balanceMinor < 0
                              ? 'credit'
                              : ''
                        }
                      >
                        {entry.balanceMinor < 0
                          ? `−${formatMoney(Math.abs(entry.balanceMinor))}`
                          : formatMoney(entry.balanceMinor)
                        }
                      </b>
                    </span>
                  </div>}
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <p className="ledger-footnote">
        {scope === 'tenant'
          ? 'Tenant ledger combines rent and electricity bills across every room this tenant has occupied.'
          : scope === 'room'
            ? 'Room ledger shows rent charges and rent payments for this room only. Electricity calculations are kept in Meter ledger.'
            : 'Meter ledger shows electricity readings, electricity bills, and their payments for this meter only.'
        }{' '}
        Balances are calculated from saved issued bills and posted receipts/credit applications. This screen is read-only and does not modify financial records. Date filters change displayed rows; the current balance reflects the full available history.
      </p>
    </section>
  )
}
