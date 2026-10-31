import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

export type MonthlyBillReportRow = {
  tenantName: string
  roomNumber: string
  propertyName: string
  amountMinor: number
}

export type MonthlyBillReportKind = 'rent' | 'electricity'

type MonthlyBillReportOptions = {
  kind: MonthlyBillReportKind
  houseName: string
  billingMonth: string
  rows: MonthlyBillReportRow[]
}

type PdfRgb = [number, number, number]

type BengaliCell = {
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
    halign: string
    lineWidth: unknown
  }
  padding: (side: 'left' | 'right' | 'top' | 'bottom') => number
}

const COLORS = {
  navy: [16, 44, 80] as PdfRgb,
  gold: [213, 165, 46] as PdfRgb,
  ivory: [246, 243, 235] as PdfRgb,
  ink: [38, 54, 74] as PdfRgb,
  muted: [100, 116, 139] as PdfRgb,
  border: [232, 225, 213] as PdfRgb,
  white: [255, 255, 255] as PdfRgb,
}

const BENGALI_PATTERN = /[\u0980-\u09FF]/
const BENGALI_FONT = 'Noto Serif Bengali'
const IMAGE_SCALE = 3

function formatMoney(amountMinor: number): string {
  return `BDT ${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`
}

function formatMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00`)
  if (Number.isNaN(date.getTime())) return month
  return new Intl.DateTimeFormat('en-BD', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function formatGeneratedAt(): string {
  return new Intl.DateTimeFormat('en-BD', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())
}

async function ensureBengaliFont(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    throw new Error('Bengali font rendering is not available in this browser.')
  }

  const [regularFaces, boldFaces] = await Promise.all([
    document.fonts.load(`400 12px "${BENGALI_FONT}"`, 'বাংলা পরীক্ষা'),
    document.fonts.load(`700 12px "${BENGALI_FONT}"`, 'বাংলা পরীক্ষা'),
  ])
  await document.fonts.ready

  if (regularFaces.length === 0 || boldFaces.length === 0) {
    throw new Error('The Bengali font could not be loaded. Check your internet connection and try the PDF download again.')
  }
}

function normalizeColor(value: unknown, fallback: PdfRgb): PdfRgb {
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

function renderBengaliText(
  text: string,
  fontSizePt: number,
  color: PdfRgb,
  bold: boolean,
  maxWidthPt: number,
  maxHeightPt: number,
): { dataUrl: string; widthPt: number; heightPt: number } {
  const pixelsPerPoint = (96 / 72) * IMAGE_SCALE
  let fontSizePx = fontSizePt * pixelsPerPoint

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare Bengali text for the PDF.')

    context.font = `${bold ? '700' : '400'} ${fontSizePx}px "${BENGALI_FONT}"`
    context.textBaseline = 'alphabetic'
    const paddingX = fontSizePx * 0.12
    const paddingY = fontSizePx * 0.12
    const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
    const maxWidthPx = maxWidthPt * pixelsPerPoint
    const lines: string[] = []
    let line = ''

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (line && context.measureText(candidate).width > maxWidthPx - paddingX * 2) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line) lines.push(line)

    const metrics = context.measureText(lines[0] || text)
    const ascent = metrics.actualBoundingBoxAscent || fontSizePx * 0.82
    const descent = metrics.actualBoundingBoxDescent || fontSizePx * 0.25
    const lineHeight = fontSizePx * 1.28
    const widthPx = Math.max(1, ...lines.map((item) => context.measureText(item).width)) + paddingX * 2
    const heightPx = paddingY * 2 + ascent + descent + Math.max(0, lines.length - 1) * lineHeight

    if (widthPx > maxWidthPx || heightPx > maxHeightPt * pixelsPerPoint) {
      fontSizePx *= 0.88
      continue
    }

    canvas.width = Math.ceil(widthPx)
    canvas.height = Math.ceil(heightPx)
    const draw = canvas.getContext('2d')
    if (!draw) throw new Error('Could not render Bengali text for the PDF.')
    draw.font = `${bold ? '700' : '400'} ${fontSizePx}px "${BENGALI_FONT}"`
    draw.textBaseline = 'alphabetic'
    draw.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`
    lines.forEach((item, index) => draw.fillText(item, paddingX, paddingY + ascent + index * lineHeight))

    return {
      dataUrl: canvas.toDataURL('image/png'),
      widthPt: canvas.width / pixelsPerPoint,
      heightPt: canvas.height / pixelsPerPoint,
    }
  }

  throw new Error('A Bengali tenant or property name is too long to fit in the PDF table.')
}

function getCellText(cell: BengaliCell): string {
  if (typeof cell.raw === 'string' || typeof cell.raw === 'number') return String(cell.raw)
  if (Array.isArray(cell.raw)) return cell.raw.map((value) => String(value ?? '')).join('\n')
  return cell.text.join('\n')
}

