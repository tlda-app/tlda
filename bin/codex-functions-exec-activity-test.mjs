import assert from 'node:assert/strict'
import { parseCodexRecord } from '../agent-runtime/codex-activity.mjs'
import { extractFunctionsExecCalls } from '../agent-runtime/functions-exec-activity.mjs'
import { createActivityExtractor } from '../agent-runtime/jsonl-event-extract.mjs'
import { normalizeDaemonActivityEvent, shouldStoreDaemonActivity } from '../server/lib/daemon-activity-ingest.mjs'
import { renderActivityGroup } from '../src/fleet/activity-render.mjs'

const ts = '2026-07-22T08:54:27.932Z'

function customExec(input, callId = 'call_outer') {
  return { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input, call_id: callId } }
}

function renderedActivity(record) {
  const parsed = parseCodexRecord(record)
  const activity = createActivityExtractor().extractActivityEvents([parsed])[0]
  return renderActivityGroup([{
    from: 'fleet:codex',
    timestamp: activity.ts,
    _toolName: activity.tool,
    _toolArg: activity.arg,
    _toolInput: activity.input,
  }], {
    agentLabel: () => 'codex',
    getNickClass: () => '',
    getAgents: () => [],
    highlightSyntax: value => value,
    langFromFilePath: () => '',
  })
}

{
  const calls = extractFunctionsExecCalls(`
    const r = await tools.exec_command({cmd:"sed -n '1,220p' SKILL.md",workdir:"/tmp",yield_time_ms:10000});
    text(r.output);
  `)
  assert.deepEqual(calls.map(({ name, input }) => ({ name, input })), [{
    name: 'exec_command',
    input: { cmd: "sed -n '1,220p' SKILL.md", workdir: '/tmp', yield_time_ms: 10000 },
  }])
}

{
  const event = parseCodexRecord(customExec(`
    const r = await tools.exec_command({cmd:"sed -n '1,220p' SKILL.md",workdir:"/tmp"});
    text(r.output);
  `))
  assert.equal(event.blocks.length, 1)
  assert.equal(event.blocks[0].name, 'Bash')
  assert.equal(event.blocks[0].input.command, "sed -n '1,220p' SKILL.md")
  assert.deepEqual(event.blocks[0].input, { command: "sed -n '1,220p' SKILL.md", workdir: '/tmp' })
  assert.doesNotMatch(event.blocks[0].input.command, /const r|tools\./)
  const html = renderedActivity(customExec(`
    const r = await tools.exec_command({cmd:"sed -n '1,220p' SKILL.md",workdir:"/tmp",yield_time_ms:10000,max_output_tokens:12000});
    text(r.output);
  `))
  assert.match(html, /Bash/)
  assert.match(html, /command: sed -n/)
  assert.match(html, /workdir: \/tmp/)
  assert.doesNotMatch(html, /yield_time_ms|max_output_tokens|tools\.exec_command/)
}

{
  const waiting = parseCodexRecord(customExec(`
    const r = await tools.write_stdin({session_id:23502,chars:"",yield_time_ms:30000,max_output_tokens:30000});
    text(r.output);
  `))
  assert.equal(waiting.blocks[0].name, 'BashOutput')
  assert.deepEqual(waiting.blocks[0].input, { session: 23502, action: 'wait for output' })
  const waitingHtml = renderedActivity(customExec(`
    const r = await tools.write_stdin({session_id:23502,chars:"",yield_time_ms:30000,max_output_tokens:30000});
    text(r.output);
  `))
  assert.match(waitingHtml, /BashOutput/)
  assert.match(waitingHtml, /session: 23502, action: wait for output/)
  assert.doesNotMatch(waitingHtml, /yield_time_ms|max_output_tokens|tools\.write_stdin/)

  const interrupting = parseCodexRecord(customExec(`
    const r = await tools.write_stdin({session_id:23502,chars:"\\u0003",yield_time_ms:1000});
    text(r.output);
  `))
  assert.deepEqual(interrupting.blocks[0].input, { session: 23502, action: 'send Ctrl-C' })
}

{
  const waiting = parseCodexRecord(customExec(`
    const r = await tools.wait({cell_id:"46",yield_time_ms:30000,max_tokens:20000});
    text(r.output);
  `))
  assert.equal(waiting.blocks[0].name, 'CodeOutput')
  assert.deepEqual(waiting.blocks[0].input, { cell: '46', action: 'wait for output' })
  const html = renderedActivity(customExec(`
    const r = await tools.wait({cell_id:"46",yield_time_ms:30000,max_tokens:20000});
    text(r.output);
  `))
  assert.match(html, /CodeOutput/)
  assert.match(html, /cell: 46, action: wait for output/)
  assert.doesNotMatch(html, /yield_time_ms|max_tokens|tools\.wait/)
}

