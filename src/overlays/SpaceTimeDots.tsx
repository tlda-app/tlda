import { useMemo, useState } from 'react'

export interface ChangelogCommit {
  hash: string
  timestamp: number
  changedPages: number[]
}

interface SpaceTimeDotsProps {
  changelog: { commits: ChangelogCommit[]; totalPages: number }
  timeRange?: { oldest: number; newest: number }
  timeScale?: 'linear' | 'log-age'
  showPageLabels?: boolean
  className?: string
  onSelect: (commit: ChangelogCommit, page: number) => void
}

export const LOG_AGE_CURVE = 4000

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function SpaceTimeDots({
  changelog,
  timeRange,
  timeScale = 'linear',
  showPageLabels = true,
  className = '',
  onSelect,
}: SpaceTimeDotsProps) {
  const [hoveredDot, setHoveredDot] = useState<{
    x: number
    y: number
    commit: ChangelogCommit
    page: number
  } | null>(null)

  const { dots, yLabels } = useMemo(() => {
    if (changelog.commits.length === 0 || changelog.totalPages === 0) {
      return { dots: [], yLabels: [] }
    }

    const commitTimes = changelog.commits.map(commit => commit.timestamp)
    const oldest = timeRange?.oldest ?? Math.min(...commitTimes)
    const newest = timeRange?.newest ?? Math.max(...commitTimes)
    const span = Math.max(newest - oldest, 1)
    const dots = changelog.commits.flatMap(commit => {
      const linearProgress = Math.max(0, Math.min(1, (commit.timestamp - oldest) / span))
      const xProgress = timeScale === 'log-age'
        ? 1 - Math.log1p((1 - linearProgress) * LOG_AGE_CURVE) / Math.log1p(LOG_AGE_CURVE)
        : linearProgress
      const xPct = xProgress * 100
      return commit.changedPages.map(page => ({
        xPct: Math.max(0, Math.min(100, xPct)),
        yPct: changelog.totalPages === 1
          ? 50
          : Math.max(0, Math.min(100, ((page - 1) / (changelog.totalPages - 1)) * 100)),
        commit,
        page,
        isMulti: commit.changedPages.length > 1,
      }))
    })

    const yLabels: Array<{ page: number; yPct: number }> = []
    if (changelog.totalPages <= 1) {
      yLabels.push({ page: 1, yPct: 50 })
    } else {
      const step = Math.max(1, Math.ceil(changelog.totalPages / 5))
      for (let page = 1; page <= changelog.totalPages; page += step) {
        yLabels.push({
          page,
          yPct: ((page - 1) / (changelog.totalPages - 1)) * 100,
        })
      }
      if (yLabels[yLabels.length - 1].page !== changelog.totalPages) {
        yLabels.push({ page: changelog.totalPages, yPct: 100 })
      }
    }

    return { dots, yLabels }
  }, [changelog, timeRange, timeScale])

  if (dots.length === 0) return null

  return (
    <>
      <div className={`spacetime-panel ${className}`.trim()}>
        {showPageLabels && (
          <div className="spacetime-y-axis">
            {yLabels.map(label => (
              <span
                key={label.page}
                className="spacetime-y-label"
                style={{ top: `${label.yPct}%` }}
              >
                {label.page}
              </span>
            ))}
          </div>
        )}
        <div className="spacetime-field">
          {dots.map((dot, index) => (
            <button
              key={`${dot.commit.hash}-${dot.page}-${index}`}
              type="button"
              className={`spacetime-dot${dot.isMulti ? ' multi' : ''}`}
              style={{ left: `${dot.xPct}%`, top: `${dot.yPct}%` }}
              aria-label={`Open page ${dot.page} at ${formatTime(dot.commit.timestamp)}`}
              onPointerEnter={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                setHoveredDot({
                  x: rect.left + rect.width / 2,
                  y: rect.top,
                  commit: dot.commit,
                  page: dot.page,
                })
              }}
              onPointerLeave={() => setHoveredDot(null)}
              onClick={event => {
                event.stopPropagation()
                onSelect(dot.commit, dot.page)
              }}
            />
          ))}
        </div>
      </div>
      {hoveredDot && (
        <div
          className="spacetime-tooltip"
          style={{ left: hoveredDot.x, top: hoveredDot.y - 8 }}
        >
          <span className="spacetime-tooltip-page">p.{hoveredDot.page}</span>
          <span className="spacetime-tooltip-time">{formatTime(hoveredDot.commit.timestamp)}</span>
          {hoveredDot.commit.changedPages.length > 1 && (
            <span className="spacetime-tooltip-multi">
              +{hoveredDot.commit.changedPages.length - 1} pg
            </span>
          )}
        </div>
      )}
    </>
  )
}
