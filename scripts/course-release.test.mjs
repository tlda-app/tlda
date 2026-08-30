import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  deployCourseRelease,
  planCourseRelease,
  readReleaseContract,
  readReleaseManifest,
  rollbackCourseRelease,
  stageCourseRelease,
} from './course-release-core.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-course-release-'))
  const course = join(root, 'course')
  const live = join(root, 'live')
  const output = join(course, 'build')
  mkdirSync(join(course, 'chapters'), { recursive: true })
  mkdirSync(output, { recursive: true })
  mkdirSync(live, { recursive: true })
  writeFileSync(join(course, 'chapters', 'one.qmd'), '---\ntitle: One\n---\n\nHello\n')
  writeFileSync(join(course, 'index.qmd'), '# Syllabus\n')
  writeFileSync(join(output, 'chapter.html'), '<h1>old staging residue</h1>')
  writeFileSync(join(live, 'edge-upstream'), 'old-app\n')
  writeFileSync(join(live, 'book-members.json'), '["old-chapter"]\n')
  for (const name of ['chapter-one', 'handout-one', 'syllabus']) {
    mkdirSync(join(live, name))
    writeFileSync(join(live, name, 'index.html'), `old ${name}`)
  }

  execFileSync('git', ['init'], { cwd: course, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'release@test.invalid'], { cwd: course })
  execFileSync('git', ['config', 'user.name', 'release test'], { cwd: course })
  execFileSync('git', ['add', '--all'], { cwd: course })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: course, stdio: 'ignore' })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: course, encoding: 'utf8' }).trim()

  const contractPath = join(course, 'release.json')
  const contract = {
    version: 1,
    sourceRevision: sha,
    appSha: sha,
    courseRoot: course,
    releaseRoot: join(root, 'release-store'),
    artifacts: [
      {
        id: 'app', kind: 'app', sources: [], desired: 'new-app',
        activation: { type: 'file', path: join(live, 'edge-upstream') },
      },
      {
        id: 'chapter-one', kind: 'chapter', sources: ['chapters/one.qmd'],
        output: 'build/chapter.html', url: 'https://example.test/chapter-one',
        activation: { type: 'directory', path: join(live, 'chapter-one') },
      },
      {
        id: 'handout-one', kind: 'handout-zip', sources: ['chapters/one.qmd'],
        output: 'build/chapter.html', url: 'https://example.test/handout-one.zip',
        activation: { type: 'directory', path: join(live, 'handout-one') },
      },
      {
        id: 'syllabus', kind: 'syllabus-index', sources: ['index.qmd'],
        output: 'build/chapter.html', url: 'https://example.test/syllabus',
        activation: { type: 'directory', path: join(live, 'syllabus') },
      },
      {
        id: 'book', kind: 'full-book-assembly', sources: ['index.qmd', 'chapters'],
        desired: ['chapter-one', 'handout-one'],
        activation: { type: 'json', path: join(live, 'book-members.json') },
      },
    ],
  }
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`)
  return { root, course, live, sha, contractPath }
}

test('plan reports every artifact kind and writes nothing', () => {
  const f = fixture()
  try {
    const before = execFileSync('find', [f.root, '-print'], { encoding: 'utf8' })
    const plan = planCourseRelease(readReleaseContract(f.contractPath))
    const after = execFileSync('find', [f.root, '-print'], { encoding: 'utf8' })
    assert.equal(after, before)
    assert.deepEqual(plan.artifacts.map(item => item.kind), [
      'app', 'chapter', 'handout-zip', 'syllabus-index', 'full-book-assembly',
    ])
    assert.ok(plan.artifacts.every(item => item.changed))
    assert.equal(existsSync(join(f.root, 'release-store')), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('stage writes immutable verified artifacts but leaves live pointers alone', () => {
  const f = fixture()
  try {
    const staged = stageCourseRelease(planCourseRelease(readReleaseContract(f.contractPath)))
    assert.equal(readFileSync(join(f.live, 'edge-upstream'), 'utf8'), 'old-app\n')
    assert.equal(readFileSync(join(f.live, 'syllabus', 'index.html'), 'utf8'), 'old syllabus')
    assert.deepEqual(JSON.parse(readFileSync(join(f.live, 'book-members.json'), 'utf8')), ['old-chapter'])
    assert.equal(readReleaseManifest(staged.manifestPath).manifestHash, staged.manifest.manifestHash)

    const changed = JSON.parse(JSON.stringify(staged.manifest))
    changed.artifacts[1].contentHash = '0'.repeat(64)
    assert.throws(() => deployCourseRelease(changed), /manifest hash does not match/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('deploy consumes staged bytes without running builds, and rollback restores pointers', () => {
  const f = fixture()
  try {
    const staged = stageCourseRelease(planCourseRelease(readReleaseContract(f.contractPath)))
    const deployed = deployCourseRelease(staged.manifest)
    assert.equal(deployed.activated.length, 5)
    assert.equal(readFileSync(join(f.live, 'edge-upstream'), 'utf8'), 'new-app\n')
    assert.deepEqual(JSON.parse(readFileSync(join(f.live, 'book-members.json'), 'utf8')), ['chapter-one', 'handout-one'])
    assert.equal(readFileSync(join(f.live, 'syllabus', 'chapter.html'), 'utf8'), '<h1>old staging residue</h1>')

    rollbackCourseRelease(staged.manifest)
    assert.equal(readFileSync(join(f.live, 'edge-upstream'), 'utf8'), 'old-app\n')
    assert.deepEqual(JSON.parse(readFileSync(join(f.live, 'book-members.json'), 'utf8')), ['old-chapter'])
    assert.equal(readFileSync(join(f.live, 'syllabus', 'index.html'), 'utf8'), 'old syllabus')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('forced mid-activation failure restores every pointer already moved', () => {
  const f = fixture()
  try {
    const staged = stageCourseRelease(planCourseRelease(readReleaseContract(f.contractPath)))
    assert.throws(() => deployCourseRelease(staged.manifest, { failAfter: 3 }), /injected activation failure/)
    assert.equal(readFileSync(join(f.live, 'edge-upstream'), 'utf8'), 'old-app\n')
    assert.equal(readFileSync(join(f.live, 'chapter-one', 'index.html'), 'utf8'), 'old chapter-one')
    assert.equal(readFileSync(join(f.live, 'handout-one', 'index.html'), 'utf8'), 'old handout-one')
    assert.equal(readFileSync(join(f.live, 'syllabus', 'index.html'), 'utf8'), 'old syllabus')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('changed live pointer and changed staged bytes both refuse deployment', () => {
  const f = fixture()
  try {
    const staged = stageCourseRelease(planCourseRelease(readReleaseContract(f.contractPath)))
    writeFileSync(join(f.live, 'edge-upstream'), 'somebody-else\n')
    assert.throws(() => deployCourseRelease(staged.manifest), /pointer changed since stage: app/)
    writeFileSync(join(f.live, 'edge-upstream'), 'old-app\n')
    writeFileSync(join(staged.manifest.artifacts[1].stagedPath, 'tampered'), 'no')
    assert.throws(() => deployCourseRelease(staged.manifest), /staged artifact hash changed: chapter-one/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('an unmet tlda-requires hash makes stage fail before any manifest exists', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.course, 'chapters', 'one.qmd'), '---\ntlda-requires: deadbee\n---\n')
    execFileSync('git', ['add', 'chapters/one.qmd'], { cwd: f.course })
    execFileSync('git', ['commit', '-m', 'require unavailable app'], { cwd: f.course, stdio: 'ignore' })
    const contract = readReleaseContract(f.contractPath)
    contract.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.course, encoding: 'utf8' }).trim()
    const plan = planCourseRelease(contract)
    assert.throws(() => stageCourseRelease(plan), /git merge-base --is-ancestor deadbee/)
    assert.equal(existsSync(join(f.root, 'release-store', 'releases')), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a real staged-artifact check can fail and leaves every live pointer unchanged', () => {
  const f = fixture()
  try {
    const contract = readReleaseContract(f.contractPath)
    contract.artifacts[1].checks = [{ command: 'test', args: ['-s', '{STAGE_DIR}/missing.html'] }]
    const plan = planCourseRelease(contract)
    assert.throws(() => stageCourseRelease(plan), /test -s .*missing\.html failed with exit 1/)
    assert.equal(readFileSync(join(f.live, 'edge-upstream'), 'utf8'), 'old-app\n')
    assert.equal(readFileSync(join(f.live, 'chapter-one', 'index.html'), 'utf8'), 'old chapter-one')
    const releaseId = `${f.sha.slice(0, 12)}-${plan.planHash.slice(0, 12)}`
    assert.equal(existsSync(join(f.root, 'release-store', 'releases', releaseId, 'release.json')), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('plan refuses source bytes that are not the declared Git revision', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.course, 'index.qmd'), '# changed but uncommitted\n')
    assert.throws(
      () => planCourseRelease(readReleaseContract(f.contractPath)),
      /release source differs from sourceRevision/,
    )
    assert.equal(existsSync(join(f.root, 'release-store')), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('components report separately and activate their owning directory once', () => {
  const f = fixture()
  try {
    const contract = readReleaseContract(f.contractPath)
    const owner = contract.artifacts.find(artifact => artifact.id === 'book')
    owner.activation = { type: 'directory', path: join(f.live, 'book-output') }
    owner.desired = ['chapter-one', 'handout-one', 'syllabus']
    mkdirSync(owner.activation.path, { recursive: true })
    writeFileSync(join(owner.activation.path, 'unchanged.txt'), 'keep')
    for (const id of owner.desired) {
      const component = contract.artifacts.find(artifact => artifact.id === id)
      component.owner = 'book'
      delete component.activation
    }
    const plan = planCourseRelease(contract)
    assert.deepEqual(plan.artifacts.filter(artifact => artifact.owner).map(artifact => artifact.id), owner.desired)
    const { manifest } = stageCourseRelease(plan)
    assert.equal(manifest.artifacts.filter(artifact => artifact.activation?.path === owner.activation.path).length, 1)
    const result = deployCourseRelease(manifest)
    assert.deepEqual(result.activated, ['app', 'book'])
    assert.equal(readFileSync(join(owner.activation.path, 'unchanged.txt'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(owner.activation.path, 'chapter.html'), 'utf8'), '<h1>old staging residue</h1>')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('index hashing ignores navigation links but follows embedded assets and includes', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.course, 'asset.svg'), '<svg/>')
    writeFileSync(join(f.course, 'included.qmd'), 'Included text\n')
    writeFileSync(join(f.course, 'index.qmd'), [
      '# Syllabus',
      '[Lecture](chapters/one.qmd)',
      '![](asset.svg)',
      '{{< include included.qmd >}}',
      '',
    ].join('\n'))
    execFileSync('git', ['add', '--all'], { cwd: f.course })
    execFileSync('git', ['commit', '-m', 'index inputs'], { cwd: f.course, stdio: 'ignore' })
    const contract = readReleaseContract(f.contractPath)
    contract.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.course, encoding: 'utf8' }).trim()
    const baseline = planCourseRelease(contract)
    const previousPath = join(f.root, 'previous.json')
    writeFileSync(previousPath, JSON.stringify({ artifacts: baseline.artifacts.map(artifact => ({
      id: artifact.id, sourceHash: artifact.sourceHash, desired: artifact.desired,
    })) }))
    contract.previousManifest = previousPath

    writeFileSync(join(f.course, 'chapters', 'one.qmd'), '# changed linked lecture\n')
    execFileSync('git', ['add', '--all'], { cwd: f.course })
    execFileSync('git', ['commit', '-m', 'linked lecture'], { cwd: f.course, stdio: 'ignore' })
    contract.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.course, encoding: 'utf8' }).trim()
    assert.equal(planCourseRelease(contract).artifacts.find(artifact => artifact.id === 'syllabus').changed, false)

    writeFileSync(join(f.course, 'asset.svg'), '<svg>changed</svg>')
    execFileSync('git', ['add', '--all'], { cwd: f.course })
    execFileSync('git', ['commit', '-m', 'embedded asset'], { cwd: f.course, stdio: 'ignore' })
    contract.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.course, encoding: 'utf8' }).trim()
    assert.equal(planCourseRelease(contract).artifacts.find(artifact => artifact.id === 'syllabus').changed, true)

    writeFileSync(join(f.course, 'asset.svg'), '<svg/>')
    writeFileSync(join(f.course, 'included.qmd'), 'Changed include\n')
    execFileSync('git', ['add', '--all'], { cwd: f.course })
    execFileSync('git', ['commit', '-m', 'included source'], { cwd: f.course, stdio: 'ignore' })
    contract.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.course, encoding: 'utf8' }).trim()
    assert.equal(planCourseRelease(contract).artifacts.find(artifact => artifact.id === 'syllabus').changed, true)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
