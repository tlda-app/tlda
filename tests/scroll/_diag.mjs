/** One-shot diagnostic: why doesn't the chat HUD render? Dumps identity,
 *  all fleet shapes + their userId, HUD state, and console errors. */
import { setup, teardown, pw, pwEval, delay } from '../harness.mjs'

const ctx = await setup({})
try {
  console.log('\n=== ctx ===')
  console.log('  userId(guess):', ctx.userId)
  console.log('  humanName:', ctx.humanName, ' sanitized:', ctx.humanSanitized)

  const dump = pwEval(ctx.sessionName, `(function(){
    var e=window.__tldraw_editor__;
    var out={ identity: null, shapes: [], hasChatLog: false, hudExpanded: null, err: null };
    try{ out.identity = localStorage.getItem("tlda-identity"); }catch(e){}
    try{ out.hudExpanded = localStorage.getItem("fleet-hud-expanded"); }catch(e){}
    try{ out.hasChatLog = !!document.querySelector(".fleet-chat-log"); }catch(e){}
    try{
      if(e){
        var ss=e.getCurrentPageShapes();
        out.shapes = ss.filter(function(s){return /fleet|anchor/.test(s.type)||/fleet|anchor/.test(s.id)}).map(function(s){return {type:s.type,id:s.id,userId:(s.props&&s.props.userId)}});
      } else { out.err="no editor"; }
    }catch(err){ out.err=String(err); }
    return JSON.stringify(out);
  })()`)
  console.log('\n=== page dump ===')
  console.log(dump.replace(/\\"/g,'"').replace(/\\\\/g,'\\'))

  const consoleErr = pw(ctx.sessionName, 'console error')
  console.log('\n=== console errors ===')
  console.log((consoleErr || '(none)').slice(0, 1500))

  pw(ctx.sessionName, `screenshot --filename scratch/diag.png`)
  await delay(200)
} finally {
  await teardown(ctx)
}
