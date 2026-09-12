# Every read of a project's `mainFile`, categorised

By `reliability-pm`, against `main`. Complete, not a sample: `git grep -n '\.mainFile'` over server/ src/ shared/ cli/ bin/ daemon/, tests excluded.

**72 property reads across 23 files.** The other ~170 hits are locals and parameters named `mainFile` that follow from these.

## 1. derives a single texBase from it  (ACTIVELY WRONG on a multi-root project) — 17

```
server/lib/build-runner.mjs:2165:  ctx.texBase = basename(ctx.mainFile, '.tex')
server/lib/build-runner.mjs:2322:          targets: targetMeta.map(t => ({ texBase: t.texBase, mainFile: t.mainFile, pages: t.expectedPages })),
server/lib/build-runner.mjs:2344:      targets: targetMeta.map(t => ({ texBase: t.texBase, mainFile: t.mainFile, pages: t.expectedPages })),
server/lib/ensure.mjs:302:  const mainFile = project?.mainFile && basename(project.mainFile, '.tex') === texBase
server/lib/ensure.mjs:402:  const mainFile = project?.mainFile && basename(project.mainFile, '.tex') === texBase
server/lib/shadow-changelog.mjs:29:  const primaryTexBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
server/lib/shadow-repo.mjs:942:    texBase = basename(project?.mainFile || 'main.tex', '.tex')
server/lib/synctex-query.mjs:266:  const texBase = target || (project?.mainFile || 'main.tex').replace(/\.tex$/i, '').split('/').pop()
server/lib/synctex-query.mjs:392:  const texBase = opts.texBase || (project?.mainFile || 'main.tex').replace(/\.tex$/i, '').split('/').pop()
server/routes/history.mjs:295:  const texBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
server/routes/history.mjs:566:  const primaryTexBase = (project?.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
server/routes/projects.mjs:961:  const texBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
server/unified-server.mjs:4828:      : [{ texBase: basename(project?.mainFile || 'main.tex', '.tex'), pages: project?.pages || 0 }]
server/unified-server.mjs:4892:          const texBase = /\.tex$/i.test(project.mainFile || '')
server/unified-server.mjs:4893:            ? basename(project.mainFile, '.tex')
shared/doc-assets.mjs:33:    return (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
shared/doc-assets.mjs:80:    base = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
```

## 2. uses it as a silent default — 12

```
server/lib/build-markdown.mjs:852:  const mainFile = project.mainFile || 'index.md'
server/lib/build-runner.mjs:2124:  const primary = project.mainFile || 'main.tex'
server/lib/document-columns.mjs:38:  const configuredFile = String(project.mainFile || 'index.md').replace(/\\/g, '/').replace(/^\.?\//, '')
server/lib/document-columns.mjs:105:  const configuredFile = String(project.mainFile || 'index.md').replace(/\\/g, '/').replace(/^\.?\//, '')
server/lib/shadow-changelog.mjs:38:      const mainFile = lookup.meta?.texFile || project.mainFile || 'main.tex'
server/lib/shadow-repo.mjs:384:    const mainFile = project.mainFile || 'index.md'
server/lib/shadow-repo.mjs:861:  const mainFile = project?.mainFile || 'main.tex'
server/routes/history.mjs:516:    : (project.mainFile || 'main.tex')
server/routes/history.mjs:713:  const mainFile = project.mainFile || 'main.tex'
server/routes/projects.mjs:993:  const file = String(req.query.file || project.mainFile || 'main.tex')
server/unified-server.mjs:4928:            mainFile: project.mainFile || 'index.md',
src/shapes/FleetSourceEditorShape.tsx:812:        const nextFile = normalizeFile(info?.mainFile || 'main.tex')
```

## 3. compares another path against it — 7

```
cli/lib/source-files.mjs:96:  if (resolvedContext.format !== 'markdown' || !resolvedContext.mainFile) {
server/routes/history.mjs:789:  const anchorFile = !file || file === project.mainFile ? null : file
server/routes/projects.mjs:739:    if (!documentRoots.some(root => root.path === project.mainFile)) {
server/unified-server.mjs:4901:          } else if (project.mainFile && project.mainFile !== column.sourceFile) {
shared/source-manifest.mjs:150:  if (rel === ctx.mainFile) return true
shared/source-manifest.mjs:168:  if (ctx.format === 'qmd') return !isQuartoRenderOutput(rel, ctx.mainFile)
shared/source-manifest.mjs:186:  if (ctx.format === 'qmd' && isQuartoRenderOutput(rel, ctx.mainFile)) return false
```

