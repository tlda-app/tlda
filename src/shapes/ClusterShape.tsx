/**
 * ClusterShape — tldraw canvas shape showing SLURM cluster job status.
 *
 * Polls /api/cluster-status?cluster=qtm every 30 seconds.
 * Click a job row to expand and tail /api/cluster-log?job_name=NAME.
 *
 * API response from /api/cluster-status:
 *   { timestamp, user, jobs: [{name, completed, running, pending, total}] }
 *
 * API response from /api/cluster-log:
 *   { log: string, file: string }
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useState, useEffect, useCallback, useRef } from 'react'
import { selectFleetShapeForLayout } from './fleet-utils'

const DEFAULT_W = 480
const DEFAULT_H = 340
const POLL_INTERVAL = 30_000

interface ClusterJob {
  name: string
  completed: number
  running: number
  pending: number
  total: number
}

interface ClusterStatus {
  timestamp: string
  user: string
  jobs: ClusterJob[]
}

// --- Shape definition ---

export class ClusterShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'cluster' as const
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
    return <ClusterComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

// --- Main component ---

function ClusterComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props

  const [status, setStatus] = useState<ClusterStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [expandedJob, setExpandedJob] = useState<string | null>(null)
  const [logContent, setLogContent] = useState<string>('')
  const [logFile, setLogFile] = useState<string>('')
  const [logLoading, setLogLoading] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/cluster-status?cluster=qtm')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ClusterStatus = await res.json()
      setStatus(data)
      setLastUpdated(new Date())
      setError(null)
    } catch (e: any) {
      setError(e.message || 'fetch failed')
      // Stop polling after first failure — endpoint doesn't exist
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchStatus])

  const fetchLog = useCallback(async (jobName: string) => {
    setLogLoading(true)
    setLogContent('')
    setLogFile('')
    try {
      const res = await fetch(`/api/cluster-log?job_name=${encodeURIComponent(jobName)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setLogContent(data.log || '(empty)')
      setLogFile(data.file || '')
    } catch (e: any) {
      setLogContent(`Error: ${e.message}`)
    } finally {
      setLogLoading(false)
    }
  }, [])

  const handleJobClick = useCallback((jobName: string) => {
    if (expandedJob === jobName) {
      setExpandedJob(null)
      setLogContent('')
      setLogFile('')
    } else {
      setExpandedJob(jobName)
      fetchLog(jobName)
    }
  }, [expandedJob, fetchLog])

  const updatedStr = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—'

  const jobs = status?.jobs ?? []
  const activeJobs = jobs.filter(j => j.running > 0 || j.pending > 0)
  const doneJobs = jobs.filter(j => j.running === 0 && j.pending === 0)

  return (
    <HTMLContainer
      style={{ width: w, height: h, pointerEvents: 'all', overflow: 'hidden' }}
    >
      <div
        className="fleet-shape cluster-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          fontSize: 9,
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          overflow: 'hidden',
          position: 'relative',
          background: 'var(--bg)',
        }}
      >
        {/* Close + layout buttons */}
        <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="fleet-close-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              editor.deleteShapes([shape.id])
            }}
          >
            ×
          </button>
          <button
            className="fleet-layout-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              selectFleetShapeForLayout(editor, shape)
            }}
            title="Resize / move"
          >
            ⊞
          </button>
        </div>

        {/* Header */}
        <div className="cluster-header">
          <span className="cluster-title">SLURM · qtm</span>
          {status?.user && <span className="cluster-user">{status.user}</span>}
          <span className="cluster-updated">updated {updatedStr}</span>
          <button
            className="cluster-refresh-btn"
            onPointerDown={stopEventPropagation}
            onPointerUp={(e) => { e.stopPropagation(); fetchStatus() }}
            title="Refresh now"
          >↻</button>
        </div>

        {/* Body */}
        <div className="cluster-body" onPointerDown={stopEventPropagation}>
          {loading && <div className="cluster-empty">Loading…</div>}
          {error && <div className="cluster-error">Error: {error}</div>}
          {!loading && !error && jobs.length === 0 && (
            <div className="cluster-empty">No running jobs</div>
          )}
          {!loading && !error && jobs.length > 0 && (
            <>
              {/* Column headers */}
              <div className="cluster-row cluster-row-header">
                <span className="cluster-col-name">Job</span>
                <span className="cluster-col-run">Run</span>
                <span className="cluster-col-pend">Pend</span>
                <span className="cluster-col-done">n/N</span>
                <span className="cluster-col-progress" style={{ paddingLeft: 4 }}>Progress</span>
              </div>

              {/* Active jobs */}
              {activeJobs.map((job) => (
                <JobRow
                  key={job.name}
                  job={job}
                  expanded={expandedJob === job.name}
                  logContent={logContent}
                  logFile={logFile}
                  logLoading={logLoading}
                  onToggle={() => handleJobClick(job.name)}
                />
              ))}

              {/* Completed jobs — collapsible */}
              {doneJobs.length > 0 && (
                <CompletedSection jobs={doneJobs} />
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="cluster-footer">
          <span>
            {activeJobs.length} active
            {doneJobs.length > 0 && <span style={{ marginLeft: 6, opacity: 0.5 }}>· {doneJobs.length} done</span>}
          </span>
          <span style={{ opacity: 0.4 }}>30s refresh</span>
        </div>
      </div>
    </HTMLContainer>
  )
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  return (
    <div className="cluster-progress-bar">
      <div className="cluster-progress-fill" style={{ width: `${pct}%` }} />
      <span className="cluster-progress-label">{pct}%</span>
    </div>
  )
}

function JobRow({
  job,
  expanded,
  logContent,
  logFile,
  logLoading,
  onToggle,
}: {
  job: ClusterJob
  expanded: boolean
  logContent: string
  logFile: string
  logLoading: boolean
  onToggle: () => void
}) {
  const isActive = job.running > 0 || job.pending > 0
  return (
    <div>
      <div
        className={`cluster-row cluster-row-job${expanded ? ' expanded' : ''}${!isActive ? ' done' : ''}`}
        onPointerUp={(e) => { e.stopPropagation(); onToggle() }}
      >
        <span className="cluster-col-name" title={job.name}>{job.name}</span>
        <span className="cluster-col-run" style={{ color: job.running > 0 ? '#7ab8a0' : undefined }}>
          {job.running}
        </span>
        <span className="cluster-col-pend" style={{ color: job.pending > 0 ? '#c8b060' : undefined }}>
          {job.pending}
        </span>
        <span className="cluster-col-done">{job.completed}/{job.total}</span>
        <div style={{ paddingLeft: 4 }}><ProgressBar completed={job.completed} total={job.total} /></div>
      </div>

      {expanded && (
        <div className="cluster-log-panel">
          {logFile && <div className="cluster-log-file">{logFile.split('/').slice(-1)[0]}</div>}
          {logLoading ? (
            <div className="cluster-log-loading">Loading log…</div>
          ) : (
            <pre className="cluster-log-content">{logContent}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function CompletedSection({ jobs }: { jobs: ClusterJob[] }) {
  const [show, setShow] = useState(false)
  return (
    <>
      <div
        className="cluster-section-header"
        onPointerUp={(e) => { e.stopPropagation(); setShow(!show) }}
      >
        <span>{show ? '▾' : '▸'}</span>
        <span>completed</span>
        <span className="cluster-section-count">({jobs.length})</span>
      </div>
      {show && jobs.map(job => (
        <div key={job.name} className="cluster-row cluster-row-done">
          <span className="cluster-col-name" title={job.name}>{job.name}</span>
          <span className="cluster-col-run" style={{ opacity: 0.3 }}>0</span>
          <span className="cluster-col-pend" style={{ opacity: 0.3 }}>0</span>
          <span className="cluster-col-done">{job.completed}/{job.total}</span>
          <div style={{ paddingLeft: 4 }}><ProgressBar completed={job.completed} total={job.total} /></div>
        </div>
      ))}
    </>
  )
}
