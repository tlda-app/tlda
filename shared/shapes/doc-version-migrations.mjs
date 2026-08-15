export const DOC_VERSION_RETIRED_PROP_MIGRATION_ID = 'com.tldraw.shape.doc-version/1'
export const DOC_VERSION_SOURCE_VERSION_MIGRATION_ID = 'com.tldraw.shape.doc-version/2'

export function stripRetiredDocVersionProps(props) {
  const { buildStatus: _buildStatus, ...currentProps } = props
  return currentProps
}

export function stripRetiredDocVersionSourceVersion(props) {
  const { sourceVersion: _sourceVersion, ...currentProps } = props
  return currentProps
}
