import { useCallback, useEffect, useMemo, useState } from 'react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

import {
  Activity,
  Mail,
  Bolt,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  DoorOpen,
  Download,
  Gauge,
  History,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react'

import { SearchInput } from '../components/ui/SearchInput'
import {
  getAuditErrorMessage,
  listAuditEvents,
  type AuditEntityType,
  type AuditEventRecord,
} from '../services/firebase/audit'
import { listWorkspaceMembers, type WorkspaceMemberRecord } from '../services/firebase/workspace'
import './history.css'

type HistoryPageProps = {
  ownerUid: string
}

const entityOptions: { value: 'all' | AuditEntityType; label: string }[] = [
  { value: 'all', label: 'All record types' },
  { value: 'property', label: 'Properties' },
  { value: 'room', label: 'Rooms' },
  { value: 'tenant', label: 'Tenants' },
  { value: 'tenant_assignment', label: 'Tenant assignments' },
  { value: 'meter', label: 'Meters' },
  { value: 'meter_assignment', label: 'Meter assignments' },
  { value: 'rent_rate', label: 'Rent rates' },
  { value: 'rent_bills', label: 'Rent bills' },
  { value: 'electricity_rate', label: 'Electricity rates' },
  { value: 'electricity_bill', label: 'Electricity bills' },
  { value: 'payment', label: 'Payments' },
  { value: 'credit_application', label: 'Advance applications' },
  { value: 'opening_balance', label: 'Opening balances' },
  { value: 'member', label: 'Workspace members' },
  { value: 'invitation', label: 'Invitations' },
]

const actionLabels: Record<AuditEventRecord['action'], string> = {
  created: 'Created',
  updated: 'Updated',
  assigned: 'Assigned',
  moved_out: 'Move-out recorded',
  replaced: 'Replaced',
  rate_added: 'Rate added',
  rate_deleted: 'Rate deleted',
  bills_generated: 'Bills generated',
  bill_issued: 'Bill issued',
  payment_recorded: 'Payment recorded',
  credit_applied: 'Advance applied',
  opening_balance_added: 'Opening balance added',
  opening_balance_adjusted: 'Opening balance adjusted',
  invitation_created: 'Invitation created',
  invitation_accepted: 'Invitation accepted',
  invitation_cancelled: 'Invitation cancelled',
  member_revoked: 'Member access removed',
}

function eventIcon(entityType: AuditEntityType): LucideIcon {
  switch (entityType) {
    case 'property': return Building2
    case 'room': return DoorOpen
    case 'tenant':
    case 'tenant_assignment': return Users
    case 'meter':
    case 'meter_assignment': return Gauge
    case 'rent_rate':
    case 'rent_bills': return ClipboardList
    case 'electricity_rate':
    case 'electricity_bill': return Bolt
    case 'payment':
    case 'credit_application': return Wallet
    case 'opening_balance': return Wallet
    case 'member': return Users
    case 'invitation': return Mail
    default: return Activity
  }
}

function formatDate(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return 'Time unavailable'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(value)
}

function getDhakaDate(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function entityLabel(value: AuditEntityType): string {
  return entityOptions.find((option) => option.value === value)?.label ?? 'Record'
}

const HISTORY_BENGALI_PATTERN = /[\u0980-\u09FF]/
const HISTORY_BENGALI_FONT = 'Noto Serif Bengali'
const HISTORY_PDF_IMAGE_SCALE = 3
type HistoryPdfColor = [number, number, number]

type HistoryPdfCell = {
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

async function ensureHistoryPdfBengaliFont(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    throw new Error('Bengali PDF text rendering is unavailable in this browser.')
  }
  const sample = 'বাংলা পরীক্ষা যুক্তাক্ষর'
  const [regularFaces, boldFaces] = await Promise.all([
    document.fonts.load(`400 12px "${HISTORY_BENGALI_FONT}"`, sample),
    document.fonts.load(`700 12px "${HISTORY_BENGALI_FONT}"`, sample),
  ])
  await document.fonts.ready
  if (regularFaces.length === 0 || boldFaces.length === 0) {
    throw new Error('The Bengali font could not be loaded. Check your internet connection and try again.')
  }
}

function historyPdfColor(value: unknown, fallback: HistoryPdfColor): HistoryPdfColor {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0]
  }
  if (typeof value === 'number') return [value, value, value]
  return fallback
}

