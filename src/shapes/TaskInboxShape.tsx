/**
 * TaskInboxShape — Skip's task review queue on the fleet dashboard canvas.
 *
 * Shows one task at a time: description, agent, QA notes, files changed.
 * Approve triggers merge status, reject sends back to agent.
 * Auto-advances to next item after action.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
} from 'tldraw'
import { useState, useCallback } from 'react'
import { useTaskInbox } from '../fleet-data-adapter'

const DEFAULT_W = 480
const DEFAULT_H = 520

export class TaskInboxShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'task-inbox' as const
  static override props = {
    w: T.number,
    h: T.number,
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <TaskInboxComponent shape={shape} />
  }

  indicator() {
    return null
  }
}

// --- QA verdict display ---
function QaBadge({ qa }: { qa: any }) {
  if (!qa || !qa.has_report) return <span style={{ color: '#888' }}>No report</span>
  const sigs = qa.signatures || []
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {sigs.map((s: any, i: number) => {
        const isApproved = s.verdict === 'approved'
        return (
          <span key={i} style={{
            fontSize: 12,
            padding: '1px 6px',
            borderRadius: 3,
            background: isApproved ? 'rgba(100,200,100,0.15)' : 'rgba(200,100,100,0.15)',
            color: isApproved ? '#6c6' : '#c66',
          }}>
            {isApproved ? '\u2713' : '\u2717'} {s.agent_id?.split(':')[1]?.slice(0, 6) || 'qa'}
            {s.notes ? ` \u2014 ${s.notes}` : ''}
          </span>
        )
      })}
    </span>
  )
}

// --- Report fields ---
function ReportFields({ qa }: { qa: any }) {
  if (!qa?.report?.fields) return null
  let fields: Record<string, any>
  try {
    fields = typeof qa.report.fields === 'string' ? JSON.parse(qa.report.fields) : qa.report.fields
  } catch { return null }

  const entries = Object.entries(fields).filter(([k]) => !['task_type'].includes(k))
  if (entries.length === 0) return null

  return (
    <div style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>
      <div style={{ fontWeight: 600, color: '#999', marginBottom: 4 }}>Report</div>
      {entries.map(([key, val]) => (
        <div key={key} style={{ marginBottom: 2 }}>
          <span style={{ color: '#777' }}>{key}:</span>{' '}
          <span style={{ color: '#bbb' }}>{typeof val === 'string' ? val : JSON.stringify(val)}</span>
        </div>
      ))}
    </div>
  )
}

// --- Main component ---
function TaskInboxComponent({ shape }: { shape: any }) {
  const { items, act } = useTaskInbox()
  const [currentIdx, setCurrentIdx] = useState(0)
  const [acting, setActing] = useState(false)
  const [rejectMode, setRejectMode] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const item = items[currentIdx] || null
  const total = items.length

  const handleApprove = useCallback(async () => {
    if (!item || acting) return
    setActing(true)
    await act(item.id, 'approve')
    setActing(false)
    // Auto-advance: stay at same index (next item shifts into position)
    // If we were at the end, go back to 0
    setCurrentIdx(prev => prev >= items.length - 1 ? 0 : prev)
  }, [item, acting, act, items.length])

  const handleReject = useCallback(async () => {
    if (!item || acting) return
    setActing(true)
    await act(item.id, 'reject', rejectReason || undefined)
    setActing(false)
    setRejectMode(false)
    setRejectReason('')
    setCurrentIdx(prev => prev >= items.length - 1 ? 0 : prev)
  }, [item, acting, act, rejectReason, items.length])

  return (
    <HTMLContainer
      style={{
        width: shape.props.w,
        height: shape.props.h,
        pointerEvents: 'all',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={stopEventPropagation}
        onPointerUp={stopEventPropagation}
        style={{
          width: '100%',
          height: '100%',
          background: '#1a1a1f',
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          color: '#ddd',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Inbox</span>
            {total > 0 && (
              <span style={{
                fontSize: 11,
                padding: '1px 7px',
                borderRadius: 10,
                background: 'rgba(120,180,255,0.2)',
                color: '#8bf',
              }}>
                {total}
              </span>
            )}
          </div>
          {total > 1 && (
            <div style={{ display: 'flex', gap: 4, fontSize: 12 }}>
              <button
                onClick={() => setCurrentIdx(i => Math.max(0, i - 1))}
                disabled={currentIdx === 0}
                style={navBtnStyle}
              >

                {'\u25C0'}
              </button>
              <span style={{ color: '#888', padding: '0 4px' }}>
                {currentIdx + 1}/{total}
              </span>
              <button
                onClick={() => setCurrentIdx(i => Math.min(total - 1, i + 1))}
                disabled={currentIdx === total - 1}
                style={navBtnStyle}
              >
                {'\u25B6'}
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {!item ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#666',
              fontSize: 14,
            }}>
              No items awaiting review
            </div>
          ) : (
            <div>
              {/* Task description */}
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, lineHeight: 1.3 }}>
                {item.description}
              </div>

              {/* Agent */}
              <div style={{ fontSize: 12, color: '#999', marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: 3,
                  background: 'rgba(122,158,200,0.15)',
                  color: '#7a9ec8',
                }}>
                  {item.agent_name}
                </span>
                {item.completed_at && (
                  <span style={{ color: '#666' }}>
                    {formatTime(item.completed_at)}
                  </span>
                )}
              </div>

              {/* QA status */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#777', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  QA
                </div>
                <QaBadge qa={item.qa} />
              </div>

              {/* Report fields */}
              <ReportFields qa={item.qa} />

              {/* Success criteria */}
              {item.success_criteria && item.success_criteria.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12 }}>
                  <div style={{ color: '#777', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 }}>
                    Criteria
                  </div>
                  {item.success_criteria.map((c: string, i: number) => (
                    <div key={i} style={{ color: '#aaa', marginBottom: 2 }}>
                      {'\u2022'} {c}
                    </div>
                  ))}
                </div>
              )}

              {/* Task message (full context) */}
              {item.message && (
                <div style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: '#999',
                  padding: '8px 10px',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: 4,
                  maxHeight: 120,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.4,
                }}>
                  {item.message}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Action bar */}
        {item && (
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}>
            {rejectMode ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleReject(); if (e.key === 'Escape') setRejectMode(false) }}
                  placeholder="Reason (optional)"
                  autoFocus
                  style={{
                    flex: 1,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 4,
                    padding: '6px 10px',
                    color: '#ddd',
                    fontSize: 13,
                    outline: 'none',
                  }}
                />
                <button onClick={handleReject} disabled={acting} style={rejectBtnStyle}>
                  {acting ? '...' : 'Send'}
                </button>
                <button onClick={() => setRejectMode(false)} style={navBtnStyle}>
                  {'\u2715'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleApprove} disabled={acting} style={approveBtnStyle}>
                  {acting ? '...' : 'Approve'}
                </button>
                <button onClick={() => setRejectMode(true)} disabled={acting} style={rejectBtnStyle}>
                  Reject
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </HTMLContainer>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const delta = Date.now() - d.getTime()
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

const navBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 4,
  color: '#999',
  cursor: 'pointer',
  padding: '2px 8px',
  fontSize: 12,
}

const approveBtnStyle: React.CSSProperties = {
  flex: 1,
  background: 'rgba(100,200,100,0.15)',
  border: '1px solid rgba(100,200,100,0.3)',
  borderRadius: 6,
  color: '#6c6',
  cursor: 'pointer',
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 600,
}

const rejectBtnStyle: React.CSSProperties = {
  flex: 1,
  background: 'rgba(200,100,100,0.1)',
  border: '1px solid rgba(200,100,100,0.2)',
  borderRadius: 6,
  color: '#c66',
  cursor: 'pointer',
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 600,
}
