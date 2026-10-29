import type { LucideIcon } from 'lucide-react'

type StatCardProps = {
  label: string
  value: string
  note: string
  icon: LucideIcon
  tone: 'blue' | 'green' | 'purple' | 'amber'
}

export function StatCard({
  label,
  value,
  note,
  icon: Icon,
  tone,
}: StatCardProps) {
  return (
    <article className={`stat-card stat-card--${tone}`}>
      <div className="stat-card-top">
        <span className="stat-icon">
          <Icon size={20} strokeWidth={1.8} />
        </span>

        <span className="stat-note">{note}</span>
      </div>

      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
    </article>
  )
}