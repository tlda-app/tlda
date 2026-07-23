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
  return `⚠ **Possible comma splice** at \`${location}\`: \`${first.snippet}\`. Replace the comma with the connective you mean — for example “where”, “and”, “so”, or “we have”.`
}
