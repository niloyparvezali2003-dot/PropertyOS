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
  type TenantCreditRecord,
  listPaymentBillBalances,
  listTenantCredits,
} from '../services/firebase/payments'
import {
  type ElectricityBillRecord,
  listElectricityBills,
  resolveElectricityBillTenantAssignment,
} from '../services/firebase/electricity'
import {
  type TenantAssignmentRecord,
  listTenantAssignments,
} from '../services/firebase/tenantAssignments'
import {
  type OpeningBalanceRecord,
  listOpeningBalances,
} from '../services/firebase/openingBalances'
import { loadWorkspaceSettings } from '../services/firebase/workspaceSettings'
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

type CollectionPdfTenantRow = {
  tenantId: string
  tenantName: string
  rooms: Set<string>
  previousBillsDueMinor: number
  openingBalanceMinor: number
  rentBillMinor: number
  paidAgainstBillMinor: number
  remainingMinor: number
  totalDueMinor: number
  availableAdvanceCreditMinor: number
  status: CollectionStatus
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

export function CurrentMonthCollectionPage({
  ownerUid,
  onNavigate,
}: CurrentMonthCollectionPageProps) {
  const [bills, setBills] = useState<RentBillRecord[]>([])
  const [balances, setBalances] = useState<PaymentBillBalanceRecord[]>([])
  const [electricityBills, setElectricityBills] = useState<ElectricityBillRecord[]>([])
  const [tenantAssignments, setTenantAssignments] = useState<TenantAssignmentRecord[]>([])
  const [openingBalances, setOpeningBalances] = useState<OpeningBalanceRecord[]>([])
  const [tenantCredits, setTenantCredits] = useState<TenantCreditRecord[]>([])
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

      const [nextBills, nextBalances, nextElectricityBills, nextAssignments, nextOpeningBalances, nextTenantCredits] = await Promise.all([
        listRentBills(ownerUid),
        listPaymentBillBalances(ownerUid),
        listElectricityBills(ownerUid),
        listTenantAssignments(ownerUid),
        listOpeningBalances(ownerUid),
        listTenantCredits(ownerUid),
      ])

      setBills(nextBills)
      setBalances(nextBalances)
      setElectricityBills(nextElectricityBills)
      setTenantAssignments(nextAssignments)
      setOpeningBalances(nextOpeningBalances)
      setTenantCredits(nextTenantCredits)
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

  const filteredRows = useMemo(() => {
    const search = searchValue.trim().toLocaleLowerCase()

    return rows.filter((row) => {
      if (statusFilter === 'outstanding' && row.outstandingMinor <= 0) return false
      if (statusFilter !== 'all' && statusFilter !== 'outstanding' && row.status !== statusFilter) return false
      if (!search) return true

      return [
        row.bill.tenantName,
        row.bill.tenantCode,
        row.bill.roomNumber,
        row.bill.roomCode,
        row.bill.floorName,
        row.bill.propertyCode,
      ].join(' ').toLocaleLowerCase().includes(search)
    })
  }, [rows, searchValue, statusFilter])

  const handleDownloadPdf = useCallback(async () => {
    if (rows.length === 0 || isDownloadingPdf) return

    setIsDownloadingPdf(true)
    setPdfError('')

    try {
      const { settings } = await loadWorkspaceSettings(ownerUid)
      const selectedMonthStart = `${billingMonth}-01`
      const balanceByKey = new Map(
        balances.map((balance) => [`${balance.billType}__${balance.billId}`, balance] as const),
      )
      const previousBillsDueByTenantId = new Map<string, number>()
      const openingBalanceByTenantId = new Map<string, number>()
      const advanceCreditByTenantId = new Map(
        tenantCredits.map((credit) => [credit.tenantId, credit.creditMinor] as const),
      )
      const addAmount = (target: Map<string, number>, tenantId: string, amountMinor: number) => {
        if (!tenantId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return
        target.set(tenantId, (target.get(tenantId) ?? 0) + amountMinor)
      }

      // Earlier rent and electricity invoices are shown as previous-bill dues.
      // They remain separate from the tenant's opening balance and current rent.
      for (const bill of bills) {
        if (bill.billingMonth >= billingMonth) continue
        const balance = balanceByKey.get(`rent__${bill.id}`)
        addAmount(previousBillsDueByTenantId, bill.tenantId, balance?.outstandingMinor ?? bill.totalMinor)
      }

      for (const bill of electricityBills) {
        if (bill.billingMonth >= billingMonth) continue
        const balance = balanceByKey.get(`electricity__${bill.id}`)
        const assignment = resolveElectricityBillTenantAssignment(bill, tenantAssignments)
        const tenantId = balance?.tenantId ?? assignment?.tenantId
        if (tenantId) addAmount(previousBillsDueByTenantId, tenantId, balance?.outstandingMinor ?? bill.amountMinor)
      }

      // Opening balance is its own component of the tenant's total due.
      // It does not change the selected month's rent payment status.
      for (const openingBalance of openingBalances) {
        if (openingBalance.effectiveDate <= selectedMonthStart) {
          addAmount(openingBalanceByTenantId, openingBalance.tenantId, openingBalance.outstandingMinor)
        }
      }

      // Group current-month invoices by tenant. This avoids duplicating a
      // tenant's previous due when that tenant occupies more than one room.
      const tenantRowsById = new Map<string, CollectionPdfTenantRow>()
      for (const row of rows) {
        const tenantId = row.bill.tenantId
        const existing = tenantRowsById.get(tenantId)
        const roomLabel = row.bill.roomNumber.trim() || row.bill.roomCode.trim()
        if (existing) {
          existing.rooms.add(roomLabel)
          existing.rentBillMinor += row.bill.totalMinor
          existing.paidAgainstBillMinor += row.paidAmountMinor
          existing.remainingMinor += row.outstandingMinor
        } else {
          tenantRowsById.set(tenantId, {
            tenantId,
            tenantName: row.bill.tenantName,
            rooms: new Set([roomLabel]),
            previousBillsDueMinor: previousBillsDueByTenantId.get(tenantId) ?? 0,
            openingBalanceMinor: openingBalanceByTenantId.get(tenantId) ?? 0,
            rentBillMinor: row.bill.totalMinor,
            paidAgainstBillMinor: row.paidAmountMinor,
            remainingMinor: row.outstandingMinor,
            totalDueMinor: 0,
            availableAdvanceCreditMinor: advanceCreditByTenantId.get(tenantId) ?? 0,
            status: row.status,
          })
        }
      }

      const tenantRows = [...tenantRowsById.values()]
      for (const tenantRow of tenantRows) {
        // Total Due is the amount still owed to the property: earlier unpaid
        // bills + opening balance + this month's remaining rent. Advance credit
        // is shown separately and is not subtracted from this figure.
        tenantRow.totalDueMinor = tenantRow.previousBillsDueMinor +
          tenantRow.openingBalanceMinor + tenantRow.remainingMinor
        tenantRow.status = tenantRow.remainingMinor <= 0
          ? 'paid'
          : tenantRow.paidAgainstBillMinor > 0
            ? 'partial'
            : 'unpaid'
      }
      tenantRows.sort((left, right) => {
        const leftRooms = sortCollectionRoomNumbers(left.rooms)
        const rightRooms = sortCollectionRoomNumbers(right.rooms)
        const roomOrder = compareCollectionRoomNumbers(leftRooms[0] ?? '', rightRooms[0] ?? '')
        if (roomOrder !== 0) return roomOrder

        // Keep ties deterministic if two tenants happen to use the same room label.
        return left.tenantName.localeCompare(right.tenantName, 'en', {
          sensitivity: 'base',
          numeric: true,
        })
      })

      const pdfTotals = tenantRows.reduce((total, row) => ({
        previousBillsDueMinor: total.previousBillsDueMinor + row.previousBillsDueMinor,
        openingBalanceMinor: total.openingBalanceMinor + row.openingBalanceMinor,
        rentBillMinor: total.rentBillMinor + row.rentBillMinor,
        paidAgainstBillMinor: total.paidAgainstBillMinor + row.paidAgainstBillMinor,
        remainingMinor: total.remainingMinor + row.remainingMinor,
        totalDueMinor: total.totalDueMinor + row.totalDueMinor,
        availableAdvanceCreditMinor: total.availableAdvanceCreditMinor + row.availableAdvanceCreditMinor,
        paidCount: total.paidCount + (row.status === 'paid' ? 1 : 0),
        partialCount: total.partialCount + (row.status === 'partial' ? 1 : 0),
        unpaidCount: total.unpaidCount + (row.status === 'unpaid' ? 1 : 0),
      }), {
        previousBillsDueMinor: 0,
        openingBalanceMinor: 0,
        rentBillMinor: 0,
        paidAgainstBillMinor: 0,
        remainingMinor: 0,
        totalDueMinor: 0,
        availableAdvanceCreditMinor: 0,
        paidCount: 0,
        partialCount: 0,
        unpaidCount: 0,
      })

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
      pdf.text('MONTHLY RENT COLLECTION REPORT', margin, 48)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(7)
      pdf.setTextColor(225, 232, 240)
      pdf.text(`Generated: ${formatCollectionPdfGeneratedAt()}`, pageWidth - margin, 27, { align: 'right' })
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(8)
      pdf.setTextColor(225, 232, 240)
      pdf.text(`Billing month: ${formatBillingMonth(billingMonth)}`, margin, 62)

      const cardY = 84
      const cardHeight = 43
      const cardGap = 10
      const summaryCards = [
        { label: 'PREVIOUS BILLS DUE', value: formatCollectionPdfMoney(pdfTotals.previousBillsDueMinor), valueColor: colors.due },
        { label: 'OPENING BALANCE', value: formatCollectionPdfMoney(pdfTotals.openingBalanceMinor), valueColor: colors.due },
        { label: 'RENT BILL', value: formatCollectionPdfMoney(pdfTotals.rentBillMinor), valueColor: colors.black },
        { label: 'PAID AGAINST BILL', value: formatCollectionPdfMoney(pdfTotals.paidAgainstBillMinor), valueColor: colors.black },
        { label: 'TOTAL DUE', value: formatCollectionPdfMoney(pdfTotals.totalDueMinor), valueColor: colors.due },
        { label: 'AVAILABLE ADVANCE CREDIT', value: formatCollectionPdfMoney(pdfTotals.availableAdvanceCreditMinor), valueColor: colors.advance },
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
        pdf.setFontSize(10)
        pdf.setTextColor(...card.valueColor)
        pdf.text(card.value, x + 10, cardY + 31, { maxWidth: cardWidth - 18 })
      })

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(8)
      pdf.setTextColor(...colors.ink)
      pdf.text(
        `${tenantRows.length} tenant${tenantRows.length === 1 ? '' : 's'} · ${pdfTotals.paidCount} paid · ${pdfTotals.partialCount} partially paid · ${pdfTotals.unpaidCount} unpaid`,
        margin,
        144,
      )
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(7)
      pdf.setTextColor(...colors.muted)
      pdf.text('Status reflects only payments or advance credit allocated to this month’s rent invoices.', pageWidth - margin, 144, { align: 'right' })

      const body = tenantRows.map((row) => [
        wrapCollectionPdfText(row.tenantName, 112, 7.2),
        sortCollectionRoomNumbers(row.rooms).join('\n'),
        formatCollectionPdfMoney(row.previousBillsDueMinor),
        formatCollectionPdfMoney(row.openingBalanceMinor),
        formatCollectionPdfMoney(row.rentBillMinor),
        formatCollectionPdfMoney(row.paidAgainstBillMinor),
        formatCollectionPdfMoney(row.remainingMinor),
        formatCollectionPdfMoney(row.totalDueMinor),
        formatCollectionPdfMoney(row.availableAdvanceCreditMinor),
        getStatusLabel(row.status),
      ])

      autoTable(pdf, {
        head: [[
          'Tenant',
          'Room(s)',
          'Previous Bills Due',
          'Opening Balance',
          'Rent Bill',
          'Paid Against Bill',
          'Remaining',
          'Total Due',
          'Available Advance Credit',
          'Status',
        ]],
        body,
        foot: [[
          'TOTAL',
          '',
          formatCollectionPdfMoney(pdfTotals.previousBillsDueMinor),
          formatCollectionPdfMoney(pdfTotals.openingBalanceMinor),
          formatCollectionPdfMoney(pdfTotals.rentBillMinor),
          formatCollectionPdfMoney(pdfTotals.paidAgainstBillMinor),
          formatCollectionPdfMoney(pdfTotals.remainingMinor),
          formatCollectionPdfMoney(pdfTotals.totalDueMinor),
          formatCollectionPdfMoney(pdfTotals.availableAdvanceCreditMinor),
          '',
        ]],
        startY: 154,
        margin: { top: 64, bottom: 36, left: margin, right: margin },
        showHead: 'everyPage',
        showFoot: 'lastPage',
        styles: {
          font: 'helvetica',
          fontSize: 7.2,
          cellPadding: 4.2,
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
          fontSize: 7,
        },
        footStyles: {
          fillColor: colors.ivory,
          textColor: colors.navy,
          fontStyle: 'bold',
          lineWidth: 0.5,
        },
        alternateRowStyles: { fillColor: [250, 249, 246] },
        columnStyles: {
          0: { cellWidth: 120 },
          1: { cellWidth: 55 },
          2: { cellWidth: 74, halign: 'right' },
          3: { cellWidth: 70, halign: 'right' },
          4: { cellWidth: 66, halign: 'right' },
          5: { cellWidth: 80, halign: 'right' },
          6: { cellWidth: 64, halign: 'right' },
          7: { cellWidth: 76, halign: 'right' },
          8: { cellWidth: 107, halign: 'right' },
          9: { cellWidth: 70, halign: 'center' },
        },
        didParseCell: (hookData) => {
          if (hookData.section === 'body' || hookData.section === 'foot') {
            const amountColumn = hookData.column.index
            if ([2, 3, 6, 7].includes(amountColumn)) {
              // Previous bills due, opening balance, remaining rent and total due.
              hookData.cell.styles.textColor = colors.due
            } else if (amountColumn === 8) {
              // Available advance credit is a positive credit for the tenant.
              hookData.cell.styles.textColor = colors.advance
            } else if ([4, 5].includes(amountColumn)) {
              // Rent billed and payment collected are shown in neutral black.
              hookData.cell.styles.textColor = colors.black
            }
          }

          if (hookData.section !== 'body' || hookData.column.index !== 9) return
          const status = String(hookData.cell.raw ?? '')
          if (status === 'Paid') {
            hookData.cell.styles.textColor = [22, 101, 52]
            hookData.cell.styles.fillColor = [236, 253, 245]
            hookData.cell.styles.fontStyle = 'bold'
          } else if (status === 'Partially paid') {
            hookData.cell.styles.textColor = [180, 83, 9]
            hookData.cell.styles.fillColor = [255, 247, 237]
            hookData.cell.styles.fontStyle = 'bold'
          } else if (status === 'Unpaid') {
            hookData.cell.styles.textColor = [185, 28, 28]
            hookData.cell.styles.fillColor = [254, 242, 242]
            hookData.cell.styles.fontStyle = 'bold'
          }
        },
        didDrawCell: (hookData) => {
          drawCollectionPdfBengaliCell(pdf, hookData.cell as unknown as CollectionPdfCell)
        },
        didDrawPage: (hookData) => {
          if (hookData.pageNumber > 1) {
            pdf.setFillColor(...colors.navy)
            pdf.rect(0, 0, pageWidth, 48, 'F')
            drawCollectionPdfText(pdf, houseName, margin, 22, 12, colors.white, pageWidth - margin * 2, true)
            pdf.setFont('helvetica', 'normal')
            pdf.setFontSize(8)
            pdf.setTextColor(225, 232, 240)
            pdf.text(`Monthly rent collection · ${formatBillingMonth(billingMonth)}`, margin, 37)
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
          'Total Due includes previous unpaid rent/electricity bills, the opening balance, and the current-month rent remaining. Available Advance Credit is shown separately and is not deducted automatically. Current-month status changes only when payment or credit is allocated to this month’s rent bills.',
          margin,
          pageHeight - 16,
          { maxWidth: pageWidth - margin * 2 - 65 },
        )
        pdf.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 16, { align: 'right' })
      }

      pdf.save(`rent-collection-${billingMonth}.pdf`)
    } catch (error: unknown) {
      setPdfError(error instanceof Error ? error.message : 'Could not generate the rent collection PDF.')
    } finally {
      setIsDownloadingPdf(false)
    }
  }, [
    balances,
    billingMonth,
    bills,
    electricityBills,
    isDownloadingPdf,
    openingBalances,
    ownerUid,
    rows,
    tenantAssignments,
    tenantCredits,
  ])

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
            disabled={isLoading || isDownloadingPdf || rows.length === 0}
            title={rows.length === 0 ? 'Generate rent bills before downloading a report' : 'Download the selected month rent collection report'}
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
                  <p>{summary.paidCount} paid · {summary.partialCount} partially paid · {summary.unpaidCount} unpaid</p>
                </div>
                <span className="collection-bill-count">{rows.length} bills</span>
              </div>

              <div className="collection-toolbar">
                <div className="collection-status-filters" aria-label="Filter rent bills by payment status">
                  <button
                    className={statusFilter === 'all' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('all')}
                    aria-pressed={statusFilter === 'all'}
                  >
                    All <span>{rows.length}</span>
                  </button>
                  <button
                    className={statusFilter === 'outstanding' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('outstanding')}
                    aria-pressed={statusFilter === 'outstanding'}
                  >
                    Outstanding <span>{summary.unpaidCount + summary.partialCount}</span>
                  </button>
                  <button
                    className={statusFilter === 'unpaid' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('unpaid')}
                    aria-pressed={statusFilter === 'unpaid'}
                  >
                    Unpaid <span>{summary.unpaidCount}</span>
                  </button>
                  <button
                    className={statusFilter === 'partial' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('partial')}
                    aria-pressed={statusFilter === 'partial'}
                  >
                    Partial <span>{summary.partialCount}</span>
                  </button>
                  <button
                    className={statusFilter === 'paid' ? 'is-active' : ''}
                    type="button"
                    onClick={() => setStatusFilter('paid')}
                    aria-pressed={statusFilter === 'paid'}
                  >
                    Paid <span>{summary.paidCount}</span>
                  </button>
                </div>
                <SearchInput
                  value={searchValue}
                  onChange={setSearchValue}
                  placeholder="Search tenant, room or property…"
                />
              </div>

              {filteredRows.length === 0 ? (
                <div className="collection-filter-empty">
                  No rent bills match this filter. Try another status or search term.
                </div>
              ) : (
                <div className="collection-table-wrap">
                  <table className="collection-table">
                    <thead>
                      <tr>
                        <th>Tenant</th>
                        <th>Room</th>
                        <th className="is-numeric">Rent bill</th>
                        <th className="is-numeric">Paid against bill</th>
                        <th className="is-numeric">Remaining</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map(({ bill, paidAmountMinor, outstandingMinor, status }) => (
                        <tr key={bill.id}>
                          <td>
                            <div className="collection-tenant-cell">
                              <strong>{bill.tenantName}</strong>
                              <span>{bill.tenantCode} · {bill.propertyCode}</span>
                            </div>
                          </td>
                          <td>
                            <div className="collection-room-cell">
                              <strong>{bill.roomNumber}</strong>
                              <span>{bill.floorName}</span>
                            </div>
                          </td>
                          <td className="is-numeric">{formatTaka(bill.totalMinor)}</td>
                          <td className="is-numeric collection-paid-amount">{formatTaka(paidAmountMinor)}</td>
                          <td className="is-numeric collection-remaining-amount">{formatTaka(outstandingMinor)}</td>
                          <td><span className={getStatusClass(status)}>{getStatusLabel(status)}</span></td>
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
