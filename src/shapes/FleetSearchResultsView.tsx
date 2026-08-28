import type React from 'react'
import { stopEventPropagation } from 'tldraw'
import { appendToken } from '../authToken'
import { convertChatEvent } from '../fleet/fleet-data.mjs'
import { renderChatLine, esc, timeShort } from '../fleet/chat-render.mjs'
import { groupFleetSearchResults, type FleetSearchResultGroup } from '../fleet/search-query'
import { fleetSearchResultParticipantLabel } from '../../shared/filter-semantics.mjs'
// @ts-ignore — vanilla JS module
import { canonicalSearchReference } from '../../shared/canonical-references.mjs'

const SEARCH_GROUP_INITIAL_LIMIT = 6

export function visibleFleetSearchResultCount(
  resultGroups: FleetSearchResultGroup[],
  expandedSearchGroups: Record<string, boolean>,
) {
  return resultGroups.reduce((total, group) => {
    if (expandedSearchGroups[group.id]) return total + group.results.length
    return total + Math.min(group.results.length, SEARCH_GROUP_INITIAL_LIMIT)
  }, 0)
}

function searchResultMessageDrag(result: any, text: string, ctx: any, agents: any[]) {
  const fromId = result.from || result.agentId || result.agent || ''
  const label = fleetSearchResultParticipantLabel(result, fromId, { agents }) || ctx.agentLabel(fromId)
  const ts = result.timestamp || ''
  const time = ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const id = result.id
    ? canonicalSearchReference(result.source === 'session' ? 'session' : 'msg', result.id)
    : null
  const stamped = ts ? new Date(ts) : null
  const readableTs = stamped && !Number.isNaN(stamped.getTime()) ? stamped.toLocaleString() : ts
  const content = [
    ts ? `[${readableTs}]` : '',
    label ? `${label}:` : '',
    text,
  ].filter(Boolean).join(' ')
  return {
    value: id || `${result.source === 'session' ? 'session' : 'msg'}:${fromId}:${ts}`,
    displayName: `${label} ${time} search`.trim(),
    color: '#8888a0',
    content,
  }
}

function renderProjectAgentSearchLine(result: any, ctx: any, agents: any[]) {
  const agentId = result.agentId || result.agent_id || result.from || ''
  const label = fleetSearchResultParticipantLabel(result, agentId, { agents }) || ctx.agentLabel(agentId)
  const cls = ctx.getNickClass(agentId)
  const latest = result.latest_activity || {}
  const ts = result.latest_relevant_at || result.timestamp || ''
  const latestType = latest.type || result.type || 'activity'
  const summary = latest.summary || result.snippet || result.text || result.cwd || ''
  const body = summary ? ctx.renderMarkdown(esc(summary)) : esc(result.cwd || '')
  return `<div class="chat-line" data-msg-ts="${esc(ts)}" data-msg-from="${esc(agentId)}">
    <span class="chat-ts" draggable="true">${timeShort(ts)}</span>
    <span class="chat-nick"><span class="agent-nick ${cls}" data-agent-id="${esc(agentId)}">${esc(label)}:</span></span>
    <span class="pretty-search-source">${esc(latestType)}</span>
    <span class="pretty-search-snippet">${body}</span>
  </div>`
}

function renderDocumentContentSearchLine(result: any, ctx: any) {
  const project = result.project || result.doc || ''
  const title = result.title || project || 'document'
  const where = [
    project,
    result.page ? `page ${result.page}` : '',
    result.label && result.label !== result.file ? result.label : '',
    result.file || '',
  ].filter(Boolean).join(' · ')
  const snippet = result.snippet || result.text || ''
  return `<div class="chat-line fleet-search-document-line">
    <span class="pretty-search-source">doc</span>
    <span class="pretty-search-snippet">
      <span class="fleet-search-document-title">${esc(title)}</span>
      ${where ? `<span class="fleet-search-document-where">${esc(where)}</span>` : ''}
      ${snippet ? `<span class="fleet-search-document-snippet">${ctx.renderMarkdown(esc(snippet))}</span>` : ''}
    </span>
  </div>`
}

