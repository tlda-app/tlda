import { useEffect } from 'react'
import { classroomApi } from './api'
import { readClassroomToken } from './classroomToken'

const GLOBAL_MANIFEST = '/manifest.webmanifest'

export function useClassroomManifest() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const project = params.get('project')
    const readToken = params.get('token')
    if (!project || !readToken || !readClassroomToken()) return

    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    if (!link) return
    let active = true

    void classroomApi.me().then(identity => {
      if (!active || identity.role !== 'student') return
      const manifest = new URL(`/api/classroom/courses/${encodeURIComponent(identity.courseId)}/manifest.webmanifest`, window.location.origin)
      manifest.searchParams.set('project', project)
      manifest.searchParams.set('token', readToken)
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
