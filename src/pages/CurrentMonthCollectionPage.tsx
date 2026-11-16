import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  LoaderCircle,
  RefreshCw,
  ReceiptText,
  Wallet,
} from 'lucide-react'

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

import { SearchInput } from '../components/ui/SearchInput'
import {
  type RentBillRecord,
  listRentBills,
} from '../services/firebase/rentBills'
import {
  type PaymentBillBalanceRecord,
  listPaymentBillBalances,
} from '../services/firebase/payments'
import {
  resolveElectricityBillTenantAssignment,
  type ElectricityBillRecord,
} from '../services/firebase/electricity'
import { loadWorkspaceSettings } from '../services/firebase/workspaceSettings'
import { loadLedgerSourceData, type LedgerSourceData } from '../services/firebase/ledgers'
import { invalidateOwnerDataCache } from '../services/firebase/listCache'
import type { AppPage } from '../types/navigation'
import './current-month-collection.css'

type CurrentMonthCollectionPageProps = {
  ownerUid: string
  onNavigate: (page: AppPage) => void
}

type CollectionStatus = 'paid' | 'partial' | 'unpaid'
type StatusFilter = 'all' | 'outstanding' | CollectionStatus

type CollectionRow = {
  bill: RentBillRecord
  paidAmountMinor: number
  outstandingMinor: number
  status: CollectionStatus
}

type CollectionTenantTableRow = {
  tenantId: string
  tenantName: string
  tenantCode: string
  propertyCodes: string[]
  rooms: string[]
  floorNames: string[]
  rentBillMinor: number
  paidAmountMinor: number
  outstandingMinor: number
  status: CollectionStatus
}

type CollectionPdfTenantRow = {
  tenantId: string
  tenantName: string
  tenantCode: string
  rooms: Set<string>
  balanceMinor: number
  rentBillMinor: number
  rentCollectedMinor: number
  electricityBillMinor: number
  electricityCollectedMinor: number
}

type CollectionPdfColor = [number, number, number]

type CollectionPdfCell = {
  raw?: unknown
  text?: string[]
  x: number
  y: number
  width: number
  height: number
  styles: {
    fontSize?: number
    fontStyle?: string
    textColor?: unknown
    fillColor?: unknown
    halign?: string
    lineWidth?: unknown
  }
  padding: (side: 'left' | 'right' | 'top' | 'bottom') => number
}

type CollectionPdfRenderedText = {
  dataUrl: string
  widthPt: number
  heightPt: number
  baselineOffsetPt: number
}

const COLLECTION_PDF_COLORS = {
  navy: [16, 44, 80] as CollectionPdfColor,
  gold: [213, 165, 46] as CollectionPdfColor,
  ivory: [246, 243, 235] as CollectionPdfColor,
  ink: [38, 54, 74] as CollectionPdfColor,
  black: [0, 0, 0] as CollectionPdfColor,
  due: [185, 28, 28] as CollectionPdfColor,
  advance: [22, 101, 52] as CollectionPdfColor,
  muted: [100, 116, 139] as CollectionPdfColor,
  border: [232, 225, 213] as CollectionPdfColor,
  white: [255, 255, 255] as CollectionPdfColor,
}

const COLLECTION_BENGALI_PATTERN = /[\u0980-\u09FF]/
const COLLECTION_BENGALI_FONT = 'Noto Serif Bengali'
const COLLECTION_PDF_IMAGE_SCALE = 3

function getCurrentBillingMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatTaka(amountMinor: number): string {
  return `৳${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`
}

function formatBillingMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00`)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('en-BD', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function getStatusLabel(status: CollectionStatus): string {
  if (status === 'paid') return 'Paid'
  if (status === 'partial') return 'Partially paid'
  return 'Unpaid'
}

function getStatusClass(status: CollectionStatus): string {
  return `collection-status collection-status-${status}`
}

const COLLECTION_ROOM_COLLATOR = new Intl.Collator('en', {
  sensitivity: 'base',
  numeric: true,
})

function compareCollectionRoomNumbers(left: string, right: string): number {
  const leftRoom = left.trim().toLocaleUpperCase('en-US')
  const rightRoom = right.trim().toLocaleUpperCase('en-US')
  const leftIsNumericRoom = /^\d/.test(leftRoom)
  const rightIsNumericRoom = /^\d/.test(rightRoom)

  // Put numbered apartment rooms first (101, 102, 103...), followed by
  // prefixed rooms in natural order (HB-01, S-01, TS-01, UT-01...).
  if (leftIsNumericRoom !== rightIsNumericRoom) {
    return leftIsNumericRoom ? -1 : 1
  }

  return COLLECTION_ROOM_COLLATOR.compare(leftRoom, rightRoom)
}

function sortCollectionRoomNumbers(rooms: Iterable<string>): string[] {
  return [...new Set([...rooms].map((room) => room.trim()).filter(Boolean))]
    .sort(compareCollectionRoomNumbers)
}

function getCollectionErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unable to load the current month collection. Please try again.'
}

function formatCollectionPdfMoney(amountMinor: number): string {
  return `BDT ${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`
}

function formatCollectionPdfGeneratedAt(): string {
  return new Intl.DateTimeFormat('en-BD', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())
}

async function ensureCollectionPdfBengaliFont(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    throw new Error('Bengali PDF text rendering is unavailable in this browser.')
  }

  const sample = 'বাংলা পরীক্ষা যুক্তাক্ষর'
  const [regularFaces, boldFaces] = await Promise.all([
    document.fonts.load(`400 12px "${COLLECTION_BENGALI_FONT}"`, sample),
    document.fonts.load(`700 12px "${COLLECTION_BENGALI_FONT}"`, sample),
  ])
  await document.fonts.ready

  if (regularFaces.length === 0 || boldFaces.length === 0) {
    throw new Error('The Bengali font could not be loaded. Check your internet connection and try the PDF download again.')
  }
}

function renderCollectionPdfBengaliText(
  text: string,
  fontSizePt: number,
  color: CollectionPdfColor,
  bold: boolean,
  maxWidthPt: number,
  maxHeightPt: number,
): CollectionPdfRenderedText {
  const pixelsPerPoint = (96 / 72) * COLLECTION_PDF_IMAGE_SCALE
  let fontSizePx = Math.max(4, fontSizePt * pixelsPerPoint)

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const measureCanvas = document.createElement('canvas')
    const measure = measureCanvas.getContext('2d')
    if (!measure) throw new Error('Could not prepare Bengali text for the PDF.')

    measure.font = `${bold ? '700' : '400'} ${fontSizePx}px "${COLLECTION_BENGALI_FONT}", "Nirmala UI", serif`
    measure.textBaseline = 'alphabetic'

    const paddingX = fontSizePx * 0.14
    const paddingY = fontSizePx * 0.12
    const maxWidthPx = Math.max(1, maxWidthPt * pixelsPerPoint)
    const availableLineWidth = Math.max(1, maxWidthPx - paddingX * 2)
    const lines: string[] = []

    for (const paragraph of text.replace(/\r/g, '').split('\n')) {
      const words = paragraph.trim().split(/\s+/).filter(Boolean)
      if (words.length === 0) {
        lines.push('')
        continue
      }
      let line = ''
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word
        if (line && measure.measureText(candidate).width > availableLineWidth) {
          lines.push(line)
          line = word
        } else {
          line = candidate
        }
      }
      if (line) lines.push(line)
    }

    const metricText = lines.find(Boolean) || text || 'বাংলা'
    const metrics = measure.measureText(metricText)
    const ascent = metrics.actualBoundingBoxAscent || fontSizePx * 0.86
    const descent = metrics.actualBoundingBoxDescent || fontSizePx * 0.28
    const lineHeight = fontSizePx * 1.3
    const contentWidth = Math.max(1, ...lines.map((line) => measure.measureText(line).width))
    const widthPx = contentWidth + paddingX * 2
    const heightPx = paddingY * 2 + ascent + descent + Math.max(0, lines.length - 1) * lineHeight

    if (widthPx > maxWidthPx || heightPx > maxHeightPt * pixelsPerPoint) {
      fontSizePx *= 0.88
      continue
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(widthPx))
    canvas.height = Math.max(1, Math.ceil(heightPx))
    const draw = canvas.getContext('2d')
    if (!draw) throw new Error('Could not render Bengali text for the PDF.')
    draw.font = `${bold ? '700' : '400'} ${fontSizePx}px "${COLLECTION_BENGALI_FONT}", "Nirmala UI", serif`
    draw.textBaseline = 'alphabetic'
    draw.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`
    lines.forEach((line, index) => {
      if (line) draw.fillText(line, paddingX, paddingY + ascent + index * lineHeight)
    })

    return {
      dataUrl: canvas.toDataURL('image/png'),
      widthPt: canvas.width / pixelsPerPoint,
      heightPt: canvas.height / pixelsPerPoint,
      baselineOffsetPt: (paddingY + ascent) / pixelsPerPoint,
    }
  }

  throw new Error('A Bengali tenant name is too long to fit in the PDF.')
}

function wrapCollectionPdfText(text: string, maxWidthPt: number, fontSizePt: number): string {
  if (!COLLECTION_BENGALI_PATTERN.test(text)) return text
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return text

  const fontSizePx = fontSizePt * (96 / 72)
  context.font = `400 ${fontSizePx}px "${COLLECTION_BENGALI_FONT}", "Nirmala UI", serif`
  const maxWidthPx = Math.max(1, (maxWidthPt - 10) * (96 / 72))
  const lines: string[] = []

  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (line && context.measureText(candidate).width > maxWidthPx) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line) lines.push(line)
  }

  return lines.join('\n')
}

function collectionPdfColor(value: unknown, fallback: CollectionPdfColor): CollectionPdfColor {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0]
  }
  if (typeof value === 'number') return [value, value, value]
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

function collectionPdfCellText(cell: CollectionPdfCell): string {
  if (typeof cell.raw === 'string' || typeof cell.raw === 'number') return String(cell.raw)
  if (Array.isArray(cell.raw)) return cell.raw.map((value) => String(value ?? '')).join('\n')
  return (cell.text ?? []).join('\n')
}

function drawCollectionPdfBengaliCell(pdf: jsPDF, cell: CollectionPdfCell): void {
  const text = collectionPdfCellText(cell)
  if (!COLLECTION_BENGALI_PATTERN.test(text)) return

  const paddingLeft = cell.padding('left')
  const paddingRight = cell.padding('right')
  const paddingTop = cell.padding('top')
  const paddingBottom = cell.padding('bottom')
  const availableWidth = Math.max(1, cell.width - paddingLeft - paddingRight)
  const availableHeight = Math.max(1, cell.height - paddingTop - paddingBottom)
  const borderInset = Math.max(0.45, Number(cell.styles.lineWidth) || 0.35)
  const fill = collectionPdfColor(cell.styles.fillColor, COLLECTION_PDF_COLORS.white)
  const textColor = collectionPdfColor(cell.styles.textColor, COLLECTION_PDF_COLORS.ink)

  pdf.setFillColor(...fill)
  pdf.rect(
    cell.x + borderInset,
    cell.y + borderInset,
    Math.max(0, cell.width - borderInset * 2),
    Math.max(0, cell.height - borderInset * 2),
    'F',
  )

  const image = renderCollectionPdfBengaliText(
    text,
    Number(cell.styles.fontSize) || 7.2,
    textColor,
    String(cell.styles.fontStyle || '').includes('bold'),
    availableWidth,
    availableHeight,
  )
  const align = cell.styles.halign || 'left'
  const imageX = align === 'right'
    ? cell.x + cell.width - paddingRight - image.widthPt
    : align === 'center'
      ? cell.x + (cell.width - image.widthPt) / 2
      : cell.x + paddingLeft
  const imageY = cell.y + paddingTop + Math.max(0, (availableHeight - image.heightPt) / 2)
  pdf.addImage(image.dataUrl, 'PNG', imageX, imageY, image.widthPt, image.heightPt)
}

