import React, { useLayoutEffect, useRef, useState } from 'react'
import { PrettyName } from './PrettyName'
import {
  type FleetAgentDirectoryRowModel,
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

const TYPED_LABEL_PREFIXES = ['project:', 'cwd:', 'machine:', 'model:', 'effort:', 'profile:', 'permission:']

function isOrdinaryFleetAgentLabel(label: string): boolean {
  return !TYPED_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))
}

function prettyFleetAgentLabel(label: string): { value: string; title: string } {
  const idx = label.indexOf(':')
  if (idx <= 0) return { value: label, title: label }
  return { value: label.slice(idx + 1), title: label }
}

type FleetAgentMetadataChip = {
  kind: 'model' | 'option' | 'permission' | 'subscription'
  glyph: string
  value: string
  title: string
  policy?: string
}

function fleetAgentMetadataChips(row: FleetAgentDirectoryRowModel): FleetAgentMetadataChip[] {
  return [
    row.model && { kind: 'model' as const, glyph: '◌', value: row.model, title: `model: ${row.model}` },
    ...row.spawnOptions.map((option): FleetAgentMetadataChip => ({ kind: 'option', glyph: '+', value: option, title: `spawn option: ${option}` })),
    row.permission && { kind: 'permission' as const, glyph: '◇', value: row.permission, title: `permission: ${row.permission}` },
    // The query as written, which is the form the agent subscribed in and the
    // form the server matches against. The delivery policy is the chip's colour,
    // and the title says which policy that colour is.
    ...row.subscriptions.map((subscription): FleetAgentMetadataChip => ({
      kind: 'subscription',
      glyph: '◈',
      value: subscription.query,
      title: `subscription: ${subscription.query}${subscription.policy ? ` — ${subscription.policy}` : ''}`,
      policy: subscription.policyKind || undefined,
    })),
  ].filter(Boolean) as FleetAgentMetadataChip[]
}

function FleetAgentMetadataChipView({ chip, compact = false }: { chip: FleetAgentMetadataChip; compact?: boolean }) {
  return (
    <span
      className={`fleet-agents-metadata-chip${compact ? ' compact' : ''}`}
      data-kind={chip.kind}
      data-policy={chip.policy}
      title={chip.title}
      aria-label={chip.title}
    >
      <span className="fleet-agents-metadata-glyph" aria-hidden="true">{chip.glyph}</span>
      <span className="fleet-agents-metadata-value">{chip.value}</span>
    </span>
  )
}

type FleetAgentLabelChip = {
  label: string
  value: string
  title: string
  glyph?: string
  special?: boolean
}

export type FleetAgentDirectoryTask = {
  id?: string
  title?: string
  description?: string
}

function fleetAgentFolderLabel(row: FleetAgentDirectoryRowModel, knownProjects: readonly string[] = []): FleetAgentLabelChip | null {
  const projectLabel = row.labels.find((label) => label.startsWith('project:'))?.slice('project:'.length).trim()
  const cwdLabel = row.labels.find((label) => label.startsWith('cwd:'))?.slice('cwd:'.length).trim()
  const projectNameLabels = new Set(knownProjects.filter(Boolean))
  const plainProjectLabel = row.labels.find((label) => projectNameLabels.has(label)) || ''
  const project = row.project || projectLabel || plainProjectLabel
  const cwd = row.cwd || cwdLabel || ''
  if (project) {
    return {
      label: `project:${project}`,
      value: project,
      title: `project:${project}`,
      glyph: '▣',
      special: true,
    }
  }
  if (cwd) {
    return {
      label: `cwd:${cwd}`,
      value: row.cwdLabel || cwd,
      title: `cwd:${cwd}`,
      glyph: '~',
      special: true,
    }
  }
  return null
}