export function FleetSearchResultsView({
  results,
  loading,
  searched,
  queryError,
  expandedSearchGroups,
  setExpandedSearchGroups,
  ctx,
  agents,
  onOpenChatForResult,
  onStartAgentDrag,
  onStartDrag,
  hasMore = false,
  onLoadMore,
}: {
  results: any[]
  loading: boolean
  searched: boolean
  queryError?: string | null
  expandedSearchGroups: Record<string, boolean>
  setExpandedSearchGroups: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  ctx: any
  agents: any[]
  onOpenChatForResult: (result: any) => void
  onStartAgentDrag?: (e: React.PointerEvent, value: string, displayName: string, color: string) => void
  onStartDrag?: (e: React.PointerEvent, type: 'agent' | 'msg', value: string, displayName: string, color: string, content?: string) => void
  /** The server has another page. Only the chat card pages; the search panel
   *  passes neither of these and keeps its per-group controls untouched. */
  hasMore?: boolean
  onLoadMore?: () => void
}) {
  const resultGroups = groupFleetSearchResults(results)
  // The card pages and owns one control; the panel does not page and keeps its
  // per-group ones.
  const paging = typeof onLoadMore === 'function'
  const locallyHidden = resultGroups.reduce(
    (total, group) => total + (expandedSearchGroups[group.id] ? 0 : Math.max(0, group.results.length - SEARCH_GROUP_INITIAL_LIMIT)),
    0,
  )
  const showLoadMore = hasMore || locallyHidden > 0
  // His word is "messages", so the button says messages. It cannot come from the
  // group label: those are fixed in shared/fleet-search-query.mjs as Agents,
  // Conversation, Documents, Session Logs and Activity, so a label-derived noun
  // can say "Show more conversation" but never his sentence. Caught by
  // search-pm exercising this branch, and it was my claim to have used his
  // words while deriving the noun from the label instead.
  const hasConversation = resultGroups.some(group => group.id === 'conversation' && group.results.length > 0)
  const loadMoreNoun = hasConversation ? 'messages' : 'results'
  const renderResult = (r: any, i: number, groupId: string) => {
    const text = r.text ?? r.snippet ?? ''
    const rawEvent = r.source === 'session'
      ? { type: r.role === 'user' ? 'terminal_user' : 'terminal_assistant', from: r.agentId, to: null, text, timestamp: r.timestamp, id: r.id }
      : { ...r, text, id: r.id }
    const lineHtml = r.type === 'project_agent'
      ? renderProjectAgentSearchLine(r, ctx, agents)
      : r.type === 'document_content'
        ? renderDocumentContentSearchLine(r, ctx)
        : renderChatLine(convertChatEvent(rawEvent), ctx)
    if (!lineHtml) return null
    const openDocument = r.type === 'document_content'
      ? () => window.open(appendToken(`${window.location.origin}/?project=${encodeURIComponent(r.project || r.doc)}`), '_blank')
      : null
    return (
      <div
        key={`${groupId}-${r.source || 'result'}-${r.type || r.role || 'row'}-${r.id || i}`}
        className={`fleet-search-result fleet-search-result-${groupId}`}
        title={r.type === 'document_content' ? 'Open document' : undefined}
        onPointerDown={(e) => {
          stopEventPropagation(e)
          if (openDocument) return
          const nick = (e.target as HTMLElement).closest('[data-agent-id]') as HTMLElement | null
          if (nick && (onStartAgentDrag || onStartDrag)) {
            const agentId = nick.dataset.agentId || ''
            const historicalName = fleetSearchResultParticipantLabel(r, agentId, { agents })
            const value = historicalName || ctx.agentFullName?.(agentId) || agentId.replace('fleet:', '')
            const name = historicalName || ctx.agentLabel(agentId)
            const color = ctx.getAgentColor(agentId)
            if (onStartAgentDrag) onStartAgentDrag(e, value, name, color)
            else onStartDrag?.(e, 'agent', value, name, color)
            return
          }
          if (!onStartDrag) return
          const tsEl = (e.target as HTMLElement).closest('.chat-ts, .pretty-search-ts, .pretty-ts') as HTMLElement | null
          if (tsEl) {
            const drag = searchResultMessageDrag(r, text, ctx, agents)
            onStartDrag(e, 'msg', drag.value, drag.displayName, drag.color, drag.content)
          }
        }}
        onPointerUp={(e) => {
          if (!openDocument) return
          stopEventPropagation(e)
          openDocument()
        }}
      >
        <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
        {r.type !== 'document_content' && (
          <span
            className="search-result-open"
            onPointerUp={(e) => { e.stopPropagation(); onOpenChatForResult(r) }}
            title="Open in chat"
          >↗</span>
        )}
      </div>
    )
  }

  return (
    <>
      {loading && (
        <div style={{ padding: '12px 10px', opacity: 0.3, textAlign: 'center', fontSize: 10 }}>
          searching…
        </div>
      )}
      {!loading && queryError && (
        <div style={{ padding: '12px 10px', opacity: 0.55, textAlign: 'center', fontSize: 10, color: 'var(--color-accent, #c8956a)' }}>
          {queryError}
        </div>
      )}
      {/* `!queryError` because a failed search has no result count to report.
          Without it the panel prints the error AND "no results" together, which
          still tells the reader the corpus is empty when what is known is only
          that the query did not complete. */}
      {!loading && !queryError && searched && results.length === 0 && (
        <div style={{ padding: '12px 10px', opacity: 0.3, textAlign: 'center', fontSize: 10 }}>
          no results
        </div>
      )}
      {results.length > 0 && (
        <div className="fleet-search-results-summary">
          {results.length} ranked result{results.length !== 1 ? 's' : ''} across {resultGroups.length} type{resultGroups.length !== 1 ? 's' : ''}
        </div>
      )}
      {!loading && !searched && (
        <div style={{ padding: '20px 10px', opacity: 0.4, textAlign: 'center', fontSize: 10 }}>
          type to search fleet history
        </div>
      )}
      {resultGroups.map((group) => {
        const expanded = !!expandedSearchGroups[group.id]
        const visible = expanded ? group.results : group.results.slice(0, SEARCH_GROUP_INITIAL_LIMIT)
        const hidden = group.results.length - visible.length
        return (
          <section key={group.id} className={`fleet-search-result-group fleet-search-result-group-${group.id}`}>
            <div className="fleet-search-section-header">
              <span className="fleet-search-section-label">{group.label}</span>
              <span className="fleet-search-section-count">{group.results.length}</span>
              <span className="fleet-search-section-detail">{group.detail}</span>
            </div>
            {visible.map((r: any, i: number) => renderResult(r, i, group.id))}
            {hidden > 0 && !paging && (
              <button
                type="button"
                className="fleet-search-group-more"
                onPointerDown={(e) => stopEventPropagation(e)}
                onPointerUp={(e) => {
                  stopEventPropagation(e)
                  setExpandedSearchGroups(prev => ({ ...prev, [group.id]: true }))
                }}
              >
                Show {hidden} more {group.label.toLowerCase()}
              </button>
            )}
          </section>
        )
      })}
      {/* One control, and it does the thing it is named after.
          Skip, 2026-08-27: "it says more. you click more and you see 'show ore
          messages' which you click and then get more messages ... like, just
          show 'show more messages' in the first place. why the indirection"
          The indirection was two controls in series: `More` fetched the next
          page, and the page's extra rows landed BEHIND each group's own
          "Show N more" -- so fetching more messages produced another button
          rather than messages. This expands every group and fetches in the same
          click, and it is the only control on the card, so there is nothing left
          to click twice. */}
      {paging && showLoadMore && (
        <button
          type="button"
          className="fleet-search-group-more fleet-search-load-more"
          onPointerDown={(e) => stopEventPropagation(e)}
          onPointerUp={(e) => {
            stopEventPropagation(e)
            setExpandedSearchGroups(prev => {
              const next = { ...prev }
              for (const group of resultGroups) next[group.id] = true
              return next
            })
            if (hasMore) onLoadMore?.()
          }}
        >
          Show more {loadMoreNoun}
        </button>
      )}
    </>
  )
}
