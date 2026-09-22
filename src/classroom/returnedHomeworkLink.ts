import { presentationPath } from '../presentationRoute'
import type { Assignment } from './api'

/** The assignment's real book page, where returned marking ink is rendered. */
export function returnedHomeworkHref(currentHref: string, assignment: Assignment, courseId: string): string | null {
  if (!assignment.solutionsDocKey || !assignment.bookPageFile) return null

  const url = new URL(currentHref)
  const page = assignment.bookPageFile.replace(/^_book\//, '')
  url.pathname = presentationPath('app', assignment.solutionsDocKey, page, 'docs')
  url.searchParams.delete('project')
  url.searchParams.delete('workspace')
  url.searchParams.delete('assignment')
  url.searchParams.delete('student')
  url.searchParams.set('course', courseId)
  url.hash = ''
  return `${url.pathname}${url.search}`
}

/** The same book page, retaining the student the instructor chose to mark. */
export function markingHomeworkHref(currentHref: string, assignment: Assignment, courseId: string, studentId: string): string | null {
  const href = returnedHomeworkHref(currentHref, assignment, courseId)
  if (!href) return null
  const url = new URL(href, currentHref)
  url.searchParams.set('student', studentId)
  return `${url.pathname}${url.search}`
}
