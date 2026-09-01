export function documentPanelShowsProject(classroom: boolean): boolean {
  return !classroom
}

export function settingsIdentityEditable(classroom: boolean): boolean {
  return !classroom
}

export function composerMicAppearance(recording: boolean) {
  return {
    slashed: !recording,
    ariaPressed: recording,
    label: recording ? 'Stop dictation' : 'Start dictation',
  }
}
