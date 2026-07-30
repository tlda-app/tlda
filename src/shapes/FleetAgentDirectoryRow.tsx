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
  fleetAgentVisibleName,
  getFleetAgentDirectoryRows,
  getFleetAgentNickColor,
  projectFleetAgentDirectoryFolding,
  sortFleetAgentDirectoryRows,
  sortFleetAgentDirectoryRowsByRecency,
  toFleetAgentDirectoryRow,
} from './FleetAgentDirectoryModel'

function stopEventPropagation(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

function isCompactFleetAgentLabel(label: string): boolean {
  return !label.startsWith('project:')
}

function prettyFleetAgentLabel(label: string): { glyph: string; value: string; title: string } {
  const idx = label.indexOf(':')
  if (idx <= 0) return { glyph: '', value: label, title: label }
  const key = label.slice(0, idx)
  const value = label.slice(idx + 1)
  const glyph = key === 'project' ? '⊙'
    : key === 'machine' ? '▣'
    : key === 'model' ? '◌'
    : key === 'permission' ? '◇'
    : `${key}:`
  return { glyph, value, title: label }
}

export function FleetAgentDirectoryRow({
  row,
  taskDesc = '',
  taskTitle = '',
  unreadCount = 0,
  contextPct,
  expanded = false,
  lastMessage = '',
  childCount = 0,
  childrenFolded = false,
  onCycleState,
  onControlPointerDown,
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
  childCount?: number
  childrenFolded?: boolean
  onCycleState?: (e: React.PointerEvent | PointerEvent) => void
  onControlPointerDown?: (e: React.PointerEvent) => void
  onHibernate?: (e: React.SyntheticEvent) => void
  onAgentPointerDown?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
  onAgentPointerUp?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
  onLabelPointerDown?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
  onLabelPointerUp?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
}) {
  const isNativeChild = !!row.agent?.parent_agent_id
  const hasChildren = childCount > 0
  const stateLabel = expanded ? 'details' : hasChildren && !childrenFolded ? 'subtree' : 'collapsed'
  const nextLabel = expanded ? 'collapse' : hasChildren && childrenFolded ? 'show subagents' : 'show details'
  const controlGlyph = expanded ? '▴' : hasChildren && childrenFolded ? '▸' : hasChildren ? '▾›' : '›'
  const canHibernate = !!onHibernate && !isNativeChild && !row.dimmed
  const compactLabels = row.labels.filter(isCompactFleetAgentLabel)
  return (
    <div
      className={`fleet-agents-row${isNativeChild ? ' native-child' : ''}${row.dimmed ? ' dimmed' : ''}${expanded ? ' expanded' : ''}`}
      data-agent-id={row.id}
      data-agent-name={row.exactName}
      data-agent-row-state={stateLabel}
    >
      <div
        className="fleet-agents-row-main"
        onPointerDown={(e) => stopEventPropagation(e)}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <span className={`fleet-agents-unread-dot${unreadCount > 0 ? ' active' : ''}`} />
        <span className="fleet-agents-row-controls">
          <span
            className={`fleet-agents-fold-btn${hasChildren ? ' has-children' : ''}`}
            data-child-count={hasChildren ? childCount : undefined}
            onPointerDown={(e) => {
              if (onControlPointerDown) onControlPointerDown(e)
              else e.stopPropagation()
            }}
            onPointerUp={(e) => {
              e.stopPropagation()
              if (!onControlPointerDown) onCycleState?.(e)
            }}
            title={hasChildren
              ? `${nextLabel}; drag to filter parent + team`
              : nextLabel}
          >
            {controlGlyph}
          </span>
        </span>
        <FleetAgentDirectoryNameColumn
          row={row}
          onAgentPointerDown={onAgentPointerDown}
          onAgentPointerUp={onAgentPointerUp}
        />
        <span className="fleet-agents-col-seen">{row.ago}</span>
        <span
          className="fleet-agents-col-ctx"
          style={contextPct != null ? { color: contextPct <= 15 ? '#e57373' : contextPct <= 30 ? '#ffb74d' : '#81c784' } : undefined}
        >
          {contextPct != null ? `${contextPct}%` : ''}
        </span>
        <span className="fleet-agents-col-task" title={taskTitle}>
          {row.activityHealth && <span className="fleet-agents-health">{row.activityHealth}</span>}
          <span>{taskDesc ? taskDesc.substring(0, 50) : ''}</span>
        </span>
        <span className="fleet-agents-col-labels" onPointerDown={(e) => e.stopPropagation()}>
          {compactLabels.map((label: string) => (
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
            {row.activityHealth && <span className="fleet-agents-detail-health" title="activity health">{row.activityHealth}</span>}
            {row.ago && <span className="fleet-agents-detail-seen">seen {row.ago}</span>}
            {canHibernate && (
              <button
                className="fleet-agents-detail-action"
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => { e.stopPropagation(); onHibernate?.(e) }}
                title="Hibernate agent"
              >
                Hibernate
              </button>
            )}
          </div>
          {row.labels.length > 0 && (
            <div className="fleet-agents-detail-labels" aria-label="agent labels">
              {row.labels.map((label: string) => {
                const pretty = prettyFleetAgentLabel(label)
                return (
                  <span
                    key={label}
                    className="fleet-agents-detail-label-chip"
                    data-label={label}
                    data-mode="agent"
                    title={pretty.title}
                    aria-label={pretty.title}
                    onPointerDown={(e) => onLabelPointerDown?.(e, label, row)}
                    onPointerUp={(e) => onLabelPointerUp?.(e, label, row)}
                  >
                    {pretty.glyph && <span className="fleet-agents-detail-label-glyph" aria-hidden="true">{pretty.glyph}</span>}
                    <span>{pretty.value}</span>
                  </span>
                )
              })}
            </div>
          )}
          <div className="fleet-agents-detail-current">
            {taskTitle || '(no task)'}
          </div>
          {lastMessage && <div className="fleet-agents-detail-last">{lastMessage}</div>}
        </div>
      )}
    </div>
  )
}

export function FleetAgentDirectoryNameColumn({
  row,
  onAgentPointerDown,
  onAgentPointerUp,
}: {
  row: FleetAgentDirectoryRowModel
  onAgentPointerDown?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
  onAgentPointerUp?: (e: React.PointerEvent, row: FleetAgentDirectoryRowModel) => void
}) {
  return (
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