{
  const event = parseCodexRecord(customExec(`
    const patch = "*** Begin Patch\\n*** Update File: /work/paper/main.md\\n@@\\n-old\\n+new\\n*** End Patch";
    text(await tools.apply_patch(patch));
  `, 'call_patch'))
  assert.equal(event.blocks.length, 1)
  assert.equal(event.blocks[0].name, 'Edit')
  assert.equal(event.blocks[0].input.file_path, '/work/paper/main.md')
  assert.match(event.blocks[0].input.diff, /\+new/)

  const normalized = normalizeDaemonActivityEvent({
    tool: 'Edit',
    input: event.blocks[0].input,
    project: 'paper',
    sourceFile: 'main.md',
  })
  assert.equal(normalized.metadata.project, 'paper')
  assert.equal(normalized.metadata.sourceFile, 'main.md')
}

{
  const event = parseCodexRecord(customExec(`
    const [a, b, c] = await Promise.all([
      tools.exec_command({cmd:'git status --short',workdir:'/repo'}),
      tools.mcp__tlda__inbox({view:'current-task'}),
      tools.view_image({path:'/tmp/proof.png'})
    ]);
    text(a.output); text(b); image(c.image_url);
  `, 'call_parallel'))
  assert.deepEqual(event.blocks.map(block => block.name), ['Bash', 'Read'])
  assert.equal(event.blocks[0].input.command, 'git status --short')
  assert.equal(event.blocks[1].input.path, '/tmp/proof.png')
  assert.deepEqual(event.blocks.map(block => block.id), ['call_parallel#0', 'call_parallel#1'])
}

{
  // MCP calls are suppressed from the outer envelope and materialized from
  // their authoritative runtime record instead.
  assert.equal(parseCodexRecord(customExec(`
    const r = await tools.mcp__tlda__inbox({view:"current-task"});
    for (const c of (r.content||[])) text(c.text);
  `)), null)

  const record = {
    timestamp: '2026-07-22T08:54:28.704Z',
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'exec-214495b5',
      invocation: { server: 'tlda', tool: 'thread', arguments: { agent: 'chiefdoc', types: ['chat'] } },
      duration: { secs: 0, nanos: 222752542 },
      result: { Ok: { content: [{ type: 'text', text: 'INBOX RESULT' }] } },
    },
  }
  const event = parseCodexRecord(record)
  assert.equal(event.blocks[0].name, 'mcp__tlda__thread')
  assert.deepEqual(event.blocks[0].input, { agent: 'chiefdoc', types: ['chat'] })
  assert.equal(event.blocks[0].id, 'exec-214495b5')
  assert.equal(event.blocks[1].text, 'INBOX RESULT')
  assert.equal(event.blocks[0].status, 'completed')
  assert.deepEqual(event.blocks[0].duration, { secs: 0, nanos: 222752542 })

  const extractor = createActivityExtractor()
  const activity = extractor.extractActivityEvents([event])
  assert.equal(activity.length, 1)
  assert.equal(activity[0].tool, 'tlda/thread')
  assert.deepEqual(activity[0].input, { agent: 'chiefdoc', types: ['chat'] })
  assert.equal(activity[0].prettyResult, 'INBOX RESULT')
  assert.equal(activity[0].status, 'completed')
  assert.equal(activity[0].correlationId, 'exec-214495b5')
  const normalized = normalizeDaemonActivityEvent(activity[0], { serverReceivedAtMs: 1, serverBroadcastQueuedAtMs: 2 })
  assert.equal(normalized.metadata.status, 'completed')
  assert.deepEqual(normalized.metadata.duration, { secs: 0, nanos: 222752542 })
  assert.equal(normalized.metadata.correlationId, 'exec-214495b5')
  assert.equal(Object.hasOwn(normalized.metadata, 'prettyResult'), false)
  assert.equal(shouldStoreDaemonActivity(activity[0]), true)
  assert.equal(shouldStoreDaemonActivity({ tool: '_prettyResult' }), false)
}

{
  const error = parseCodexRecord({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'exec-error',
      invocation: { server: 'tlda', tool: 'chat', arguments: { to: 'fleet:skip', message: 'hi' } },
      result: { Err: 'RPC timeout' },
    },
  })
  assert.equal(error.blocks[1].is_error, true)
  assert.equal(error.blocks[1].text, 'RPC timeout')
  assert.equal(error.blocks[0].status, 'error')
}

{
  const unknown = parseCodexRecord(customExec('const x = calculateSomethingMeaningful(); text(x);'))
  assert.equal(unknown.blocks[0].name, 'Code')
  assert.deepEqual(unknown.blocks[0].input, {
    description: 'run JavaScript',
    code: 'const x = calculateSomethingMeaningful(); text(x);',
  })
  const html = renderedActivity(customExec('const x = calculateSomethingMeaningful(); text(x);'))
  assert.match(html, /<span class="tool-name">Code<\/span>/)
  assert.match(html, /code-block-lang">javascript/)
  assert.match(html, /calculateSomethingMeaningful/)
}

console.log('codex-functions-exec-activity-test: ok')
