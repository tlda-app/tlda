export const DOC_VERSION_RETIRED_PROP_MIGRATION_ID = 'com.tldraw.shape.doc-version/1'

export function stripRetiredDocVersionProps(props) {
  const { buildStatus: _buildStatus, ...currentProps } = props
  return currentProps
}