function drawBengaliCell(pdf: jsPDF, cell: BengaliCell): void {
  const text = getCellText(cell)
  if (!BENGALI_PATTERN.test(text)) return

  const paddingLeft = cell.padding('left')
  const paddingRight = cell.padding('right')
  const paddingTop = cell.padding('top')
  const paddingBottom = cell.padding('bottom')
  const availableWidth = Math.max(1, cell.width - paddingLeft - paddingRight)
  const availableHeight = Math.max(1, cell.height - paddingTop - paddingBottom)
  const borderInset = Math.max(0.45, Number(cell.styles.lineWidth) || 0.35)
  const fill = normalizeColor(cell.styles.fillColor, COLORS.white)
  const textColor = normalizeColor(cell.styles.textColor, COLORS.ink)

  // Cover jsPDF's unsupported Bengali glyphs, preserving the table's fill and borders.
  pdf.setFillColor(...fill)
  pdf.rect(
    cell.x + borderInset,
    cell.y + borderInset,
    Math.max(0, cell.width - borderInset * 2),
    Math.max(0, cell.height - borderInset * 2),
    'F',
  )

  const image = renderBengaliText(
    text,
    cell.styles.fontSize,
    textColor,
    cell.styles.fontStyle.includes('bold'),
    availableWidth,
    availableHeight,
  )
  const drawX = cell.styles.halign === 'right'
    ? cell.x + cell.width - paddingRight - image.widthPt
    : cell.styles.halign === 'center'
      ? cell.x + (cell.width - image.widthPt) / 2
      : cell.x + paddingLeft
  const drawY = cell.y + paddingTop + Math.max(0, (availableHeight - image.heightPt) / 2)
  pdf.addImage(image.dataUrl, 'PNG', drawX, drawY, image.widthPt, image.heightPt)
}

function drawPageFooter(pdf: jsPDF, pageWidth: number, pageHeight: number): void {
  const pageCount = pdf.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page)
    pdf.setDrawColor(...COLORS.border)
    pdf.setLineWidth(0.5)
    pdf.line(34, pageHeight - 34, pageWidth - 34, pageHeight - 34)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(7)
    pdf.setTextColor(...COLORS.muted)
    pdf.text('This report includes only issued bills for the selected month. Previous dues, advances and payments are excluded.', 34, pageHeight - 20, { maxWidth: pageWidth - 110 })
    pdf.text(`Page ${page} of ${pageCount}`, pageWidth - 34, pageHeight - 20, { align: 'right' })
  }
}

export async function downloadMonthlyBillReportPdf(options: MonthlyBillReportOptions): Promise<void> {
  if (options.rows.length === 0) throw new Error(`No issued ${options.kind} bills exist for ${formatMonth(options.billingMonth)}.`)

  const hasBengali = BENGALI_PATTERN.test(options.houseName) || options.rows.some((row) =>
    BENGALI_PATTERN.test(row.tenantName) || BENGALI_PATTERN.test(row.propertyName),
  )
  if (hasBengali) await ensureBengaliFont()

  const rows = [...options.rows].sort((left, right) =>
    left.tenantName.localeCompare(right.tenantName, 'bn') ||
    left.propertyName.localeCompare(right.propertyName) ||
    left.roomNumber.localeCompare(right.roomNumber, undefined, { numeric: true }),
  )

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 34
  const reportTitle = options.kind === 'rent' ? 'Monthly Rent Bill Report' : 'Monthly Electricity Bill Report'
  const amountHeading = options.kind === 'rent' ? 'Rent amount' : 'Electricity amount'

  pdf.setFillColor(...COLORS.navy)
  pdf.rect(0, 0, pageWidth, 82, 'F')
  pdf.setFillColor(...COLORS.gold)
  pdf.rect(0, 80, pageWidth, 2, 'F')
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(15)
  pdf.setTextColor(...COLORS.white)
  const houseName = options.houseName || "T&N House's"
  if (BENGALI_PATTERN.test(houseName)) {
    const houseNameImage = renderBengaliText(houseName, 15, COLORS.white, true, pageWidth - margin * 2, 20)
    pdf.addImage(houseNameImage.dataUrl, 'PNG', margin, 12, houseNameImage.widthPt, houseNameImage.heightPt)
  } else {
    pdf.text(houseName, margin, 30)
  }
  pdf.setFontSize(10)
  pdf.text(reportTitle, margin, 49)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(8)
  pdf.text(`Billing month: ${formatMonth(options.billingMonth)}`, margin, 65)

  pdf.setTextColor(...COLORS.ink)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(10)
  pdf.text(`${rows.length} issued ${options.kind === 'rent' ? 'rent' : 'electricity'} ${rows.length === 1 ? 'bill' : 'bills'}`, margin, 105)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(8)
  pdf.setTextColor(...COLORS.muted)
  pdf.text(`Generated: ${formatGeneratedAt()}`, pageWidth - margin, 105, { align: 'right' })

  const tableRows = rows.map((row, index) => [
    String(index + 1),
    row.tenantName || 'Unassigned',
    `Room ${row.roomNumber}`,
    row.propertyName,
    formatMoney(row.amountMinor),
  ])

  autoTable(pdf, {
    head: [['#', 'Tenant name', 'Room number', 'Property', amountHeading]],
    body: tableRows,
    startY: 119,
    margin: { top: 32, bottom: 48, left: margin, right: margin },
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: 7,
      overflow: 'linebreak',
      valign: 'middle',
      textColor: COLORS.ink,
      lineColor: COLORS.border,
      lineWidth: 0.4,
      minCellHeight: 34,
    },
    headStyles: {
      fillColor: COLORS.navy,
      textColor: COLORS.white,
      fontStyle: 'bold',
      minCellHeight: 29,
    },
    alternateRowStyles: { fillColor: COLORS.ivory },
    columnStyles: {
      0: { cellWidth: 25, halign: 'center' },
      1: { cellWidth: 165 },
      2: { cellWidth: 95 },
      3: { cellWidth: 115 },
      4: { cellWidth: 'auto', halign: 'right', fontStyle: 'bold' },
    },
    didDrawCell: (hookData) => {
      drawBengaliCell(pdf, hookData.cell as unknown as BengaliCell)
    },
    didDrawPage: () => {
      pdf.setDrawColor(...COLORS.gold)
      pdf.setLineWidth(0.7)
      pdf.line(margin, 86, pageWidth - margin, 86)
    },
  })

  drawPageFooter(pdf, pageWidth, pageHeight)
  pdf.save(`${options.kind}-bill-report-${options.billingMonth}.pdf`)
}