function historyPdfCellText(cell: HistoryPdfCell): string {
  if (typeof cell.raw === 'string' || typeof cell.raw === 'number') return String(cell.raw)
  if (Array.isArray(cell.raw)) return cell.raw.map((value) => String(value ?? '')).join('\n')
  return (cell.text ?? []).join('\n')
}

function drawHistoryPdfBengaliCell(pdf: jsPDF, cell: HistoryPdfCell): void {
  const text = historyPdfCellText(cell)
  if (!HISTORY_BENGALI_PATTERN.test(text)) return

  const paddingLeft = cell.padding('left')
  const paddingRight = cell.padding('right')
  const paddingTop = cell.padding('top')
  const paddingBottom = cell.padding('bottom')
  const availableWidth = Math.max(1, cell.width - paddingLeft - paddingRight)
  const availableHeight = Math.max(1, cell.height - paddingTop - paddingBottom)
  const pixelsPerPoint = (96 / 72) * HISTORY_PDF_IMAGE_SCALE
  let fontSizePx = Math.max(3, (cell.styles.fontSize ?? 7.2) * pixelsPerPoint)
  const bold = (cell.styles.fontStyle ?? '').includes('bold')
  let rendered: { canvas: HTMLCanvasElement; widthPx: number; heightPx: number; fontSizePx: number; lines: string[]; paddingX: number; paddingY: number; ascent: number; lineHeight: number } | null = null

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const measureCanvas = document.createElement('canvas')
    const context = measureCanvas.getContext('2d')
    if (!context) return
    context.font = `${bold ? '700' : '400'} ${fontSizePx}px "${HISTORY_BENGALI_FONT}", "Nirmala UI", serif`
    context.textBaseline = 'alphabetic'
    const paddingX = fontSizePx * 0.12
    const paddingY = fontSizePx * 0.1
    const maxLineWidth = Math.max(1, availableWidth * pixelsPerPoint - paddingX * 2)
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
        if (line && context.measureText(candidate).width > maxLineWidth) {
          lines.push(line)
          line = word
        } else {
          line = candidate
        }
      }
      if (line) lines.push(line)
    }

    const metric = context.measureText(lines.find(Boolean) || text || 'বাংলা')
    const ascent = metric.actualBoundingBoxAscent || fontSizePx * 0.84
    const descent = metric.actualBoundingBoxDescent || fontSizePx * 0.25
    const lineHeight = fontSizePx * 1.25
    const contentWidth = Math.max(1, ...lines.map((line) => context.measureText(line).width))
    const widthPx = contentWidth + paddingX * 2
    const heightPx = paddingY * 2 + ascent + descent + Math.max(0, lines.length - 1) * lineHeight
    rendered = { canvas: measureCanvas, widthPx, heightPx, fontSizePx, lines, paddingX, paddingY, ascent, lineHeight }

    if (widthPx <= availableWidth * pixelsPerPoint && heightPx <= availableHeight * pixelsPerPoint) break
    const shrink = Math.min(
      0.9,
      (availableWidth * pixelsPerPoint) / Math.max(1, widthPx),
      (availableHeight * pixelsPerPoint) / Math.max(1, heightPx),
    )
    if (fontSizePx * shrink < 2.5) break
    fontSizePx *= shrink
  }

  if (!rendered) return
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(rendered.widthPx))
  canvas.height = Math.max(1, Math.ceil(rendered.heightPx))
  const draw = canvas.getContext('2d')
  if (!draw) return
  draw.font = `${bold ? '700' : '400'} ${rendered.fontSizePx}px "${HISTORY_BENGALI_FONT}", "Nirmala UI", serif`
  draw.textBaseline = 'alphabetic'
  const textColor = historyPdfColor(cell.styles.textColor, [38, 54, 74])
  draw.fillStyle = `rgb(${textColor[0]}, ${textColor[1]}, ${textColor[2]})`
  rendered.lines.forEach((line, index) => {
    if (line) draw.fillText(line, rendered!.paddingX, rendered!.paddingY + rendered!.ascent + index * rendered!.lineHeight)
  })

  const fill = historyPdfColor(cell.styles.fillColor, [255, 255, 255])
  const inset = Math.max(0.45, Number(cell.styles.lineWidth) || 0.35)
  pdf.setFillColor(...fill)
  pdf.rect(cell.x + inset, cell.y + inset, Math.max(0, cell.width - inset * 2), Math.max(0, cell.height - inset * 2), 'F')
  const widthPt = canvas.width / pixelsPerPoint
  const heightPt = canvas.height / pixelsPerPoint
  const fit = Math.min(1, availableWidth / widthPt, availableHeight / heightPt)
  const drawWidth = widthPt * fit
  const drawHeight = heightPt * fit
  const align = cell.styles.halign ?? 'left'
  const x = align === 'right'
    ? cell.x + cell.width - paddingRight - drawWidth
    : align === 'center'
      ? cell.x + (cell.width - drawWidth) / 2
      : cell.x + paddingLeft
  const y = cell.y + paddingTop + Math.max(0, (availableHeight - drawHeight) / 2)
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, drawWidth, drawHeight)
}

