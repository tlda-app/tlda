import { useEffect } from 'react'
import { classroomApi } from './api'
import { readClassroomToken } from './classroomToken'

const GLOBAL_MANIFEST = '/manifest.webmanifest'

export function useClassroomManifest() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!shouldLoadClassroomManifest(params, Boolean(readClassroomToken()))) return
    const project = params.get('project')!

    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    if (!link) return
    let active = true

    // The manifest names a course and a project — neither is student
    // information — so it is fetched open, with no token of any kind. The
    // per-person classroom token rides its own header path for identity, and
    // never appears in a URL.
    void classroomApi.me().then(identity => {
      if (!active || identity.role !== 'student') return
      const manifest = new URL(`/api/classroom/courses/${encodeURIComponent(identity.courseId)}/manifest.webmanifest`, window.location.origin)
      manifest.searchParams.set('project', project)
      link.href = manifest.toString()
    }).catch(() => {
      // A non-student or stale classroom credential keeps the ordinary tlda manifest.
    })

    return () => {
      active = false
      link.setAttribute('href', GLOBAL_MANIFEST)
    }
  }, [])
}

export function shouldLoadClassroomManifest(params: URLSearchParams, hasClassroomToken: boolean) {
  return Boolean(
    params.get('project')
    && hasClassroomToken
    && !params.get('markingCourse')
  )
}