function FleetAgentLabelChipView({
  chip,
  compact = false,
  row,
  onLabelPointerDown,
  onLabelPointerUp,
}: {
  chip: FleetAgentLabelChip
  compact?: boolean
  row: FleetAgentDirectoryRowModel
  onLabelPointerDown?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
  onLabelPointerUp?: (e: React.PointerEvent, label: string, row: FleetAgentDirectoryRowModel) => void
}) {
  const chipRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const [compactScale, setCompactScale] = useState(1)
  const compactScaleRef = useRef(1)
  compactScaleRef.current = compactScale

  useLayoutEffect(() => {
    if (!compact) return
    const chipEl = chipRef.current
    const contentEl = contentRef.current
    if (!chipEl || !contentEl) return

    const measure = () => {
      const styles = getComputedStyle(chipEl)
      const horizontalPadding =
        (parseFloat(styles.paddingLeft) || 0) +
        (parseFloat(styles.paddingRight) || 0)
      const available = Math.max(1, chipEl.clientWidth - horizontalPadding)
      const needed = contentEl.scrollWidth / compactScaleRef.current
      const nextScale = needed > available ? available / needed : 1
      setCompactScale((current) => Math.abs(current - nextScale) > 0.01 ? nextScale : current)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(chipEl)
    observer.observe(contentEl)
    return () => observer.disconnect()
  }, [chip.glyph, chip.value, compact])

  return (
    <span
      ref={chipRef}
      className={`fleet-agents-detail-label-chip${chip.special ? ' is-folder-label' : ''}${compact ? ' compact' : ''}`}
      data-label={chip.label}
      data-mode="agent"
      title={chip.title}
      aria-label={chip.title}
      style={compact ? { '--fleet-compact-label-scale': compactScale } as React.CSSProperties : undefined}
      onPointerDown={(e) => onLabelPointerDown?.(e, chip.label, row)}
      onPointerUp={(e) => onLabelPointerUp?.(e, chip.label, row)}
    >
      <span ref={contentRef} className="fleet-agents-detail-label-content">
        {chip.glyph && <span className="fleet-agents-detail-label-glyph" aria-hidden="true">{chip.glyph}</span>}
        <span>{chip.value}</span>
      </span>
    </span>
  )
}

export function FleetAgentDirectoryRow({
  row,
  taskDesc = '',
  taskTitle = '',
  tasks = [],
  unreadCount = 0,
  contextPct,
  expanded = false,
  childCount = 0,
  childrenFolded = false,
  knownProjects = [],
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
  tasks?: readonly FleetAgentDirectoryTask[]
  unreadCount?: number
  contextPct?: number
  expanded?: boolean
  childCount?: number
  childrenFolded?: boolean
  knownProjects?: readonly string[]
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
  const folderLabel = fleetAgentFolderLabel(row, knownProjects)
  const folderAliases = new Set(
    [folderLabel?.label, folderLabel?.value, row.project, row.cwdLabel, row.cwd].filter(Boolean),
  )
  const ordinaryLabels = row.labels.filter((label) =>
    isOrdinaryFleetAgentLabel(label) && !folderAliases.has(label)
  )
  const metadataChips = fleetAgentMetadataChips(row)
  // The project is a label like any other, so it belongs in the labels column
  // rather than only in the expansion row. The collapsed row carries the two
  // most salient — the project first, since it is the one an agent always has
  // — and the expansion row is what a third label and beyond are for.
  const salientLabels: FleetAgentLabelChip[] = [
    ...(folderLabel ? [folderLabel] : []),
    ...ordinaryLabels.map((label) => ({ label, ...prettyFleetAgentLabel(label) })),
  ]
  const compactLabels = salientLabels.slice(0, 2)
  const detailLabels = salientLabels.slice(2)
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
        <span
          className="fleet-agents-col-labels"
          data-compact-label-count={compactLabels.length}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {compactLabels.map((chip) => (
            <FleetAgentLabelChipView
              key={chip.label}
              chip={chip}
              compact
              row={row}
              onLabelPointerDown={onLabelPointerDown}
              onLabelPointerUp={onLabelPointerUp}
            />
          ))}
        </span>
      </div>
      {expanded && (
        <div className="fleet-agents-row-detail" onPointerDown={(e) => stopEventPropagation(e)}>
          <div className="fleet-agents-detail-top">
            <div className="fleet-agents-detail-meta">
              {metadataChips.map((chip, index) => <FleetAgentMetadataChipView key={`${chip.kind}:${chip.value}:${index}`} chip={chip} />)}
            </div>
            {tasks[1] && (
              <FleetAgentTaskRow task={tasks[1]} index={1} />
            )}
            {canHibernate && (
              <button
                className="fleet-agents-detail-hibernate"
                style={{ color: row.color, opacity: row.nameOpacity }}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                onClick={(e) => { e.stopPropagation(); onHibernate?.(e) }}
                aria-label="Hibernate agent"
                title="Hibernate agent"
              >
                Zz
              </button>
            )}
          </div>
          {tasks.slice(2).map((task, index) => (
            <div className="fleet-agents-detail-task-row" key={task.id || `${task.title || task.description}:${index + 2}`}>
              <FleetAgentTaskRow task={task} index={index + 2} />
            </div>
          ))}
          {detailLabels.length > 0 && (
            <div className="fleet-agents-detail-labels" aria-label="agent labels">
              {detailLabels.map((chip) => (
                <FleetAgentLabelChipView
                  key={chip.label}
                  chip={chip}
                  row={row}
                  onLabelPointerDown={onLabelPointerDown}
                  onLabelPointerUp={onLabelPointerUp}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FleetAgentTaskRow({ task, index }: { task: FleetAgentDirectoryTask; index: number }) {
  const taskText = task.title || task.description || task.id || `Task ${index + 1}`
  return (
    <div
      className="fleet-agents-detail-task"
      data-task-id={task.id}
      title={task.description || taskText}
    >
      {taskText}
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