function formatHistoryPdfGeneratedAt(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date())
}

export function HistoryPage({ ownerUid }: HistoryPageProps) {
  const [events, setEvents] = useState<AuditEventRecord[]>([])
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([])
  const [search, setSearch] = useState('')
  const [entityFilter, setEntityFilter] = useState<'all' | AuditEntityType>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false)
  const [pageError, setPageError] = useState('')
  const [pdfError, setPdfError] = useState('')

  const loadEvents = useCallback(async () => {
    setIsLoading(true)
    setPageError('')
    try {
      const [eventsResult, membersResult] = await Promise.allSettled([
        listAuditEvents(ownerUid),
        listWorkspaceMembers(ownerUid),
      ])
      if (eventsResult.status === 'rejected') throw eventsResult.reason
      setEvents(eventsResult.value)
      if (membersResult.status === 'fulfilled') {
        setMembers(membersResult.value)
      } else {
        // Keep the activity timeline available if member names cannot be loaded.
        // Actor UIDs remain visible as a fallback.
        setMembers([])
      }
    } catch (error: unknown) {
      setPageError(getAuditErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.uid, member.displayName || member.email])),
    [members],
  )

  const filteredEvents = useMemo(() => {
    const term = search.trim().toLowerCase()
    return events.filter((event) => {
      if (entityFilter !== 'all' && event.entityType !== entityFilter) return false
      const date = getDhakaDate(event.occurredAt?.toDate() ?? null)
      if (fromDate && (!date || date < fromDate)) return false
      if (toDate && (!date || date > toDate)) return false
      if (!term) return true
      return [
        event.entityLabel,
        event.entityId,
        event.summary,
        actionLabels[event.action],
        entityLabel(event.entityType),
        memberNames.get(event.actorUid) ?? event.actorUid,
        event.actorUid,
      ].join(' ').toLowerCase().includes(term)
    })
  }, [entityFilter, events, fromDate, memberNames, search, toDate])

  const handleDownloadPdf = useCallback(async () => {
    if (isDownloadingPdf) return
    setIsDownloadingPdf(true)
    setPdfError('')

    try {
      const hasBengali = filteredEvents.some((event) => HISTORY_BENGALI_PATTERN.test([
        event.entityLabel,
        event.summary,
        memberNames.get(event.actorUid) ?? event.actorUid,
      ].join(' ')))
      if (hasBengali) await ensureHistoryPdfBengaliFont()

      const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 28
      const recordTypeText = entityFilter === 'all' ? 'All record types' : entityLabel(entityFilter)
      const dateRangeText = `${fromDate || 'Earliest'} to ${toDate || 'Latest'}`
      const searchText = search.trim() ? 'Search filter: Applied' : ''

      pdf.setProperties({
        title: 'PropertyOS History & Audit Trail',
        subject: `Record type: ${recordTypeText}; Date range: ${dateRangeText}`,
        creator: 'PropertyOS',
      })

      const drawHeader = () => {
        pdf.setFillColor(16, 44, 80)
        pdf.rect(0, 0, pageWidth, 68, 'F')
        pdf.setFillColor(213, 165, 46)
        pdf.rect(0, 66, pageWidth, 2, 'F')
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(14)
        pdf.setTextColor(255, 255, 255)
        pdf.text('HISTORY & AUDIT TRAIL', margin, 28)
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(8)
        pdf.setTextColor(229, 235, 243)
        pdf.text(`Record type: ${recordTypeText}`, margin, 45)
        pdf.text(`Date range: ${dateRangeText}`, margin, 58)
        pdf.text(`Generated: ${formatHistoryPdfGeneratedAt()}`, pageWidth - margin, 28, { align: 'right' })
        if (searchText) pdf.text(searchText, pageWidth - margin, 45, { align: 'right' })
      }

      drawHeader()

      if (filteredEvents.length === 0) {
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(10)
        pdf.setTextColor(100, 116, 139)
        pdf.text('No history records match the selected filters.', margin, 100)
      } else {
        autoTable(pdf, {
          head: [[ 'Date & Time', 'Record Type', 'Action', 'Record', 'Reference', 'Details', 'Performed By' ]],
          body: filteredEvents.map((event) => [
            formatDate(event.occurredAt?.toDate() ?? null),
            entityLabel(event.entityType),
            actionLabels[event.action],
            event.entityLabel,
            event.entityId,
            event.summary,
            memberNames.get(event.actorUid) ?? `Account ${event.actorUid.slice(0, 8)}`,
          ]),
          startY: 80,
          margin: { top: 80, bottom: 34, left: margin, right: margin },
          styles: {
            font: 'helvetica',
            fontSize: 7.2,
            cellPadding: 4,
            overflow: 'linebreak',
            valign: 'middle',
            textColor: [38, 54, 74],
            lineColor: [225, 231, 239],
            lineWidth: 0.35,
          },
          headStyles: {
            fillColor: [16, 44, 80],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
          },
          alternateRowStyles: { fillColor: [246, 243, 235] },
          columnStyles: {
            0: { cellWidth: 82 },
            1: { cellWidth: 76 },
            2: { cellWidth: 68 },
            3: { cellWidth: 105 },
            4: { cellWidth: 75 },
            5: { cellWidth: 272 },
            6: { cellWidth: 108 },
          },
          didParseCell: (hookData) => {
            const cellText = Array.isArray(hookData.cell.raw)
              ? hookData.cell.raw.map((value) => String(value ?? '')).join(' ')
              : String(hookData.cell.raw ?? '')
            if (HISTORY_BENGALI_PATTERN.test(cellText)) {
              hookData.cell.styles.minCellHeight = Math.max(hookData.cell.styles.minCellHeight ?? 0, 24)
            }
          },
          didDrawCell: (hookData) => {
            drawHistoryPdfBengaliCell(pdf, hookData.cell)
          },
          didDrawPage: () => drawHeader(),
        })
      }

      const pageCount = pdf.getNumberOfPages()
      for (let page = 1; page <= pageCount; page += 1) {
        pdf.setPage(page)
        pdf.setDrawColor(232, 225, 213)
        pdf.setLineWidth(0.45)
        pdf.line(margin, pageHeight - 24, pageWidth - margin, pageHeight - 24)
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(7)
        pdf.setTextColor(100, 116, 139)
        pdf.text(`PropertyOS · ${filteredEvents.length} record(s) · Page ${page} of ${pageCount}`, margin, pageHeight - 12)
      }

      const safePart = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
      pdf.save(`propertyos-history-${safePart(entityFilter)}-${fromDate || 'start'}-to-${toDate || 'latest'}.pdf`)
    } catch (error: unknown) {
      setPdfError(error instanceof Error ? error.message : 'Unable to generate the History & Audit PDF. Please try again.')
    } finally {
      setIsDownloadingPdf(false)
    }
  }, [entityFilter, filteredEvents, fromDate, isDownloadingPdf, memberNames, search, toDate])

  const lastSevenDays = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    return events.filter((event) => (event.occurredAt?.toMillis() ?? 0) >= cutoff).length
  }, [events])

  const uniqueRecordTypes = useMemo(
    () => new Set(events.map((event) => event.entityType)).size,
    [events],
  )

  function clearFilters() {
    setSearch('')
    setEntityFilter('all')
    setFromDate('')
    setToDate('')
  }

  const hasFilters = Boolean(search || entityFilter !== 'all' || fromDate || toDate)

  return (
    <div className="history-page">
      <header className="page-heading history-heading">
        <div>
          <p className="eyebrow">Management</p>
          <h1>History &amp; Audit Trail</h1>
          <p className="page-description">
            Search an append-only timeline of changes recorded by this version of PropertyOS.
          </p>
        </div>
        <div className="history-heading-actions">
          <button
            className="button button-primary"
            type="button"
            onClick={() => void handleDownloadPdf()}
            disabled={isLoading || isDownloadingPdf}
            title="Download the history records matching the selected record type and date range"
          >
            {isDownloadingPdf ? <LoaderCircle size={17} className="animate-spin" /> : <Download size={17} />}
            {isDownloadingPdf ? 'Preparing PDF…' : 'Download PDF'}
          </button>
          <button className="button button-secondary" type="button" onClick={() => void loadEvents()} disabled={isLoading || isDownloadingPdf}>
            {isLoading ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}
            Refresh
          </button>
        </div>
      </header>

      {pdfError && (
        <div className="history-error" role="alert">
          <div><strong>PDF could not be generated</strong><span>{pdfError}</span></div>
          <button type="button" className="button button-secondary" onClick={() => setPdfError('')}>Dismiss</button>
        </div>
      )}

      <section className="history-stat-grid" aria-label="History summary">
        <article className="history-stat-card">
          <span className="history-stat-icon history-stat-icon--blue"><History size={19} /></span>
          <div><span>Loaded events</span><strong>{events.length.toLocaleString('en-BD')}</strong></div>
        </article>
        <article className="history-stat-card">
          <span className="history-stat-icon history-stat-icon--green"><Activity size={19} /></span>
          <div><span>Last 7 days</span><strong>{lastSevenDays.toLocaleString('en-BD')}</strong></div>
        </article>
        <article className="history-stat-card">
          <span className="history-stat-icon history-stat-icon--amber"><SlidersHorizontal size={19} /></span>
          <div><span>Record types used</span><strong>{uniqueRecordTypes}</strong></div>
        </article>
      </section>

      <section className="history-filter-panel" aria-label="Filter history">
        <div className="history-filter-search">
          <SearchInput value={search} onChange={setSearch} placeholder="Search names, references, or activity..." />
        </div>
        <label className="history-filter-field">
          <span>Record type</span>
          <select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as 'all' | AuditEntityType)}>
            {entityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="history-filter-field">
          <span>From date</span>
          <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="history-filter-field">
          <span>To date</span>
          <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} />
        </label>
        {hasFilters && (
          <button className="history-clear-button" type="button" onClick={clearFilters}>
            <X size={15} /> Clear
          </button>
        )}
      </section>

      {pageError && (
        <div className="history-error" role="alert">
          <div><strong>History could not be loaded</strong><span>{pageError}</span></div>
          <button type="button" className="button button-secondary" onClick={() => void loadEvents()}>Try again</button>
        </div>
      )}

      <section className="history-list-panel" aria-labelledby="history-list-heading">
        <div className="history-list-heading">
          <div><h2 id="history-list-heading">Activity log</h2><p>Newest activity appears first. Showing up to 500 recent events.</p></div>
          <span className="history-result-count">{filteredEvents.length} {filteredEvents.length === 1 ? 'event' : 'events'}</span>
        </div>

        {isLoading ? (
          <div className="history-empty-state"><LoaderCircle size={21} className="animate-spin" /><span>Loading activity history…</span></div>
        ) : filteredEvents.length === 0 ? (
          <div className="history-empty-state">
            <span className="history-empty-icon"><CalendarClock size={23} /></span>
            <strong>{events.length === 0 && !hasFilters ? 'No recorded activity yet' : 'No matching activity'}</strong>
            <p>{events.length === 0 && !hasFilters
              ? 'New changes recorded by this version will appear here. Existing actions from before audit logging was installed cannot be reconstructed automatically.'
              : 'Try a different search or clear the filters to see more events.'}</p>
            {hasFilters && <button type="button" className="button button-secondary" onClick={clearFilters}>Clear filters</button>}
          </div>
        ) : (
          <div className="history-event-list">
            {filteredEvents.map((event) => {
              const Icon = eventIcon(event.entityType)
              return (
                <article className="history-event-row" key={event.id}>
                  <span className={`history-event-icon history-event-icon--${event.entityType.replace(/_/g, '-')}`}><Icon size={18} aria-hidden="true" /></span>
                  <div className="history-event-copy">
                    <div className="history-event-title-row">
                      <strong>{event.entityLabel}</strong>
                      <span className="history-action-chip">{actionLabels[event.action]}</span>
                    </div>
                    <p>{event.summary}</p>
                    <div className="history-event-meta">
                      <span>By {memberNames.get(event.actorUid) ?? `Account ${event.actorUid.slice(0, 8)}`}</span>
                      <span aria-hidden="true">·</span>
                      <span>{entityLabel(event.entityType)}</span>
                      <span aria-hidden="true">·</span>
                      <span>Ref: {event.entityId}</span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={event.occurredAt?.toDate().toISOString()}>{formatDate(event.occurredAt?.toDate() ?? null)}</time>
                    </div>
                  </div>
                  <CheckCircle2 className="history-event-check" size={16} aria-label="Recorded" />
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
