export async function lintSourceEditFiles(files, lint) {
  const findings = []
  for (const file of files) {
    if (!file?.path?.endsWith('.tex') || !Array.isArray(file.regions)) continue
    for (const region of file.regions) {
      if (typeof region?.content !== 'string' || !Number.isInteger(region.startLine)) continue
      const regionFindings = await lint(region.content, file.path)
      findings.push(...regionFindings.map(finding => ({
        ...finding,
        line: finding.line + region.startLine - 1,
      })))
    }
  }
  return findings
}

export function sourceEditNudgeText(project, findings) {
  const first = findings[0]
  const location = `${project}/${first.file}:${first.line}`
  const choices = GRAMMAR_REPAIR_CHOICES.map((choice, index) =>
    `${index === GRAMMAR_REPAIR_CHOICES.length - 1 ? 'or ' : ''}“${choice}”`,
  ).join(', ')
  return `⚠ **Possible comma splice** at \`${location}\`: \`${first.snippet}\`. Replace the comma with the connective you mean — for example ${choices}.`
}
export const GRAMMAR_REPAIR_CHOICES = ['where', 'and', 'so', 'we have']

export function ordinaryChatNudgeText(findings) {
  const n = findings.length
  const choices = GRAMMAR_REPAIR_CHOICES.map(choice => `"${choice}"`).join(', ')
  return `⚠ **Possible comma splice** in your math${n > 1 ? ` (${n} spots)` : ''}: a comma is joining two statements as if it were a word. Which word did you mean — ${choices}? Write it out; a comma isn't a connective. You can fix it in place by **amending** the message (\`chat({ amend_id })\`), no need to repost.`
}
