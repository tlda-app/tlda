import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function lineContentSpan(buffer, startLine, endLine, label) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error(`${label} range must be positive, inclusive line numbers with start <= end.`);
  }

  const starts = [0];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) starts.push(index + 1);
  }
  if (startLine > starts.length || endLine > starts.length) {
    throw new Error(`${label} range ${startLine}-${endLine} is outside the file's ${starts.length} lines.`);
  }

  const start = starts[startLine - 1];
  const nextLineStart = endLine < starts.length ? starts[endLine] : buffer.length;
  let end = nextLineStart;
  if (end > start && buffer[end - 1] === 0x0a) end -= 1;
  if (end > start && buffer[end - 1] === 0x0d) end -= 1;
  return { start, end };
}

function resolveFromCwd(file, cwd, label) {
  if (typeof file !== 'string' || file.trim() === '') throw new Error(`${label} is required.`);
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
}

export function transferRegion({
  sourceFile,
  sourceStartLine,
  sourceEndLine,
  targetFile,
  targetStartLine,
  targetEndLine,
  expected,
}, {
  cwd = process.cwd(),
  fsImpl = fs,
  beforeRename = null,
} = {}) {
  if (typeof expected !== 'string') throw new Error('expected must be an exact string.');

  const sourcePath = resolveFromCwd(sourceFile, cwd, 'source_file');
  const targetPath = resolveFromCwd(targetFile, cwd, 'target_file');
  if (!['.md', '.markdown'].includes(path.extname(sourcePath).toLowerCase())) {
    throw new Error('source_file must be a Markdown file ending in .md or .markdown.');
  }

  const source = fsImpl.readFileSync(sourcePath);
  const target = fsImpl.readFileSync(targetPath);
  const sourceSpan = lineContentSpan(source, sourceStartLine, sourceEndLine, 'source');
  const targetSpan = lineContentSpan(target, targetStartLine, targetEndLine, 'target');
  const current = target.subarray(targetSpan.start, targetSpan.end);
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (!current.equals(expectedBytes)) {
    throw new Error(`target range does not match expected (${current.length} bytes found, ${expectedBytes.length} expected).`);
  }

  const replacement = source.subarray(sourceSpan.start, sourceSpan.end);
  const output = Buffer.concat([
    target.subarray(0, targetSpan.start),
    replacement,
    target.subarray(targetSpan.end),
  ]);
  const targetStat = fsImpl.statSync(targetPath);
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.region-transfer-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );

  let fd = null;
  try {
    fd = fsImpl.openSync(tempPath, 'wx', targetStat.mode & 0o777);
    fsImpl.writeFileSync(fd, output);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    if (beforeRename) beforeRename({ tempPath, targetPath });
    fsImpl.renameSync(tempPath, targetPath);
  } catch (error) {
    const cleanupErrors = [];
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch (closeError) { cleanupErrors.push(closeError); }
    }
    try { fsImpl.unlinkSync(tempPath); } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') cleanupErrors.push(unlinkError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `${error.message}; temporary-file cleanup also failed.`);
    }
    throw error;
  }

  return {
    sourcePath,
    targetPath,
    sourceBytes: replacement.length,
    replacedBytes: current.length,
  };
}
