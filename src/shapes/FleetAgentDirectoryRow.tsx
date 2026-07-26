import React from 'react'
import { PrettyName } from './PrettyName'
import {
  type FleetAgentDirectoryRowModel,
  fleetAgentLabelColor,
} from './FleetAgentDirectoryModel'
export {
  type FleetAgentDirectoryRowModel,
  fleetAgentCategory,
  fleetAgentLabelColor,
  formatFleetAgentActivityHealth,
  formatFleetAgentEffort,
  formatFleetAgentModel,
  formatFleetAgentSpawnOptions,
  formatFleetAgentPermission,
  formatFleetAgentRelativeTime,
  getFleetAgentDirectoryRows,
  getFleetAgentNickColor,
  sortFleetAgentDirectoryRows,
  sortFleetAgentDirectoryRowsByRecency,
  toFleetAgentDirectoryRow,
} from './FleetAgentDirectoryModel'

function stopEventPropagation(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

export function FleetAgentDirectoryRow({
  row,
  taskDesc = '',
  taskTitle = '',
  unreadCount = 0,
  contextPct,
  expanded = false,
  lastMessage = '',
  onToggleExpand,
  onHibernate,
  onAgentPointerDown,
  onAgentPointerUp,
  onLabelPointerDown,
  onLabelPointerUp,
}: {
  row: FleetAgentDirectoryRowModel
  taskDesc?: string
  taskTitle?: string
  unreadCount?: number
  contextPct?: number
  expanded?: boolean
  lastMessage?: string
  onToggleExpand?: (e: React.PointerEvent) => void
  onHibernate?: (e: React.PointerEvent) => void
  onAgentPointerDown?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
  onAgentPointerUp?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
  onLabelPointerDown?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
  onLabelPointerUp?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
}) {
  return (
    <div
      className={`fleet-agents-row${row.dimmed ? ' dimmed' : ''}${expanded ? ' expanded' : ''}`}
      data-agent-id={row.id}
      data-agent-name={row.exactName}
    >
      <div
        className="fleet-agents-row-main"
        onPointerDown={(e) => stopEventPropagation(e)}
        onPointerUp={(e) => {
          e.stopPropagation()
          onToggleExpand?.(e)
        }}
      >
        <span className={`fleet-agents-unread-dot${unreadCount > 0 ? ' active' : ''}`} />
        <span
          className="fleet-agents-kill-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => {
            e.stopPropagation()
            onHibernate?.(e)
          }}
          title="Hibernate agent"
        >
          ×
        </span>
        <span
          className="fleet-agents-col-name fleet-agents-pill"
          style={{ color: row.color, opacity: row.nameOpacity, display: 'flex', alignItems: 'center' }}
          title={row.hoverTitle}
          data-label={row.exactName}
          data-mode="dm"
          onPointerDown={(e) => onAgentPointerDown?.(e, row)}
          onPointerUp={(e) => onAgentPointerUp?.(e, row)}
        >
          <PrettyName prettyName={row.prettyName} slotWidth={15} />
        </span>
        <span className="fleet-agents-col-seen">{row.ago}</span>
        <span
          className="fleet-agents-col-ctx"
          style={contextPct != null ? { color: contextPct <= 15 ? '#e57373' : contextPct <= 30 ? '#ffb74d' : '#81c784' } : undefined}
        >
          {contextPct != null ? `${contextPct}%` : ''}
        </span>
        <span className="fleet-agents-col-task" title={taskTitle}>
          {row.notResumable && <span className="fleet-agents-not-resumable">{row.resumableStatus}</span>}
          {row.activityHealth && <span className="fleet-agents-health">{row.activityHealth}</span>}
          <span>{row.notResumable ? '' : taskDesc ? taskDesc.substring(0, 50) : ''}</span>
        </span>
        <span className="fleet-agents-col-labels" onPointerDown={(e) => e.stopPropagation()}>
          {row.labels.map((label: string) => (
            <span
              key={label}
              className="fleet-agents-label-chip"
              data-label={label}
              data-mode="agent"
              style={{ background: fleetAgentLabelColor(label) }}
              onPointerDown={(e) => onLabelPointerDown?.(e, label, row)}
              onPointerUp={(e) => onLabelPointerUp?.(e, label, row)}
            >
              {label}
            </span>
          ))}
        </span>
      </div>
      {expanded && (
        <div className="fleet-agents-row-detail" onPointerDown={(e) => stopEventPropagation(e)}>
          <div className="fleet-agents-detail-meta">
            {row.machine && <span className="fleet-agents-detail-machine" title="machine">{row.machine}</span>}
            {row.model && <span className="fleet-agents-detail-model">{row.model}</span>}
            {row.spawnOptions.map((option) => (
              <span key={option} className="fleet-agents-detail-effort">{option}</span>
            ))}
            {row.permission && <span className="fleet-agents-detail-cap" title="permission / fence">{row.permission}</span>}
            {row.notResumable && <span className="fleet-agents-detail-not-resumable" title="durable resume handle not written yet">{row.resumableStatus}</span>}
            {row.activityHealth && <span className="fleet-agents-detail-health" title="activity health">{row.activityHealth}</span>}
            {row.ago && <span className="fleet-agents-detail-seen">seen {row.ago}</span>}
          </div>
          <div className="fleet-agents-detail-current">
            {taskTitle || '(no task)'}
          </div>
          {lastMessage && <div className="fleet-agents-detail-last">{lastMessage}</div>}
        </div>
      )}
    </div>
  )
}

export function FleetAgentDirectoryList({
  rows,
  onAgentPointerDown,
  onAgentPointerUp,
  onLabelPointerDown,
  onLabelPointerUp,
}: {
  rows: FleetAgentDirectoryRowModel[]
  onAgentPointerDown?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
  onAgentPointerUp?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
  onLabelPointerDown?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
  onLabelPointerUp?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
}) {
  if (rows.length === 0) return <div className="fleet-agents-empty">No agents</div>
  return (
    <>
      {rows.map((row) => (
        <FleetAgentDirectoryRow
          key={row.id || row.exactName}
          row={row}
          onAgentPointerDown={onAgentPointerDown}
          onAgentPointerUp={onAgentPointerUp}
          onLabelPointerDown={onLabelPointerDown}
          onLabelPointerUp={onLabelPointerUp}
        />
      ))}
    </>
  )
}