## 4. other / passes it along — 36

```
cli/lib/fly/router.mjs:88:    '--main', plan.mainFile,
cli/lib/fly/router.mjs:415:  console.log(`Main file:     ${plan.mainFile}`)
cli/lib/fly/router.mjs:442:    ['tlda', ['project', 'link', plan.project, plan.overleafUrl, '--main', plan.mainFile, '--server', plan.renderUrl, '--token', plan.overleafToken, '--title', plan.title, '--poll', plan.poll], { TLDA_TOKEN: plan.rwToken }, docLinkDisplayLine(plan)],
cli/lib/fly/router.mjs:509:  run(process.execPath, [TLDA_CLI, 'project', 'link', plan.project, plan.overleafUrl, '--main', plan.mainFile, '--server', plan.renderUrl, '--token', plan.overleafToken, '--title', plan.title, '--poll', plan.poll], {
cli/lib/source-files.mjs:102:    ...scanMarkdownDependencyClosure(resolvedContext.mainFile, dir).files,
cli/tlda.mjs:2974:      mainFile: project.mainFile,
cli/tlda.mjs:5693:        if (p.sourceDir && p.mainFile) {
cli/tlda.mjs:5694:          const mainPath = join(p.sourceDir, p.mainFile)
cli/tlda.mjs:5696:            projectIssues.push({ p, kind: 'main-missing', detail: p.mainFile })
daemon/git-sync-manager.mjs:132:      onRemoteSettled: () => cluster.note(path.join(item.sourceDir, item.mainFile || '.')),
daemon/git-sync-manager.mjs:197:        await start({ ...item, mainFile: project.mainFile || null })
server/lib/build-decision.mjs:29:  const declared = String(project?.mainFile || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')
server/lib/build-qmd.mjs:247:  const mainFile = String(project?.mainFile || 'index.qmd').replace(/\\/g, '/').replace(/^\.?\/+/, '')
server/lib/build-runner.mjs:1251:  const mainFile = project?.mainFile || ''
server/lib/build-runner.mjs:1756:  if (mainFiles.length <= 1) return { ordered: [...mainFiles], hasCycle: false, hasXrDeps: false }
server/lib/build-runner.mjs:2164:  ctx.mainFile = mainFiles[0]
server/lib/build-runner.mjs:2166:  ctx.texPath = join(srcDir, ctx.mainFile)
server/lib/build-runner.mjs:2167:  ctx.texDir = join(srcDir, dirname(ctx.mainFile))
server/lib/build-runner.mjs:2303:    targetMeta.sort((a, b) => mainFiles.indexOf(a.mainFile) - mainFiles.indexOf(b.mainFile))
server/lib/ensure.mjs:303:    ? project.mainFile
server/lib/ensure.mjs:403:    ? project.mainFile
server/lib/project-artifact-materializer.mjs:356:    mainFile: project?.mainFile,
server/lib/project-store.mjs:791:  const mainFile = project.mainFile || null
server/lib/shadow-repo.mjs:925: * It used to be re-derived here from `project.mainFile` instead, which threw
server/lib/source-room-daemon.mjs:148:    gitSync.bindSource(project, join(paths.root, 'working'), { mainFile: projectRecord?.mainFile || null, appOwnedWorkingTree: true })
server/lib/source-room-daemon.mjs:485:    gitSync.bindSource(project, root, { mainFile: projectRecord.mainFile || null, appOwnedWorkingTree: true })
server/lib/synctex-query.mjs:57:  const mainFileDir = proj?.mainFile ? dirname(proj.mainFile) : '.'
server/routes/classroom.mjs:110:  if (!project?.mainFile) return null
server/routes/classroom.mjs:113:    return await readFile(join(checkout, project.mainFile), 'utf8')
server/routes/projects.mjs:432:    mainFile: project.mainFile,
server/routes/projects.mjs:735:      mainFile: project.mainFile,
server/routes/projects.mjs:756:    mainFile: project.mainFile,
server/routes/projects.mjs:1625:  const file = req.body.file || project.mainFile || project.main
server/routes/projects.mjs:1675:    const mainFile = file || project.mainFile || project.main
server/unified-server.mjs:4913:            const mainPath = join(PROJECTS_DIR, name, 'source', project.mainFile)
shared/source-manifest.mjs:141:    mainFile: normalizePath(project?.mainFile || ''),
```