function drawCollectionPdfText(
  pdf: jsPDF,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: CollectionPdfColor,
  maxWidth: number,
  bold = false,
): void {
  if (COLLECTION_BENGALI_PATTERN.test(text)) {
    const image = renderCollectionPdfBengaliText(text, fontSize, color, bold, maxWidth, fontSize * 2.2)
    pdf.addImage(image.dataUrl, 'PNG', x, y - image.baselineOffsetPt, image.widthPt, image.heightPt)
    return
  }

  pdf.setFont('helvetica', bold ? 'bold' : 'normal')
  pdf.setFontSize(fontSize)
  pdf.setTextColor(...color)
  pdf.text(text, x, y, { maxWidth })
}

function safeCollectionMinor(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Resolve electricity bills with the same historical meter-assignment logic
 * used by the tenant ledger. This prevents old bills from being attributed to
 * a tenant who occupies the room today instead of the tenant on the reading date.
 */
function resolveLedgerElectricityTenantId(
  bill: ElectricityBillRecord,
  data: LedgerSourceData,
): string | null {
  const meterAssignment = data.meterAssignments.find(
    (assignment) =>
      assignment.id === bill.meterAssignmentId &&
      assignment.meterId === bill.meterId,
  )
  const roomId = meterAssignment?.roomId ?? bill.roomId
  const candidates = data.tenantAssignments.filter(
    (assignment) =>
      assignment.roomId === roomId &&
      assignment.moveInDate <= bill.readingDate &&
      (assignment.moveOutDate === null || assignment.moveOutDate >= bill.readingDate),
  )

  if (candidates.length === 1) return candidates[0]?.tenantId ?? null
  if (candidates.length === 0) return null

  const currentCandidates = candidates.filter(
    (assignment) => assignment.status === 'current' && assignment.moveOutDate === null,
  )
  if (currentCandidates.length === 1) return currentCandidates[0]?.tenantId ?? null
  if (currentCandidates.length > 1) return null

  const latestMoveInDate = candidates.reduce(
    (latest, assignment) => assignment.moveInDate > latest ? assignment.moveInDate : latest,
    candidates[0].moveInDate,
  )
  const latestCandidates = candidates.filter(
    (assignment) => assignment.moveInDate === latestMoveInDate,
  )
  return latestCandidates.length === 1 ? latestCandidates[0]?.tenantId ?? null : null
}

/**
 * Mirrors the tenant ledger's current-balance calculation:
 * opening balance + issued rent/electricity bills + adjustments - posted receipts.
 * Positive balances are due; negative balances are available advance/credit.
 */
function calculateTenantLedgerBalances(data: LedgerSourceData): Map<string, number> {
  const balances = new Map<string, number>()
  const add = (tenantId: string, amountMinor: number) => {
    const amount = safeCollectionMinor(Math.abs(amountMinor))
    if (!tenantId || amount === 0) return
    const signedAmount = amountMinor < 0 ? -amount : amount
    balances.set(tenantId, (balances.get(tenantId) ?? 0) + signedAmount)
  }

  // The tenant ledger displays the original opening balance, then its audited
  // increases/decreases and every posted receipt as separate transactions.
  for (const openingBalance of data.openingBalances) {
    add(openingBalance.tenantId, openingBalance.originalAmountMinor)
  }

  for (const adjustment of data.openingBalanceAdjustments) {
    add(
      adjustment.tenantId,
      adjustment.direction === 'increase' ? adjustment.amountMinor : -adjustment.amountMinor,
    )
  }

  for (const bill of data.rentBills) {
    if (bill.status !== 'issued') continue
    add(bill.tenantId, bill.totalMinor)
  }

  for (const bill of data.electricityBills) {
    if (bill.status !== 'issued') continue
    const tenantId = resolveLedgerElectricityTenantId(bill, data)
    if (tenantId) add(tenantId, bill.amountMinor)
  }

  // A tenant ledger credits the full posted receipt exactly once. This includes
  // any portion retained as an advance, so an unused advance creates a negative
  // (credit) balance just as it does on the individual tenant statement PDF.
  for (const payment of data.payments) {
    if (payment.status !== 'posted') continue
    add(payment.tenantId, -payment.amountMinor)
  }

  return balances
}

function formatCollectionPdfTenantBalance(balanceMinor: number): string {
  // The sign is communicated by the cell color: red = due, green = advance.
  // Keep the cell itself clean and display only the currency amount.
  return formatCollectionPdfMoney(Math.abs(balanceMinor))
}

export function CurrentMonthCollectionPage({
  ownerUid,
  onNavigate,
}: CurrentMonthCollectionPageProps) {
  const [bills, setBills] = useState<RentBillRecord[]>([])
  const [balances, setBalances] = useState<PaymentBillBalanceRecord[]>([])
  const [billingMonth, setBillingMonth] = useState(getCurrentBillingMonth)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchValue, setSearchValue] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false)
  const [pageError, setPageError] = useState('')
  const [pdfError, setPdfError] = useState('')

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setPageError('')

    try {
      // This report must reflect the latest payment allocations, not a
      // recently cached balance from before a payment was recorded.
      invalidateOwnerDataCache(ownerUid)

      const [nextBills, nextBalances] = await Promise.all([
        listRentBills(ownerUid),
        listPaymentBillBalances(ownerUid),
      ])

      setBills(nextBills)
      setBalances(nextBalances)
    } catch (error: unknown) {
      setPageError(getCollectionErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const rows = useMemo<CollectionRow[]>(() => {
    const rentBalanceByBillId = new Map(
      balances
        .filter((balance) => balance.billType === 'rent')
        .map((balance) => [balance.billId, balance] as const),
    )

    const collator = new Intl.Collator('en', {
      sensitivity: 'base',
      numeric: true,
    })

    return bills
      .filter((bill) => bill.billingMonth === billingMonth)
      .map((bill) => {
        const balance = rentBalanceByBillId.get(bill.id)
        // No balance document means no payment has been allocated to this
        // issued bill yet. Previous dues and tenant-level opening balances
        // are deliberately not considered here.
        const paidAmountMinor = balance?.paidAmountMinor ?? 0
        const outstandingMinor = balance?.outstandingMinor ?? bill.totalMinor
        const status: CollectionStatus = outstandingMinor <= 0
          ? 'paid'
          : paidAmountMinor > 0
            ? 'partial'
            : 'unpaid'

        return {
          bill,
          paidAmountMinor,
          outstandingMinor,
          status,
        }
      })
      .sort((a, b) =>
        compareCollectionRoomNumbers(a.bill.roomNumber, b.bill.roomNumber) ||
        collator.compare(a.bill.propertyCode, b.bill.propertyCode) ||
        collator.compare(a.bill.tenantName, b.bill.tenantName),
      )
  }, [bills, balances, billingMonth])

  // The on-screen collection table is tenant-wise: a tenant with multiple
  // room/shop invoices appears once, with room labels and amounts combined.
  // This is intentionally separate from the PDF generation path below.
  const tenantTableRows = useMemo<CollectionTenantTableRow[]>(() => {
    const grouped = new Map<string, CollectionRow[]>()

    for (const row of rows) {
      const groupKey = row.bill.tenantId || `bill:${row.bill.id}`
      const tenantRows = grouped.get(groupKey) ?? []
      tenantRows.push(row)
      grouped.set(groupKey, tenantRows)
    }

    return [...grouped.entries()].map(([tenantId, tenantRows]) => {
      const first = tenantRows[0]!
      const rentBillMinor = tenantRows.reduce((total, row) => total + row.bill.totalMinor, 0)
      const paidAmountMinor = tenantRows.reduce((total, row) => total + row.paidAmountMinor, 0)
      const outstandingMinor = tenantRows.reduce((total, row) => total + row.outstandingMinor, 0)
      const status: CollectionStatus = outstandingMinor <= 0
        ? 'paid'
        : paidAmountMinor > 0
          ? 'partial'
          : 'unpaid'

      return {
        tenantId,
        tenantName: first.bill.tenantName,
        tenantCode: first.bill.tenantCode,
        propertyCodes: [...new Set(tenantRows.map((row) => row.bill.propertyCode).filter(Boolean))]
          .sort((a, b) => COLLECTION_ROOM_COLLATOR.compare(a, b)),
        rooms: sortCollectionRoomNumbers(tenantRows.map((row) => row.bill.roomNumber || row.bill.roomCode)),
        floorNames: [...new Set(tenantRows.map((row) => row.bill.floorName).filter(Boolean))]
          .sort((a, b) => COLLECTION_ROOM_COLLATOR.compare(a, b)),
        rentBillMinor,
        paidAmountMinor,
        outstandingMinor,
        status,
      }
    }).sort((a, b) =>
      compareCollectionRoomNumbers(a.rooms[0] ?? '', b.rooms[0] ?? '') ||
      COLLECTION_ROOM_COLLATOR.compare(a.tenantName, b.tenantName),
    )
  }, [rows])

  const tenantCounts = useMemo(() => tenantTableRows.reduce((counts, tenant) => {
    counts.total += 1
    if (tenant.status === 'paid') counts.paid += 1
    if (tenant.status === 'partial') counts.partial += 1
    if (tenant.status === 'unpaid') counts.unpaid += 1
    if (tenant.outstandingMinor > 0) counts.outstanding += 1
    return counts
  }, {
    total: 0,
    paid: 0,
    partial: 0,
    unpaid: 0,
    outstanding: 0,
  }), [tenantTableRows])

  const summary = useMemo(() => {
    return rows.reduce((result, row) => {
      result.billedMinor += row.bill.totalMinor
      result.collectedMinor += row.paidAmountMinor
      result.outstandingMinor += row.outstandingMinor

      if (row.status === 'paid') result.paidCount += 1
      if (row.status === 'partial') result.partialCount += 1
      if (row.status === 'unpaid') result.unpaidCount += 1

      return result
    }, {
      billedMinor: 0,
      collectedMinor: 0,
      outstandingMinor: 0,
      paidCount: 0,
      partialCount: 0,
      unpaidCount: 0,
    })
  }, [rows])

  const filteredTenantRows = useMemo(() => {
    const search = searchValue.trim().toLocaleLowerCase()

    return tenantTableRows.filter((tenant) => {
      if (statusFilter === 'outstanding' && tenant.outstandingMinor <= 0) return false
      if (statusFilter !== 'all' && statusFilter !== 'outstanding' && tenant.status !== statusFilter) return false
      if (!search) return true

      return [
        tenant.tenantName,
        tenant.tenantCode,
        ...tenant.rooms,
        ...tenant.floorNames,
        ...tenant.propertyCodes,
      ].join(' ').toLocaleLowerCase().includes(search)
    })
  }, [tenantTableRows, searchValue, statusFilter])

  const handleDownloadPdf = useCallback(async () => {
    if (isDownloadingPdf) return

    setIsDownloadingPdf(true)
    setPdfError('')

    try {
      // Build the PDF from the complete tenant and ledger sources, not only
      // from the rent rows currently visible on the page. This ensures every
      // active tenant is listed even when that tenant has no bill this month.
      invalidateOwnerDataCache(ownerUid)
      const [ledgerData, freshBillBalances, { settings }] = await Promise.all([
        loadLedgerSourceData(ownerUid),
        listPaymentBillBalances(ownerUid),
        loadWorkspaceSettings(ownerUid),
      ])
      const tenantLedgerBalanceById = calculateTenantLedgerBalances(ledgerData)
      const billBalanceByKey = new Map(
        freshBillBalances.map((balance) => [`${balance.billType}__${balance.billId}`, balance] as const),
      )

      // Include all active tenants. Archived tenants are included only when
      // their full tenant-ledger balance is non-zero (due or advance).
      const tenantRowsById = new Map<string, CollectionPdfTenantRow>()
      for (const tenant of ledgerData.tenants) {
        const balanceMinor = tenantLedgerBalanceById.get(tenant.id) ?? 0
        if (tenant.status !== 'active' && balanceMinor === 0) continue

        const tenantAssignments = ledgerData.tenantAssignments.filter(
          (assignment) => assignment.tenantId === tenant.id,
        )
        const currentAssignments = tenantAssignments.filter(
          (assignment) => assignment.status === 'current' && assignment.moveOutDate === null,
        )
        const roomAssignments = currentAssignments.length > 0
          ? currentAssignments
          : tenantAssignments.length > 0
            ? (() => {
                const latestAssignmentDate = tenantAssignments.reduce((latest, assignment) => {
                  const assignmentDate = assignment.moveOutDate ?? assignment.moveInDate
                  return assignmentDate > latest ? assignmentDate : latest
                }, '')
                return tenantAssignments.filter(
                  (assignment) => (assignment.moveOutDate ?? assignment.moveInDate) === latestAssignmentDate,
                )
              })()
            : []

        tenantRowsById.set(tenant.id, {
          tenantId: tenant.id,
          tenantName: tenant.fullName,
          tenantCode: tenant.tenantCode,
          rooms: new Set(roomAssignments.map((assignment) =>
            assignment.roomNumber.trim() || assignment.roomCode.trim(),
          ).filter(Boolean)),
          balanceMinor,
          rentBillMinor: 0,
          rentCollectedMinor: 0,
          electricityBillMinor: 0,
          electricityCollectedMinor: 0,
        })
      }

      // Add the selected month's rent invoices and the payments allocated
      // specifically to those rent invoices.
      for (const bill of ledgerData.rentBills) {
        if (bill.billingMonth !== billingMonth) continue
        const tenantRow = tenantRowsById.get(bill.tenantId)
        if (!tenantRow) continue

        tenantRow.rooms.add(bill.roomNumber.trim() || bill.roomCode.trim())
        tenantRow.rentBillMinor += bill.totalMinor
        tenantRow.rentCollectedMinor += billBalanceByKey.get(`rent__${bill.id}`)?.paidAmountMinor ?? 0
      }

      // Add the selected month's electricity bills. New bills retain their
      // tenant snapshot; legacy bills are resolved against the historical room
      // assignment for the meter reading date.
      for (const bill of ledgerData.electricityBills) {
        if (bill.billingMonth !== billingMonth) continue
        const resolvedAssignment = resolveElectricityBillTenantAssignment(
          bill,
          ledgerData.tenantAssignments,
        )
        const tenantId = bill.tenantId || resolvedAssignment?.tenantId ||
          resolveLedgerElectricityTenantId(bill, ledgerData)
        if (!tenantId) continue
        const tenantRow = tenantRowsById.get(tenantId)
        if (!tenantRow) continue

        const roomRecord = ledgerData.rooms.find((room) => room.id === bill.roomId)
        const roomLabel = bill.tenantRoomNumber?.trim() ||
          resolvedAssignment?.roomNumber?.trim() ||
          roomRecord?.roomNumber?.trim() ||
          bill.roomCode.trim()
        if (roomLabel) tenantRow.rooms.add(roomLabel)
        tenantRow.electricityBillMinor += bill.amountMinor
        tenantRow.electricityCollectedMinor +=
          billBalanceByKey.get(`electricity__${bill.id}`)?.paidAmountMinor ?? 0
      }

      const tenantRows = [...tenantRowsById.values()]
      tenantRows.sort((left, right) => {
        const leftRooms = sortCollectionRoomNumbers(left.rooms)
        const rightRooms = sortCollectionRoomNumbers(right.rooms)
        if (leftRooms.length === 0 && rightRooms.length > 0) return 1
        if (leftRooms.length > 0 && rightRooms.length === 0) return -1
        const roomOrder = compareCollectionRoomNumbers(leftRooms[0] ?? '', rightRooms[0] ?? '')
        if (roomOrder !== 0) return roomOrder

        // Keep ties deterministic if two tenants happen to use the same room label.
        return left.tenantName.localeCompare(right.tenantName, 'en', {
          sensitivity: 'base',
          numeric: true,
        })
      })

      if (tenantRows.length === 0) {
        throw new Error('No active tenants or inactive tenants with a non-zero due/advance balance were found.')
      }

      const pdfTotals = tenantRows.reduce((total, row) => ({
        dueMinor: total.dueMinor + Math.max(0, row.balanceMinor),
        advanceMinor: total.advanceMinor + Math.max(0, -row.balanceMinor),
        rentBillMinor: total.rentBillMinor + row.rentBillMinor,
        rentCollectedMinor: total.rentCollectedMinor + row.rentCollectedMinor,
        electricityBillMinor: total.electricityBillMinor + row.electricityBillMinor,
        electricityCollectedMinor: total.electricityCollectedMinor + row.electricityCollectedMinor,
      }), {
        dueMinor: 0,
        advanceMinor: 0,
        rentBillMinor: 0,
        rentCollectedMinor: 0,
        electricityBillMinor: 0,
        electricityCollectedMinor: 0,
      })

      const activeTenantCount = ledgerData.tenants.filter((tenant) => tenant.status === 'active').length
      const archivedWithBalanceCount = tenantRows.length - activeTenantCount

      const houseName = settings.houseName || "T&N House's"
      const hasBengali = COLLECTION_BENGALI_PATTERN.test(houseName) ||
        tenantRows.some((row) => COLLECTION_BENGALI_PATTERN.test(row.tenantName))
      if (hasBengali) await ensureCollectionPdfBengaliFont()

      const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 30
      const colors = COLLECTION_PDF_COLORS

      pdf.setFillColor(...colors.navy)
      pdf.rect(0, 0, pageWidth, 72, 'F')
      pdf.setFillColor(...colors.gold)
      pdf.rect(0, 70, pageWidth, 2, 'F')
      drawCollectionPdfText(pdf, houseName, margin, 27, 15, colors.white, pageWidth - margin * 2, true)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10)
      pdf.setTextColor(...colors.white)
      pdf.text('MONTHLY RENT & ELECTRICITY COLLECTION REPORT', margin, 48)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(7)
      pdf.setTextColor(225, 232, 240)
      pdf.text(`Generated: ${formatCollectionPdfGeneratedAt()}`, pageWidth - margin, 27, { align: 'right' })
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(8)
      pdf.setTextColor(225, 232, 240)
      pdf.text(`Billing month: ${formatBillingMonth(billingMonth)}`, margin, 62)

      const cardY = 84
      const cardHeight = 54
      const cardGap = 10
      const summaryCards = [
        { label: 'TOTAL TENANT DUE', value: formatCollectionPdfMoney(pdfTotals.dueMinor), detail: 'Full tenant-ledger balance', valueColor: colors.due },
        { label: 'TOTAL ADVANCE CREDIT', value: formatCollectionPdfMoney(pdfTotals.advanceMinor), detail: 'Available tenant credit', valueColor: colors.advance },
        { label: 'MONTHLY RENT BILL', value: formatCollectionPdfMoney(pdfTotals.rentBillMinor), detail: `Collected: ${formatCollectionPdfMoney(pdfTotals.rentCollectedMinor)}`, valueColor: colors.black },
        { label: 'MONTHLY ELECTRICITY BILL', value: formatCollectionPdfMoney(pdfTotals.electricityBillMinor), detail: `Collected: ${formatCollectionPdfMoney(pdfTotals.electricityCollectedMinor)}`, valueColor: colors.black },
      ]
      const cardWidth = (pageWidth - margin * 2 - cardGap * (summaryCards.length - 1)) / summaryCards.length
      summaryCards.forEach((card, index) => {
        const x = margin + index * (cardWidth + cardGap)
        pdf.setFillColor(...colors.ivory)
        pdf.setDrawColor(...colors.border)
        pdf.roundedRect(x, cardY, cardWidth, cardHeight, 4, 4, 'FD')
        pdf.setFillColor(...colors.gold)
        pdf.rect(x + 1, cardY + 6, 2.5, cardHeight - 12, 'F')
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(7)
        pdf.setTextColor(...colors.muted)
        pdf.text(card.label, x + 10, cardY + 14)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(9)
        pdf.setTextColor(...card.valueColor)
        pdf.text(card.value, x + 10, cardY + 30, { maxWidth: cardWidth - 18 })
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(6.2)
        pdf.setTextColor(...colors.muted)
        pdf.text(card.detail, x + 10, cardY + 44, { maxWidth: cardWidth - 18 })
      })

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(8)
      pdf.setTextColor(...colors.muted)
      pdf.text(
        `${tenantRows.length} tenants · ${activeTenantCount} active · ${archivedWithBalanceCount} inactive with balance · amounts in BDT`,
        margin,
        151,
      )

      const body = tenantRows.map((row) => [
        wrapCollectionPdfText(row.tenantName, 150, 8.1),
        sortCollectionRoomNumbers(row.rooms).join('\n') || '—',
        formatCollectionPdfTenantBalance(row.balanceMinor),
        formatCollectionPdfMoney(row.rentBillMinor),
        formatCollectionPdfMoney(row.rentCollectedMinor),
        formatCollectionPdfMoney(row.electricityBillMinor),
        formatCollectionPdfMoney(row.electricityCollectedMinor),
      ])

      autoTable(pdf, {
        head: [[
          'Tenant',
          'Room(s)',
          'Balance',
          'Rent Bill',
          'Rent Paid',
          'Electricity Bill',
          'Electricity Paid',
        ]],
        body,
        foot: [[
          'TOTAL',
          '',
          `${formatCollectionPdfMoney(pdfTotals.dueMinor)}\n${formatCollectionPdfMoney(pdfTotals.advanceMinor)}`,
          formatCollectionPdfMoney(pdfTotals.rentBillMinor),
          formatCollectionPdfMoney(pdfTotals.rentCollectedMinor),
          formatCollectionPdfMoney(pdfTotals.electricityBillMinor),
          formatCollectionPdfMoney(pdfTotals.electricityCollectedMinor),
        ]],
        startY: 160,
        margin: { top: 64, bottom: 36, left: margin, right: margin },
        showHead: 'everyPage',
        showFoot: 'lastPage',
        styles: {
          font: 'helvetica',
          fontSize: 7.6,
          cellPadding: 6,
          overflow: 'linebreak',
          valign: 'middle',
          textColor: colors.ink,
          lineColor: colors.border,
          lineWidth: 0.35,
        },
        headStyles: {
          fillColor: colors.navy,
          textColor: colors.white,
          fontStyle: 'bold',
          fontSize: 8,
        },
        footStyles: {
          fillColor: colors.ivory,
          textColor: colors.navy,
          fontStyle: 'bold',
          lineWidth: 0.5,
        },
        alternateRowStyles: { fillColor: [250, 249, 246] },
        columnStyles: {
          0: { cellWidth: 168 },
          1: { cellWidth: 110 },
          2: { cellWidth: 120, halign: 'right' },
          3: { cellWidth: 90, halign: 'right' },
          4: { cellWidth: 90, halign: 'right' },
          5: { cellWidth: 100, halign: 'right' },
          6: { cellWidth: 100, halign: 'right' },
        },
        didParseCell: (hookData) => {
          if (hookData.section !== 'body' && hookData.section !== 'foot') return
          if (hookData.column.index === 2) {
            if (hookData.section === 'body') {
              const tenantRow = tenantRows[hookData.row.index]
              hookData.cell.styles.textColor = tenantRow
                ? tenantRow.balanceMinor > 0
                  ? colors.due
                  : tenantRow.balanceMinor < 0
                    ? colors.advance
                    : colors.black
                : colors.black
            } else {
              // Draw the two footer amounts separately so due stays red and
              // advance stays green without printing DUE/ADVANCE text labels.
              hookData.cell.text = []
              hookData.cell.styles.minCellHeight = 30
              hookData.cell.styles.textColor = colors.ink
            }
          } else if (hookData.column.index >= 3) {
            // Current-month rent/electricity bill and collected amounts stay black.
            hookData.cell.styles.textColor = colors.black
          }
        },
        didDrawCell: (hookData) => {
          drawCollectionPdfBengaliCell(pdf, hookData.cell as unknown as CollectionPdfCell)

          if (hookData.section === 'foot' && hookData.column.index === 2) {
            const cell = hookData.cell
            pdf.setFont('helvetica', 'bold')
            pdf.setFontSize(8)
            pdf.setTextColor(...colors.due)
            pdf.text(
              formatCollectionPdfMoney(pdfTotals.dueMinor),
              cell.x + cell.width - 7,
              cell.y + 11,
              { align: 'right' },
            )
            pdf.setTextColor(...colors.advance)
            pdf.text(
              formatCollectionPdfMoney(pdfTotals.advanceMinor),
              cell.x + cell.width - 7,
              cell.y + 23,
              { align: 'right' },
            )
          }
        },
        didDrawPage: (hookData) => {
          if (hookData.pageNumber > 1) {
            pdf.setFillColor(...colors.navy)
            pdf.rect(0, 0, pageWidth, 48, 'F')
            drawCollectionPdfText(pdf, houseName, margin, 22, 12, colors.white, pageWidth - margin * 2, true)
            pdf.setFont('helvetica', 'normal')
            pdf.setFontSize(8)
            pdf.setTextColor(225, 232, 240)
            pdf.text(`Monthly rent & electricity collection · ${formatBillingMonth(billingMonth)}`, margin, 37)
          }
        },
      })

      // Add a consistent footer after all pages have been created.
      const pageCount = pdf.getNumberOfPages()
      for (let page = 1; page <= pageCount; page += 1) {
        pdf.setPage(page)
        pdf.setDrawColor(...colors.border)
        pdf.setLineWidth(0.5)
        pdf.line(margin, pageHeight - 29, pageWidth - margin, pageHeight - 29)
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(6.5)
        pdf.setTextColor(...colors.muted)
        pdf.text(
          'Includes all active tenants and inactive tenants with a non-zero due/advance balance. Monthly Rent Paid and Electricity Paid show allocations to the selected month bills. Balance matches the tenant statement: issued rent/electricity bills + opening balance adjustments - posted receipts.',
          margin,
          pageHeight - 16,
          { maxWidth: pageWidth - margin * 2 - 65 },
        )
        pdf.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 16, { align: 'right' })
      }

      pdf.save(`rent-electricity-collection-${billingMonth}.pdf`)
    } catch (error: unknown) {
      setPdfError(error instanceof Error ? error.message : 'Could not generate the rent collection PDF.')
    } finally {
      setIsDownloadingPdf(false)
    }
  }, [billingMonth, isDownloadingPdf, ownerUid])

  const isCurrentMonth = billingMonth === getCurrentBillingMonth()

  return (
    <div className="current-collection-page">
      <header className="current-collection-header">
        <div>
          <p className="eyebrow">Finance / Rent</p>
          <h1>Current Month Collection</h1>
          <p className="page-description">
            Track which tenants have paid the rent bill for the selected month.
            Previous dues are kept separate.
          </p>
        </div>

        <div className="current-collection-actions">
          <label className="collection-month-field">
            <span><CalendarDays size={15} aria-hidden="true" /> Billing month</span>
            <input
              type="month"
              value={billingMonth}
              onChange={(event) => setBillingMonth(event.target.value)}
              aria-label="Select billing month"
            />
          </label>
          <button
            className="button button-primary collection-refresh-button"
            type="button"
            onClick={() => void handleDownloadPdf()}
            disabled={isLoading || isDownloadingPdf}
            title="Download the selected month rent and electricity collection report"
          >
            {isDownloadingPdf
              ? <LoaderCircle size={16} className="collection-spin" aria-hidden="true" />
              : <Download size={16} aria-hidden="true" />}
            {isDownloadingPdf ? 'Preparing PDF…' : 'Download PDF'}
          </button>
          <button
            className="button button-secondary collection-refresh-button"
            type="button"
            onClick={() => void loadData()}
            disabled={isLoading}
          >
            <RefreshCw size={16} className={isLoading ? 'collection-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </header>

      <div className="collection-scope-note" role="note">
        <CircleAlert size={17} aria-hidden="true" />
        <span>
          <strong>Month-specific report:</strong> payment status is calculated only
          from each rent bill in {formatBillingMonth(billingMonth)}. Previous-month
          dues and opening balances do not change this status.
        </span>
      </div>

      {pageError && (
        <div className="collection-error" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{pageError}</span>
          <button type="button" onClick={() => void loadData()}>Try again</button>
        </div>
      )}

      {pdfError && (
        <div className="collection-error" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{pdfError}</span>
          <button type="button" onClick={() => setPdfError('')}>Dismiss</button>
        </div>
      )}

      {isLoading ? (
        <div className="collection-loading" role="status">
          <RefreshCw size={19} className="collection-spin" aria-hidden="true" />
          Loading rent collection…
        </div>
      ) : !pageError && (
        <>
          <section className="collection-financial-summary" aria-label="Selected month financial summary">
            <article className="collection-money-card">
              <span className="collection-money-label"><ReceiptText size={16} aria-hidden="true" /> Total rent billed</span>
              <strong>{formatTaka(summary.billedMinor)}</strong>
              <small>{rows.length} rent bill{rows.length === 1 ? '' : 's'} issued</small>
            </article>
            <article className="collection-money-card collection-money-card-paid">
              <span className="collection-money-label"><CheckCircle2 size={16} aria-hidden="true" /> Paid against these bills</span>
              <strong>{formatTaka(summary.collectedMinor)}</strong>
              <small>Payments allocated to {formatBillingMonth(billingMonth)} rent invoices</small>
            </article>
            <article className="collection-money-card collection-money-card-due">
              <span className="collection-money-label"><Wallet size={16} aria-hidden="true" /> Current month remaining</span>
              <strong>{formatTaka(summary.outstandingMinor)}</strong>
              <small>{summary.unpaidCount + summary.partialCount} bill{summary.unpaidCount + summary.partialCount === 1 ? '' : 's'} not fully paid</small>
            </article>
          </section>

          {rows.length === 0 ? (
            <section className="collection-empty-panel">
              <span className="collection-empty-icon"><ReceiptText size={23} aria-hidden="true" /></span>
              <h2>No rent bills found for {formatBillingMonth(billingMonth)}</h2>
              <p>
                {isCurrentMonth
                  ? 'Generate the monthly rent bills first. Once bills are issued, this page will show which tenants have paid and which still have a balance.'
                  : 'There are no issued rent bills for this month.'}
              </p>
              <button
                className="button button-primary"
                type="button"
                onClick={() => onNavigate('Rent & Bills')}
              >
                Open Rent &amp; Bills
              </button>
            </section>
          ) : (
            <section className="collection-list-panel">
              <div className="collection-list-heading">
                <div>
                  <p className="eyebrow">{isCurrentMonth ? 'Running month' : 'Selected month'}</p>
                  <h2>{formatBillingMonth(billingMonth)} rent status</h2>
                  <p>{tenantCounts.paid} paid · {tenantCounts.partial} partially paid · {tenantCounts.unpaid} unpaid tenants</p>
                </div>
                <span className="collection-bill-count">{tenantCounts.total} tenants</span>
              </div>

              <div className="collection-toolbar">
                <div className="collection-status-filters" aria-label="Filter rent bills by payment status">
                  <button
                    className={statusFilter === 'all' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('all')}
                    aria-pressed={statusFilter === 'all'}
                  >
                    All <span>{tenantCounts.total}</span>
                  </button>
                  <button
                    className={statusFilter === 'outstanding' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('outstanding')}
                    aria-pressed={statusFilter === 'outstanding'}
                  >
                    Outstanding <span>{tenantCounts.outstanding}</span>
                  </button>
                  <button
                    className={statusFilter === 'unpaid' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('unpaid')}
                    aria-pressed={statusFilter === 'unpaid'}
                  >
                    Unpaid <span>{tenantCounts.unpaid}</span>
                  </button>
                  <button
                    className={statusFilter === 'partial' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('partial')}
                    aria-pressed={statusFilter === 'partial'}
                  >
                    Partial <span>{tenantCounts.partial}</span>
                  </button>
                  <button
                    className={statusFilter === 'paid' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('paid')}
                    aria-pressed={statusFilter === 'paid'}
                  >
                    Paid <span>{tenantCounts.paid}</span>
                  </button>
                </div>
                <SearchInput
                  value={searchValue}
                  onChange={setSearchValue}
                  placeholder="Search tenant, room or property…"
                />
              </div>

              {filteredTenantRows.length === 0 ? (
                <div className="collection-filter-empty">
                  No rent bills match this filter. Try another status or search term.
                </div>
              ) : (
                <div className="collection-table-wrap">
                  <table className="collection-table">
                    <thead>
                      <tr>
                        <th>Tenant</th>
                        <th>Room(s)</th>
                        <th className="is-numeric">Rent bill</th>
                        <th className="is-numeric">Paid against bill</th>
                        <th className="is-numeric">Remaining</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTenantRows.map((tenant) => (
                        <tr key={tenant.tenantId}>
                          <td>
                            <div className="collection-tenant-cell">
                              <strong>{tenant.tenantName}</strong>
                              <span>
                                {tenant.tenantCode}
                                {tenant.propertyCodes.length > 0 ? ` · ${tenant.propertyCodes.join(', ')}` : ''}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="collection-room-cell">
                              <strong>{tenant.rooms.join(', ') || '—'}</strong>
                              {tenant.floorNames.length > 0 && <span>{tenant.floorNames.join(', ')}</span>}
                            </div>
                          </td>
                          <td className="is-numeric">{formatTaka(tenant.rentBillMinor)}</td>
                          <td className="is-numeric collection-paid-amount">{formatTaka(tenant.paidAmountMinor)}</td>
                          <td className="is-numeric collection-remaining-amount">{formatTaka(tenant.outstandingMinor)}</td>
                          <td><span className={getStatusClass(tenant.status)}>{getStatusLabel(tenant.status)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}>Selected month total</td>
                        <td className="is-numeric">{formatTaka(summary.billedMinor)}</td>
                        <td className="is-numeric">{formatTaka(summary.collectedMinor)}</td>
                        <td className="is-numeric">{formatTaka(summary.outstandingMinor)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              <div className="collection-footer-note">
                <Clock3 size={14} aria-hidden="true" />
                A bill is marked paid only when that specific month’s rent invoice has no remaining balance.
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
